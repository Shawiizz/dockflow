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
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Root is where the state lives on a server.
const Root = "/var/lib/dockflow"

// UserDataHostKey is the file, in Root, that server cloud-init's provisioning leaves: the
// server's SSH host key came in its user-data, which the provider's metadata service serves to
// whoever asks, containers included (ADR-0014).
const UserDataHostKey = "user-data-host-key"

// HostKeyInUserData tells whether provisioning left UserDataHostKey.
func (s *Store) HostKeyInUserData() bool {
	_, err := os.Lstat(filepath.Join(s.root, UserDataHostKey))
	return err == nil
}

// Schema is the version of the state format.
const Schema = 1

// Store is the state of one server.
type Store struct {
	root string
	// run names temporary files.
	run string

	mu sync.Mutex
	// unknown holds, by scope (an app environment, or the server), a file read with fields this
	// Dockflow does not know: a newer one wrote them, and rewriting the scope would lose them.
	unknown map[string]string

	// Faults, when set, wraps every file write, which write performs. Tests use it to fail a
	// write, or to cut a run at one; it is nil otherwise.
	Faults func(path string, write func() error) error
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
	return &Store{root: root, run: run, unknown: map[string]string{}}, nil
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
	SwitchListen   string   `json:"switch_listen,omitempty"`
	TrustedProxies []string `json:"trusted_proxies,omitempty"`
	// ACMEEmail is the address given to Let's Encrypt with the switch's certificates.
	ACMEEmail string `json:"acme_email,omitempty"`
	// ACMECA is the ACME directory of the switch's certificates, when not the default ones.
	ACMECA          string `json:"acme_ca,omitempty"`
	RegistryImage   string `json:"registry_image,omitempty"`
	DockflowVersion string `json:"dockflow_version"`
	// NoPortFilter tells that server init was asked to leave the published-port filter out
	// (ADR-0014); SSHPort is let in, and FilterRules is the digest of the rules last applied.
	NoPortFilter bool   `json:"no_port_filter,omitempty"`
	SSHPort      int    `json:"ssh_port,omitempty"`
	FilterRules  string `json:"filter_rules,omitempty"`
	// NoWatchdog tells that server init was asked to leave the watchdog out (ADR-0010), and
	// WatchdogImage is the watchdog's image.
	NoWatchdog    bool   `json:"no_watchdog,omitempty"`
	WatchdogImage string `json:"watchdog_image,omitempty"`
	// CloudflareRanges are the ranges the cloudflare edge lets in and trusts (ADR-0011), as
	// last downloaded.
	CloudflareRanges []string `json:"cloudflare_ranges,omitempty"`
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
	// the spelling of the alphas before 1.0.0-alpha.4
	if v.Status == "rolled-back" {
		v.Status = domain.StatusRolledBack
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
		e := errs.Newf("state.schema", errs.ExitState, "%s has state schema %d; this Dockflow reads schema %d", path, head.Schema, Schema)
		if head.Schema > Schema {
			return false, e.WithHint("a newer Dockflow wrote this server's state: upgrade Dockflow")
		}
		return false, e.WithHint("this server's state is older than this Dockflow reads; use the Dockflow that wrote it")
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false, corrupt(path, err)
	}
	if hasUnknown(b, v) {
		s.mu.Lock()
		if _, ok := s.unknown[s.scope(path)]; !ok {
			s.unknown[s.scope(path)] = path
		}
		s.mu.Unlock()
	}
	return true, nil
}

// hasUnknown tells whether b holds fields that v's type does not have, at any depth.
func hasUnknown(b []byte, v any) bool {
	fresh := reflect.New(reflect.TypeOf(v).Elem()).Interface()
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	return dec.Decode(fresh) != nil
}

// scope is the app environment a state file belongs to (apps/<stack>), or the server ("").
func (s *Store) scope(path string) string {
	rel, err := filepath.Rel(s.root, path)
	if err != nil {
		return ""
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) > 2 && parts[0] == "apps" {
		return "apps/" + parts[1]
	}
	return ""
}

// Writable refuses, with state.newer, to change the app environment once a file of it read so far
// holds fields this Dockflow does not know (state-v1.md, Compatibility). A run calls it before it
// changes containers from what it read, which no file write would check.
func (a *App) Writable() error {
	a.s.mu.Lock()
	newer, ok := a.s.unknown[a.s.scope(filepath.Join(a.dir, "env.json"))]
	a.s.mu.Unlock()
	if !ok {
		return nil
	}
	return newerErr(newer)
}

// writable refuses to write path when its scope holds a file with fields this Dockflow does not
// know (state-v1.md, Compatibility): rewriting the scope, or acting on it, would drop them. The
// file at path itself is checked when it was not read before.
func (s *Store) writable(path string, v any) error {
	if _, err := os.Stat(path); err == nil {
		fresh := reflect.New(reflect.TypeOf(v)).Interface()
		if _, err := s.readJSON(path, fresh); err != nil {
			return err
		}
	}
	s.mu.Lock()
	newer, ok := s.unknown[s.scope(path)]
	s.mu.Unlock()
	if !ok {
		return nil
	}
	return newerErr(newer)
}

func newerErr(path string) error {
	return errs.Newf("state.newer", errs.ExitState, "%s holds fields that this Dockflow does not know: a newer Dockflow wrote it, and changing this state would lose them", path).
		WithHint("upgrade Dockflow to the version this server was last changed with")
}

// writeJSON writes v atomically: to a temporary file, synced, then renamed.
func (s *Store) writeJSON(path string, v any, gz bool) error {
	if err := s.writable(path, v); err != nil {
		return err
	}
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
	if s.Faults != nil {
		return s.Faults(path, func() error { return s.put(path, b) })
	}
	return s.put(path, b)
}

// put writes b to path: to a temporary file, synced, then renamed.
func (s *Store) put(path string, b []byte) error {
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
