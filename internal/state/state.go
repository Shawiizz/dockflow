// Package state reads and writes Dockflow's files on a server (docs/design/spec/state-v1.md).
// Only the agent uses it, inside its container, on /var/lib/dockflow.
package state

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Root is where the state lives on a server.
const Root = "/var/lib/dockflow"

// Schema is the version of the state format.
const Schema = 1

// Store is the state of one server.
type Store struct {
	root string
	// run names temporary files.
	run string
}

// Open returns the store rooted at root, creating it when needed.
func Open(root, run string) (*Store, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, ioErr("create "+root, err)
	}
	// Docker creates a missing bind source 0755: the state is root's only (state-v1.md)
	if err := os.Chmod(root, 0o700); err != nil {
		return nil, ioErr("protect "+root, err)
	}
	return &Store{root: root, run: run}, nil
}

// Root is the directory of the store.
func (s *Store) Root() string { return s.root }

// App is the state of one app environment.
type App struct {
	s   *Store
	dir string
}

// App returns the state of stack, creating its directory when needed.
func (s *Store) App(stack string) (*App, error) {
	if stack == "" || strings.ContainsAny(stack, "/.\\") {
		return nil, errs.Internal("invalid stack %q", stack)
	}
	dir := filepath.Join(s.root, "apps", stack)
	if err := os.MkdirAll(filepath.Join(dir, "releases"), 0o700); err != nil {
		return nil, ioErr("create "+dir, err)
	}
	return &App{s: s, dir: dir}, nil
}

// Dir is the directory of the app environment's state.
func (a *App) Dir() string { return a.dir }

// Delete removes the state of the app environment: its releases, locks and records. The held
// lock file goes with it; the run holding it ends right after.
func (a *App) Delete() error {
	entries, err := os.ReadDir(a.dir)
	if err != nil {
		return ioErr("read "+a.dir, err)
	}
	for _, e := range entries {
		if e.Name() == "lock" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(a.dir, e.Name())); err != nil {
			return ioErr("delete "+e.Name(), err)
		}
	}
	return nil
}

// Stacks lists the app environments that have state on this server.
func (s *Store) Stacks() ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "apps"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, ioErr("list apps", err)
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

// Server is server.json.
type Server struct {
	Schema      int    `json:"schema"`
	Name        string `json:"name"`
	Edge        string `json:"edge"`
	SwitchImage string `json:"switch_image,omitempty"`
	// SwitchListen and TrustedProxies configure the external edge.
	SwitchListen    string   `json:"switch_listen,omitempty"`
	TrustedProxies  []string `json:"trusted_proxies,omitempty"`
	RegistryImage   string   `json:"registry_image,omitempty"`
	DockflowVersion string   `json:"dockflow_version"`
	// Filter tells whether the published-port filter is on (ADR-0014); SSHPort is let in, and
	// FilterRules is the digest of the rules last applied.
	Filter      bool   `json:"filter,omitempty"`
	SSHPort     int    `json:"ssh_port,omitempty"`
	FilterRules string `json:"filter_rules,omitempty"`
}

// Server reads server.json; nil when the server was never initialised.
func (s *Store) Server() (*Server, error) {
	var v Server
	ok, err := s.readJSON(filepath.Join(s.root, "server.json"), &v)
	if !ok || err != nil {
		return nil, err
	}
	return &v, nil
}

// WriteServer writes server.json.
func (s *Store) WriteServer(v Server) error {
	v.Schema = Schema
	return s.writeJSON(filepath.Join(s.root, "server.json"), v, false)
}

// Env reads env.json; nil when the app was never deployed.
func (a *App) Env() (*domain.EnvRecord, error) {
	var v domain.EnvRecord
	ok, err := a.s.readJSON(filepath.Join(a.dir, "env.json"), &v)
	if !ok || err != nil {
		return nil, err
	}
	return &v, nil
}

// WriteEnv writes env.json.
func (a *App) WriteEnv(v domain.EnvRecord) error {
	v.Schema = Schema
	return a.s.writeJSON(filepath.Join(a.dir, "env.json"), v, false)
}

func (a *App) releasePath(seq int) string {
	return filepath.Join(a.dir, "releases", fmt.Sprintf("%06d.json.gz", seq))
}

// Release reads one release record; nil when it does not exist.
func (a *App) Release(seq int) (*domain.Release, error) {
	var v domain.Release
	ok, err := a.s.readJSON(a.releasePath(seq), &v)
	if !ok || err != nil {
		return nil, err
	}
	return &v, nil
}

// WriteRelease writes a release record.
func (a *App) WriteRelease(r *domain.Release) error {
	r.Schema = Schema
	return a.s.writeJSON(a.releasePath(r.Seq), r, true)
}

