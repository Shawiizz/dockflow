// Package upload sends files to the server (ADR-0021). A source is described by a manifest of
// content hashes; the server keeps a content-addressed store of blobs, so only missing blobs
// travel, and applying a manifest makes the destination match it, one atomic file at a time.
package upload

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"github.com/Shawiizz/dockflow/internal/ignore"
)

// File is one file of a manifest.
type File struct {
	SHA256 string      `json:"sha256"`
	Mode   fs.FileMode `json:"mode"`
	Size   int64       `json:"size"`
}

// Manifest describes a source: a single file (key ""), or a tree of files and directories,
// with slash-separated paths relative to the destination.
type Manifest struct {
	Single bool            `json:"single,omitempty"`
	Files  map[string]File `json:"files"`
	Dirs   []string        `json:"dirs,omitempty"`
	// Absent lists files that did not exist: restoring a backup removes them.
	Absent []string `json:"absent,omitempty"`
}

// Digest identifies a manifest's content.
func (m *Manifest) Digest() string {
	b, _ := json.Marshal(m) // map keys are sorted by encoding/json
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Blobs lists the content hashes a manifest needs.
func (m *Manifest) Blobs() []string {
	seen := map[string]bool{}
	var out []string
	for _, f := range m.Files {
		if !seen[f.SHA256] {
			seen[f.SHA256] = true
			out = append(out, f.SHA256)
		}
	}
	sort.Strings(out)
	return out
}

// HashFile returns a file's sha256, hex-encoded.
func HashFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// Scan builds the manifest of src, a file or a directory, leaving out excluded paths. It also
// returns where each blob can be read.
func Scan(src string, exclude *ignore.Patterns) (*Manifest, map[string]string, error) {
	st, err := os.Stat(src)
	if err != nil {
		return nil, nil, err
	}
	paths := map[string]string{}
	m := &Manifest{Files: map[string]File{}}
	if !st.IsDir() {
		sum, size, err := HashFile(src)
		if err != nil {
			return nil, nil, err
		}
		m.Single = true
		m.Files[""] = File{SHA256: sum, Mode: st.Mode().Perm(), Size: size}
		paths[sum] = src
		return m, paths, nil
	}
	err = filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if exclude != nil && exclude.Excludes(rel) {
			if d.IsDir() && !exclude.HasExceptions() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			m.Dirs = append(m.Dirs, rel)
		case info.Mode().IsRegular():
			sum, size, err := HashFile(p)
			if err != nil {
				return err
			}
			m.Files[rel] = File{SHA256: sum, Mode: info.Mode().Perm(), Size: size}
			paths[sum] = p
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	sort.Strings(m.Dirs)
	return m, paths, nil
}
