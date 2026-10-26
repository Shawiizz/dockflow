package upload

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Store is a directory of blobs named by their sha256.
type Store string

// Path is where blob sum lives.
func (s Store) Path(sum string) string { return filepath.Join(string(s), sum) }

// Has tells whether the store holds sum.
func (s Store) Has(sum string) bool {
	_, err := os.Stat(s.Path(sum))
	return err == nil
}

// Put copies the file at path into the store, unless it is there already, and returns its sum.
func (s Store) Put(path string) (string, error) {
	sum, _, err := HashFile(path)
	if err != nil {
		return "", err
	}
	if s.Has(sum) {
		return sum, nil
	}
	return sum, copyAtomic(path, s.Path(sum), 0o600)
}

// Options are how a manifest is applied.
type Options struct {
	// Mirror deletes the destination's files that the manifest does not list.
	Mirror bool
	// Mode, for files on the host, overrides the files' own mode.
	Mode fs.FileMode
	// UID and GID own the written files, when not negative.
	UID, GID int
}

// Apply makes target match m: each changed file is replaced atomically, after the file it
// replaces was saved into the store. It returns the manifest that restores target as it was.
func Apply(target string, m *Manifest, store Store, o Options) (*Manifest, error) {
	before := &Manifest{Single: m.Single, Files: map[string]File{}}
	save := func(rel, path string) error {
		st, err := os.Lstat(path)
		if errors.Is(err, fs.ErrNotExist) {
			before.Absent = append(before.Absent, rel)
			return nil
		}
		if err != nil {
			return err
		}
		if !st.Mode().IsRegular() {
			return fmt.Errorf("%s exists and is not a regular file", path)
		}
		sum, err := store.Put(path)
		if err != nil {
			return err
		}
		before.Files[rel] = File{SHA256: sum, Mode: st.Mode().Perm(), Size: st.Size()}
		return nil
	}
	write := func(rel string, f File) error {
		path := target
		if !m.Single {
			path = filepath.Join(target, filepath.FromSlash(rel))
		}
		if cur, _, err := HashFile(path); err == nil && cur == f.SHA256 {
			return own(path, o)
		}
		if err := save(rel, path); err != nil {
			return err
		}
		mode := f.Mode
		if o.Mode != 0 {
			mode = o.Mode
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := copyAtomic(store.Path(f.SHA256), path, mode); err != nil {
			return err
		}
		return own(path, o)
	}

	if !m.Single {
		if err := os.MkdirAll(target, 0o755); err != nil {
			return nil, err
		}
		for _, d := range m.Dirs {
			if err := os.MkdirAll(filepath.Join(target, filepath.FromSlash(d)), 0o755); err != nil {
				return nil, err
			}
		}
	}
	keys := make([]string, 0, len(m.Files))
	for k := range m.Files {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, rel := range keys {
		if err := write(rel, m.Files[rel]); err != nil {
			return before, err
		}
	}
	for _, rel := range m.Absent {
		path := filepath.Join(target, filepath.FromSlash(rel))
		if m.Single {
			path = target
		}
		if err := save(rel, path); err != nil {
			return before, err
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return before, err
		}
	}
	if o.Mirror && !m.Single {
		if err := mirror(target, m, save); err != nil {
			return before, err
		}
	}
	sort.Strings(before.Absent)
	return before, nil
}

// mirror deletes the files and empty directories of target that m does not list.
func mirror(target string, m *Manifest, save func(rel, path string) error) error {
	dirs := map[string]bool{}
	for _, d := range m.Dirs {
		dirs[d] = true
	}
	var extraDirs []string
	err := filepath.WalkDir(target, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(target, p)
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			if !dirs[rel] {
				extraDirs = append(extraDirs, p)
			}
			return nil
		}
		if _, ok := m.Files[rel]; ok {
			return nil
		}
		if d.Type().IsRegular() {
			if err := save(rel, p); err != nil {
				return err
			}
		}
		return os.Remove(p)
	})
	if err != nil {
		return err
	}
	// deepest first, and only the empty ones
	sort.Slice(extraDirs, func(i, j int) bool { return len(extraDirs[i]) > len(extraDirs[j]) })
	for _, d := range extraDirs {
		_ = os.Remove(d)
	}
	return nil
}

func own(path string, o Options) error {
	if o.UID < 0 && o.GID < 0 {
		return nil
	}
	return os.Lchown(path, o.UID, o.GID)
}

// copyAtomic copies src to dst through a temporary file in dst's directory, then renames it.
func copyAtomic(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".dockflow-")
	if err != nil {
		return err
	}
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return nil
}

// ParseOwner reads uid:gid; an empty owner leaves files as written.
func ParseOwner(owner string) (int, int, error) {
	if owner == "" {
		return -1, -1, nil
	}
	u, g, ok := strings.Cut(owner, ":")
	uid, err1 := strconv.Atoi(u)
	gid := uid
	var err2 error
	if ok {
		gid, err2 = strconv.Atoi(g)
	}
	if err1 != nil || err2 != nil || uid < 0 || gid < 0 {
		return 0, 0, fmt.Errorf("owner %q must be numeric, uid or uid:gid", owner)
	}
	return uid, gid, nil
}
