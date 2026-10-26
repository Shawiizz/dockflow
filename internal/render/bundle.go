package render

import (
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nikolalohinski/gonja/v2"
	"github.com/nikolalohinski/gonja/v2/config"
	"github.com/nikolalohinski/gonja/v2/exec"
	"github.com/nikolalohinski/gonja/v2/loaders"

	"github.com/Shawiizz/dockflow/internal/errs"
)

// Bundle is a tree of files held in memory: a plugin's files, with its templates rendered
// (ADR-0017). The workspace writes it out when an upload reads it.
type Bundle struct {
	// Name is unique among the bundles of a project: the plugin's id.
	Name string
	// Files are by slash-separated path.
	Files map[string]BundleFile
}

// BundleFile is one file of a bundle.
type BundleFile struct {
	Data []byte
	Mode os.FileMode
}

// String renders s, a template held in a string. An undefined variable is an error.
func String(s string, ctx map[string]any) (string, error) {
	out, err := Source("value", map[string]string{"value": s}, ctx)
	return string(out), err
}

// Source renders the template name of files, which can include the others. An undefined
// variable is an error.
func Source(name string, files map[string]string, ctx map[string]any) ([]byte, error) {
	cfg := config.New()
	cfg.StrictUndefined = true
	cfg.KeepTrailingNewline = true
	// the memory loader wants absolute names
	rooted := make(map[string]string, len(files))
	for k, v := range files {
		rooted["/"+strings.TrimPrefix(k, "/")] = v
	}
	loader, err := loaders.NewMemoryLoader(rooted)
	if err != nil {
		return nil, err
	}
	tpl, err := exec.NewTemplate("/"+strings.TrimPrefix(name, "/"), cfg, loader, gonja.DefaultEnvironment)
	if err != nil {
		return nil, cleanError(err)
	}
	out, err := tpl.ExecuteToBytes(exec.NewContext(ctx))
	if err != nil {
		return nil, cleanError(err)
	}
	return out, nil
}

// Bundle returns the directory b is written to, writing it the first time.
func (w *Workspace) Bundle(b *Bundle) (string, error) {
	if w.bundles == "" {
		dir, err := os.MkdirTemp("", "dockflow-plugins-")
		if err != nil {
			return "", errs.Internal("temporary directory: %v", err)
		}
		w.bundles = dir
	}
	dir := filepath.Join(w.bundles, b.Name)
	if _, err := os.Stat(dir); err == nil {
		return dir, nil
	}
	names := make([]string, 0, len(b.Files))
	for n := range b.Files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		f := b.Files[n]
		target := filepath.Join(dir, filepath.FromSlash(path.Clean(n)))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return "", errs.Internal("create %s: %v", filepath.Dir(target), err)
		}
		mode := f.Mode.Perm()
		if mode == 0 {
			mode = 0o644
		}
		if err := os.WriteFile(target, f.Data, mode); err != nil {
			return "", errs.Internal("write %s: %v", target, err)
		}
		// the umask must not decide the mode the upload records
		if err := os.Chmod(target, mode); err != nil {
			return "", errs.Internal("chmod %s: %v", target, err)
		}
	}
	return dir, nil
}