// Releases lists the sequence numbers of the stored releases, oldest first.
func (a *App) Releases() ([]int, error) {
	entries, err := os.ReadDir(filepath.Join(a.dir, "releases"))
	if err != nil {
		return nil, ioErr("list releases", err)
	}
	var out []int
	for _, e := range entries {
		n, ok := strings.CutSuffix(e.Name(), ".json.gz")
		if !ok {
			continue
		}
		if seq, err := strconv.Atoi(n); err == nil {
			out = append(out, seq)
		}
	}
	sort.Ints(out)
	return out, nil
}

// Prune applies the retention rule: it keeps the newest keep releases that are active or
// superseded and every release newer than the oldest of those, and deletes the others. It
// returns the kept and the deleted releases.
func (a *App) Prune(keep int) (kept, deleted []*domain.Release, err error) {
	seqs, err := a.Releases()
	if err != nil {
		return nil, nil, err
	}
	all := make([]*domain.Release, 0, len(seqs))
	for _, seq := range seqs {
		r, err := a.Release(seq)
		if err != nil {
			return nil, nil, err
		}
		if r != nil {
			all = append(all, r)
		}
	}
	oldest := -1
	n := 0
	for i := len(all) - 1; i >= 0 && n < keep; i-- {
		if st := all[i].Status; st == domain.StatusActive || st == domain.StatusSuperseded {
			oldest = all[i].Seq
			n++
		}
	}
	if oldest < 0 {
		return all, nil, nil
	}
	for _, r := range all {
		if r.Seq >= oldest {
			kept = append(kept, r)
			continue
		}
		if err := os.Remove(a.releasePath(r.Seq)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, nil, ioErr("delete release", err)
		}
		deleted = append(deleted, r)
	}
	return kept, deleted, nil
}

// ManualLock reads manual-lock.json; nil when there is no manual lock.
func (a *App) ManualLock() (*domain.LockInfo, error) {
	var v domain.LockInfo
	ok, err := a.s.readJSON(filepath.Join(a.dir, "manual-lock.json"), &v)
	if !ok || err != nil {
		return nil, err
	}
	return &v, nil
}

// SetManualLock writes manual-lock.json.
func (a *App) SetManualLock(v domain.LockInfo) error {
	v.Schema = Schema
	return a.s.writeJSON(filepath.Join(a.dir, "manual-lock.json"), v, false)
}

// ClearManualLock removes manual-lock.json.
func (a *App) ClearManualLock() error {
	err := os.Remove(filepath.Join(a.dir, "manual-lock.json"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return ioErr("remove the manual lock", err)
	}
	return nil
}

// Holder reads lock.json, which tells who holds or last held the lock.
func (a *App) Holder() (*domain.LockInfo, error) {
	var v domain.LockInfo
	ok, err := a.s.readJSON(filepath.Join(a.dir, "lock.json"), &v)
	if !ok || err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *Store) readJSON(path string, v any) (bool, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, ioErr("read "+path, err)
	}
	if strings.HasSuffix(path, ".gz") {
		zr, err := gzip.NewReader(bytes.NewReader(b))
		if err != nil {
			return false, corrupt(path, err)
		}
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(zr); err != nil {
			return false, corrupt(path, err)
		}
		b = buf.Bytes()
	}
	var head struct {
		Schema int `json:"schema"`
	}
	if err := json.Unmarshal(b, &head); err != nil {
		return false, corrupt(path, err)
	}
	if head.Schema != Schema {
		return false, errs.Newf("state.schema", errs.ExitInternal, "%s has schema %d; this Dockflow reads schema %d", path, head.Schema, Schema).
			WithHint("upgrade Dockflow")
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false, corrupt(path, err)
	}
	return true, nil
}

// writeJSON writes v atomically: to a temporary file, synced, then renamed.
func (s *Store) writeJSON(path string, v any, gz bool) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return errs.Internal("encode %s: %v", path, err)
	}
	if gz {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		zw.Write(b)
		zw.Close()
		b = buf.Bytes()
	}
	tmp := path + ".tmp-" + s.run
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return ioErr("write "+path, err)
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return ioErr("write "+path, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return ioErr("sync "+path, err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return ioErr("write "+path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return ioErr("rename "+path, err)
	}
	return nil
}

func ioErr(what string, err error) error {
	return errs.New("state.io", errs.ExitInternal, "cannot "+what).WithCause(err)
}

func corrupt(path string, err error) error {
	return errs.Newf("state.corrupt", errs.ExitInternal, "%s is not a valid state file", path).WithCause(err)
}
