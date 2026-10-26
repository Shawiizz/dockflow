// Package render renders the files listed under `templates:` with Jinja (gonja), in a temporary
// copy of the project: the source tree is never modified (ADR-0006).
package render

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nikolalohinski/gonja/v2"
	"github.com/nikolalohinski/gonja/v2/config"
	"github.com/nikolalohinski/gonja/v2/exec"
	"github.com/nikolalohinski/gonja/v2/loaders"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/ignore"
)

// Template is one entry of `templates:`, relative to the project. Src equals Dest for a file
// rendered in place.
type Template struct {
	Src  string `json:"src"`
	Dest string `json:"dest"`
}

func init() {
	// gonja logs through logrus; Dockflow reports errors itself
	gonja.SetLoggerOutput(io.Discard)
}

// File renders the template at path with vars. An undefined variable is an error.
func File(path string, vars map[string]string) ([]byte, error) {
	cfg := config.New()
	cfg.StrictUndefined = true
	cfg.KeepTrailingNewline = true
	loader, err := loaders.NewFileSystemLoader(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	tpl, err := exec.NewTemplate(filepath.Base(path), cfg, loader, gonja.DefaultEnvironment)
	if err != nil {
		return nil, err
	}
	data := make(map[string]any, len(vars))
	for k, v := range vars {
		data[k] = v
	}
	return tpl.ExecuteToBytes(exec.NewContext(data))
}

// Workspace is a temporary copy of the parts of the project that hold rendered templates.
type Workspace struct {
	project string
	root    string
	// copied are the directories copied, as absolute paths in the project.
	copied []string
	// bundles holds the plugins' files, written out by Bundle.
	bundles string
}

// Prepare renders every template, then copies each directory of dirs that holds a rendered file
// into a temporary workspace, with the rendered files in place. dirs are the directories that
// are read as a whole (build contexts); a template outside them is still rendered, alone.
func Prepare(project string, templates []Template, vars map[string]string, dirs []string) (*Workspace, error) {
	w := &Workspace{project: project}
	if len(templates) == 0 {
		return w, nil
	}
	rendered := map[string][]byte{} // absolute dest in the project → content
	for _, t := range templates {
		src := filepath.Join(project, t.Src)
		if _, err := os.Stat(src); err != nil {
			return nil, errs.Config("templates: %s does not exist", t.Src)
		}
		out, err := File(src, vars)
		if err != nil {
			return nil, errs.Config("templates: %s cannot be rendered", t.Src).WithCause(cleanError(err)).
				WithHint("every variable must be defined: built-in, secret or vars of the environment")
		}
		rendered[filepath.Join(project, t.Dest)] = out
	}
	root, err := os.MkdirTemp("", "dockflow-render-")
	if err != nil {
		return nil, errs.Internal("temporary directory: %v", err)
	}
	w.root = root

	dests := make([]string, 0, len(rendered))
	for d := range rendered {
		dests = append(dests, d)
	}
	sort.Strings(dests)
	done := map[string]bool{}
	for _, dir := range dirs {
		if done[dir] || !containsAny(dir, dests) {
			continue
		}
		done[dir] = true
		if err := w.copyTree(dir); err != nil {
			w.Close()
			return nil, err
		}
		w.copied = append(w.copied, dir)
	}
	for _, dest := range dests {
		target := w.inWorkspace(dest)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			w.Close()
			return nil, errs.Internal("create %s: %v", filepath.Dir(target), err)
		}
		// never write through a hard link to the source file
		if err := os.Remove(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
			w.Close()
			return nil, errs.Internal("replace %s: %v", target, err)
		}
		mode := fs.FileMode(0o644)
		if st, err := os.Stat(dest); err == nil {
			mode = st.Mode().Perm()
		}
		if err := os.WriteFile(target, rendered[dest], mode); err != nil {
			w.Close()
			return nil, errs.Internal("write %s: %v", target, err)
		}
	}
	return w, nil
}

// Path returns where path of the project is to be read from: in the workspace when it holds a
// copy, else path itself.
func (w *Workspace) Path(path string) string {
	if w.root == "" {
		return path
	}
	for _, dir := range w.copied {
		if within(dir, path) {
			return w.inWorkspace(path)
		}
	}
	if _, err := os.Stat(w.inWorkspace(path)); err == nil {
		return w.inWorkspace(path)
	}
	return path
}

// Close removes the workspace.
func (w *Workspace) Close() {
	if w.root != "" {
		os.RemoveAll(w.root)
	}
	if w.bundles != "" {
		os.RemoveAll(w.bundles)
	}
}

func (w *Workspace) inWorkspace(path string) string {
	rel, err := filepath.Rel(w.project, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		// outside the project: keyed by its absolute path
		return filepath.Join(w.root, "_outside", path)
	}
	return filepath.Join(w.root, rel)
}

func within(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func containsAny(dir string, paths []string) bool {
	for _, p := range paths {
		if within(dir, p) {
			return true
		}
	}
	return false
}

// copyTree copies dir into the workspace, with hard links where the filesystem allows, leaving
// out .git and what dir's .dockerignore excludes (the build would not read it).
func (w *Workspace) copyTree(dir string) error {
	patterns, err := ignore.File(dir)
	if err != nil {
		return errs.Internal("read %s/.dockerignore: %v", dir, err)
	}
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return errs.Internal("read %s: %v", path, err)
		}
		rel, _ := filepath.Rel(dir, path)
		if rel != "." {
			if d.IsDir() && d.Name() == ".git" {
				return filepath.SkipDir
			}
			if patterns.Excludes(filepath.ToSlash(rel)) {
				if d.IsDir() && !patterns.HasExceptions() {
					return filepath.SkipDir
				}
				if !d.IsDir() {
					return nil
				}
			}
		}
		target := w.inWorkspace(path)
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o755)
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return errs.Internal("read link %s: %v", path, err)
			}
			return os.Symlink(link, target)
		case d.Type().IsRegular():
			if err := os.Link(path, target); err == nil {
				return nil
			}
			return copyFile(path, target)
		}
		return nil
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return errs.Internal("read %s: %v", src, err)
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return errs.Internal("read %s: %v", src, err)
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, st.Mode().Perm())
	if err != nil {
		return errs.Internal("write %s: %v", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return errs.Internal("copy %s: %v", src, err)
	}
	return out.Close()
}

// cleanError keeps gonja's message on one line.
func cleanError(err error) error {
	msg := strings.Join(strings.Fields(err.Error()), " ")
	return fmt.Errorf("%s", msg)
}
