package agent

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
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

// writeFile writes the secret or config at path from the run's values (ADR-0012): a secret only
// on a tmpfs, every file atomically, with its owner and mode.
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
	if !ok {
		// a rollback to a value the CLI no longer has, after a reboot emptied the tmpfs
		return errs.Plan(kind+".missing", "the %s %s of this release is gone from the server, and this run does not have its value", kind, f.Name).
			WithHint("deploy the current version: the CLI sends the values it has")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errs.Internal("create %s: %v", dir, err)
	}
	if f.Secret {
		if ok, err := onTmpfs(dir); err != nil {
			return errs.Internal("check %s: %v", dir, err)
		} else if !ok {
			return errs.Newf("secret.not_tmpfs", errs.ExitPlan, "%s is not on a tmpfs: secrets are never written to disk", domain.SecretsRoot).
				WithHint("mount a tmpfs on /run/dockflow (systemd mounts one on /run)")
		}
	}
	tmp := path + ".tmp-" + r.req.Run
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return errs.Internal("write the %s %s: %v", kind, f.Name, err)
	}
	err := os.Chown(tmp, f.UID, f.GID)
	if err == nil {
		err = os.Chmod(tmp, os.FileMode(f.Mode))
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
		return errs.Internal("write the %s %s: %v", kind, f.Name, err)
	}
	return nil
}

// pruneFiles deletes the app's secret and config files that no kept release uses.
func (r *runner) pruneFiles(kept []*domain.Release) {
	used := map[string]bool{}
	for _, rel := range kept {
		for _, f := range rel.Desired.Files {
			used[f.Path] = true
		}
	}
	for _, dir := range []string{filepath.Join(domain.SecretsRoot, r.stack), filepath.Join(r.app.Dir(), "configs")} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			p := filepath.Join(dir, e.Name())
			if used[p] || strings.Contains(e.Name(), ".tmp-") {
				continue
			}
			if err := os.Remove(p); err != nil {
				r.warn("cleanup.failed", "cannot remove "+p+": "+err.Error())
			}
		}
	}
}

// removeFiles deletes every secret and config file of the app (destroy).
func (r *runner) removeFiles() {
	os.RemoveAll(filepath.Join(domain.SecretsRoot, r.stack))
}
