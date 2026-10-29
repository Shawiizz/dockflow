package upload

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
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
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	return s.put(f)
}

// put copies r into the store under the sum of what it read: a file that changes while it is
// read is stored under the sum of what was copied, never under another's.
func (s Store) put(r io.Reader) (string, error) {
	tmp, err := os.CreateTemp(string(s), ".incoming-")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), r); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if s.Has(sum) {
		return sum, nil
	}
	return sum, os.Rename(tmp.Name(), s.Path(sum))
}

// Options are how a manifest is applied.
type Options struct {
	// Mirror deletes the destination's files that the manifest does not list.
	Mirror bool
	// Mode, for files on the host, overrides the files' own mode.
	Mode fs.FileMode
	// UID and GID own the written files, when not negative.
	UID, GID int
	// Saved is where the files Apply replaces or deletes are saved, by sum; the store itself
	// when empty.
	Saved Store
	// Stats, when set, counts what Apply changed.
	Stats *Stats
}

// Stats count the files an Apply wrote and deleted.
type Stats struct {
	Changed int `json:"files_changed"`
	Deleted int `json:"files_deleted"`
}

// Validate refuses a manifest whose paths would leave its destination: absolute paths, "..",
// paths that are not clean, and sums that are not sha256.
func (m *Manifest) Validate() error {
	check := func(p string) error {
		if m.Single {
			if p != "" {
				return fmt.Errorf("the manifest of a single file lists %q", p)
			}
			return nil
		}
		if p == "" || p == "." || p == ".." || strings.HasPrefix(p, "/") || strings.HasPrefix(p, "../") || path.Clean(p) != p {
			return fmt.Errorf("the manifest lists %q, which is not a path inside its destination", p)
		}
		return nil
	}
	for p, f := range m.Files {
		if err := check(p); err != nil {
			return err
		}
		if b, err := hex.DecodeString(f.SHA256); err != nil || len(b) != sha256.Size || strings.ToLower(f.SHA256) != f.SHA256 {
			return fmt.Errorf("the manifest's sum %q for %q is not a sha256", f.SHA256, p)
		}
	}
	for _, list := range [][]string{m.Dirs, m.Absent} {
		for _, p := range list {
			if err := check(p); err != nil {
				return err
			}
		}
	}
	if m.Single && len(m.Dirs) > 0 {
		return fmt.Errorf("the manifest of a single file lists directories")
	}
	return nil
}

// Apply makes target match m: each changed file is replaced atomically, after the file it
// replaces was saved into the store. It returns the manifest that restores target as it was.
//
// target's parent is trusted; everything below it may be written by the containers that use it,
// so every path is resolved inside target (os.Root): a symbolic link that leads out of it is an
// error, never followed.
func Apply(target string, m *Manifest, store Store, o Options) (*Manifest, error) {
	if err := m.Validate(); err != nil {
		return nil, err
	}
	saved := o.Saved
	if saved == "" {
		saved = store
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return nil, err
	}
	parent, err := os.OpenRoot(filepath.Dir(target))
	if err != nil {
		return nil, err
	}
	defer func() { _ = parent.Close() }()
	// root holds the files; loc is where rel is in it
	root := parent
	loc := func(string) string { return filepath.Base(target) }
	if !m.Single {
		if err := parent.MkdirAll(filepath.Base(target), 0o755); err != nil {
			return nil, err
		}
		if root, err = parent.OpenRoot(filepath.Base(target)); err != nil {
			return nil, err
		}
		defer func() { _ = root.Close() }()
		loc = filepath.FromSlash
	}

	before := &Manifest{Single: m.Single, Files: map[string]File{}}
	save := func(rel, p string) error {
		st, err := root.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) {
			before.Absent = append(before.Absent, rel)
			return nil
		}
		if err != nil {
			return err
		}
		if !st.Mode().IsRegular() {
			return fmt.Errorf("%s exists and is not a regular file", path.Join(target, filepath.ToSlash(p)))
		}
		f, err := root.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		sum, err := saved.put(f)
		if err != nil {
			return err
		}
		before.Files[rel] = File{SHA256: sum, Mode: st.Mode().Perm(), Size: st.Size()}
		return nil
	}
	write := func(rel string, f File) error {
		p := loc(rel)
		if cur, err := hashIn(root, p); err == nil && cur == f.SHA256 {
			return own(root, p, o)
		}
		if err := save(rel, p); err != nil {
			return err
		}
		mode := f.Mode
		if o.Mode != 0 {
			mode = o.Mode
		}
		if dir := filepath.Dir(p); dir != "." {
			if err := root.MkdirAll(dir, 0o755); err != nil {
				return err
			}
		}
		if err := copyAtomic(root, store.Path(f.SHA256), p, mode); err != nil {
			return err
		}
		if o.Stats != nil {
			o.Stats.Changed++
		}
		return own(root, p, o)
	}
	deleted := func() {
		if o.Stats != nil {
			o.Stats.Deleted++
		}
	}

	for _, d := range m.Dirs {
		if err := root.MkdirAll(filepath.FromSlash(d), 0o755); err != nil {
			return nil, err
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
		p := loc(rel)
		if err := save(rel, p); err != nil {
			return before, err
		}
		if err := root.Remove(p); err == nil {
			deleted()
		} else if !errors.Is(err, fs.ErrNotExist) {
			return before, err
		}
	}
	if o.Mirror && !m.Single {
		if err := mirror(root, m, save, deleted); err != nil {
			return before, err
		}
	}
	sort.Strings(before.Absent)
	return before, nil
}

// mirror deletes the files and empty directories of root that m does not list.
func mirror(root *os.Root, m *Manifest, save func(rel, p string) error, deleted func()) error {
	dirs := map[string]bool{}
	for _, d := range m.Dirs {
		dirs[d] = true
	}
	var extraDirs []string
	// a symbolic link to a directory is not walked into: it is an entry, deleted as such
	err := fs.WalkDir(root.FS(), ".", func(rel string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		p := filepath.FromSlash(rel)
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
		if err := root.Remove(p); err != nil {
			return err
		}
		deleted()
		return nil
	})
	if err != nil {
		return err
	}
	// deepest first, and only the empty ones
	sort.Slice(extraDirs, func(i, j int) bool { return len(extraDirs[i]) > len(extraDirs[j]) })
	for _, d := range extraDirs {
		_ = root.Remove(d)
	}
	return nil
}

// hashIn is the sha256 of the file p of root.
func hashIn(root *os.Root, p string) (string, error) {
	f, err := root.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func own(root *os.Root, p string, o Options) error {
	if o.UID < 0 && o.GID < 0 {
		return nil
	}
	return root.Lchown(p, o.UID, o.GID)
}

// copyAtomic copies src to dst of root through a temporary file in dst's directory, then
// renames it: the rename replaces dst itself, even when dst is a symbolic link.
func copyAtomic(root *os.Root, src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	tmpName := filepath.Join(filepath.Dir(dst), "."+filepath.Base(dst)+".dockflow-"+hex.EncodeToString(suffix[:]))
	tmp, err := root.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		_ = root.Remove(tmpName)
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		_ = root.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = root.Remove(tmpName)
		return err
	}
	if err := root.Rename(tmpName, dst); err != nil {
		_ = root.Remove(tmpName)
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
