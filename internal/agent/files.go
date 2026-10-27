package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
)

// existingFiles reports which of the app's secret and config files are on the server.
func existingFiles(a *domain.App) map[string]bool {
	out := map[string]bool{}
	for _, f := range a.Files {
		if _, err := os.Stat(f.Path); err == nil {
			out[f.Path] = true
		}
	}
	return out
}

// SecretCopy is where the copy of a Compose secret file is kept, in the app's state directory,
// root only: the watchdog writes the tmpfs again from it after a reboot (ADR-0012).
func SecretCopy(appDir, path string) string {
	return filepath.Join(appDir, "secrets", filepath.Base(path))
}

// writeFile writes the secret or config at path from the run's values, or for a secret, from its
// copy (ADR-0012): a secret on a tmpfs, with a copy in the state directory, every file
// atomically, with its owner and mode.
func (r *runner) writeFile(a *domain.App, path string) error {
	var f *domain.File
	for i := range a.Files {
		if a.Files[i].Path == path {
			f = &a.Files[i]
		}
	}
	if f == nil {
		return errs.Internal("no file %s in the app", path)
	}
	kind := "config"
	if f.Secret {
		kind = "secret"
	}
	content, ok := r.req.Files[path]
	if !ok && f.Secret {
		if b, err := os.ReadFile(SecretCopy(r.app.Dir(), path)); err == nil {
			content, ok = string(b), true
		}
	}
	if !ok {
		// a rollback to a value the CLI no longer has, after a reboot emptied the tmpfs
		return errs.Plan(kind+".missing", "the %s %s of this release is gone from the server, and this run does not have its value", kind, f.Name).
			WithHint("deploy the current version: the CLI sends the values it has")
	}
	if f.Secret {
		if err := writeAtomic(SecretCopy(r.app.Dir(), path), content, 0, 0, 0o600, r.req.Run); err != nil {
			return errs.Internal("keep a copy of the secret %s: %v", f.Name, err)
		}
	}
	if err := WriteSecretFile(*f, content, r.req.Run); err != nil {
		return err
	}
	return nil
}

// WriteSecretFile writes a secret or config file where its release mounts it: a secret only on a
// tmpfs.
func WriteSecretFile(f domain.File, content, run string) error {
	kind := "config"
	if f.Secret {
		kind = "secret"
	}
	dir := filepath.Dir(f.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errs.Internal("create %s: %v", dir, err)
	}
	if f.Secret {
		if ok, err := onTmpfs(dir); err != nil {
			return errs.Internal("check %s: %v", dir, err)
		} else if !ok {
			return errs.Newf("secret.not_tmpfs", errs.ExitPlan, "%s is not on a tmpfs: Compose secrets are mounted from memory", domain.SecretsRoot).
				WithHint("mount a tmpfs on /run/dockflow (systemd mounts one on /run)")
		}
	}
	if err := writeAtomic(f.Path, content, f.UID, f.GID, os.FileMode(f.Mode), run); err != nil {
		return errs.Internal("write the %s %s: %v", kind, f.Name, err)
	}
	return nil
}

// writeAtomic writes content to path through a temporary file, with its owner and mode.
func writeAtomic(path, content string, uid, gid int, mode os.FileMode, run string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp-" + run
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	err := os.Chown(tmp, uid, gid)
	if err == nil {
		err = os.Chmod(tmp, mode)
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// keepCopies copies the app's secret files that have no copy yet, as those a version of Dockflow
// without copies wrote.
func (r *runner) keepCopies(a *domain.App) {
	for _, f := range a.Files {
		if !f.Secret {
			continue
		}
		dst := SecretCopy(r.app.Dir(), f.Path)
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		b, err := os.ReadFile(f.Path)
		if err != nil {
			continue
		}
		if err := writeAtomic(dst, string(b), 0, 0, 0o600, r.req.Run); err != nil {
			r.warn("secret.copy", "cannot keep a copy of the secret "+f.Name+": "+err.Error())
		}
	}
}

// pruneFiles deletes the app's secret and config files that no kept release uses.
func (r *runner) pruneFiles(kept []*domain.Release) {
	used := map[string]bool{}
	for _, rel := range kept {
		for _, f := range rel.Desired.Files {
			used[f.Path] = true
		}
	}
	copies := filepath.Dir(SecretCopy(r.app.Dir(), "x"))
	for _, dir := range []string{filepath.Join(domain.SecretsRoot, r.stack), filepath.Join(r.app.Dir(), "configs"), copies} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			p := filepath.Join(dir, e.Name())
			if dir == copies {
				// a copy goes with the file it copies
				p = filepath.Join(domain.SecretsRoot, r.stack, e.Name())
			}
			if used[p] || strings.Contains(e.Name(), ".tmp-") {
				continue
			}
			if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
				r.warn("cleanup.failed", "cannot remove "+filepath.Join(dir, e.Name())+": "+err.Error())
			}
		}
	}
}

// removeFiles deletes every secret and config file of the app (destroy).
func (r *runner) removeFiles() {
	os.RemoveAll(filepath.Join(domain.SecretsRoot, r.stack))
	os.RemoveAll(filepath.Dir(SecretCopy(r.app.Dir(), "x")))
}

// revoke removes the files of a secret that the current release does not use, at once: the old
// values of a leaked secret leave the server, and the releases that used them can no longer be
// rolled back to without their value (ADR-0012).
func (r *runner) revoke(ctx context.Context) events.RunFinishedData {
	l, err := r.lock(ctx)
	if err != nil {
		return failed(err)
	}
	defer r.unlock(l)
	keep := map[string]bool{}
	if env, err := r.app.Env(); err == nil && env != nil && env.Current != 0 {
		cur, err := r.currentRelease()
		if err != nil {
			return failed(err)
		}
		for _, f := range cur.Desired.Files {
			keep[f.Path] = true
		}
	}
	dir := filepath.Join(domain.SecretsRoot, r.stack)
	// the files on the tmpfs, and their copies, which a reboot leaves alone
	names := map[string]bool{}
	for _, d := range []string{dir, filepath.Dir(SecretCopy(r.app.Dir(), "x"))} {
		entries, _ := os.ReadDir(d)
		for _, e := range entries {
			names[e.Name()] = true
		}
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	removed := []string{}
	for _, name := range sorted {
		p := filepath.Join(dir, name)
		if keep[p] || !strings.HasPrefix(name, r.req.Name+"-") || len(name) != len(r.req.Name)+13 {
			continue
		}
		for _, f := range []string{p, SecretCopy(r.app.Dir(), p)} {
			if err := os.Remove(f); err != nil && !os.IsNotExist(err) {
				return failed(errs.Internal("remove %s: %v", f, err))
			}
		}
		removed = append(removed, name)
	}
	r.ev.Info(events.Log, fmt.Sprintf("%d old files of the secret %s removed", len(removed), r.req.Name), map[string]any{"line": "revoke " + r.req.Name})
	r.result(map[string]any{"secret": r.req.Name, "removed": removed})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}
