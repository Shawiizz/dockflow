// Package plugin expands plugins (ADR-0017): a directory with a plugin.yml whose templates,
// uploads and hooks become the project's own, rendered with the inputs the project gives it.
package plugin

import (
	"bytes"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/render"
)

// ManifestName is the file that makes a directory a plugin.
const ManifestName = "plugin.yml"

//go:embed builtin
var builtin embed.FS

var (
	idName    = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	inputName = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
)

// Input types.
const (
	TypeString  = "string"
	TypeBoolean = "boolean"
	TypeList    = "list"
	TypeFile    = "file"
)

// Input is one input a plugin takes.
type Input struct {
	Name        string `yaml:"name" json:"name"`
	Description string `yaml:"description" json:"description,omitempty"`
	Type        string `yaml:"type" json:"type"`
	Required    bool   `yaml:"required" json:"required,omitempty"`
	// RequiredUnless names another input: this one is required when that one is not given
	RequiredUnless string `yaml:"required_unless" json:"required_unless,omitempty"`
	Default        any    `yaml:"default" json:"default,omitempty"`
}

type manifest struct {
	Name        string    `yaml:"name"`
	Description string    `yaml:"description"`
	Inputs      []Input   `yaml:"inputs"`
	Templates   yaml.Node `yaml:"templates"`
	Uploads     yaml.Node `yaml:"uploads"`
	Hooks       yaml.Node `yaml:"hooks"`
}

// Plugin is a plugin, read but not expanded.
type Plugin struct {
	Name        string  `json:"name"`
	Description string  `json:"description,omitempty"`
	Builtin     bool    `json:"builtin"`
	Source      string  `json:"source"`
	Inputs      []Input `json:"inputs"`
	files       map[string]render.BundleFile
	m           manifest
}

// Builtins returns the plugins shipped in the binary, by name.
func Builtins() ([]*Plugin, error) {
	entries, err := builtin.ReadDir("builtin")
	if err != nil {
		return nil, errs.Internal("built-in plugins: %v", err)
	}
	out := make([]*Plugin, 0, len(entries))
	for _, e := range entries {
		p, err := builtinPlugin(e.Name())
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

func builtinPlugin(name string) (*Plugin, error) {
	sub, err := fs.Sub(builtin, "builtin/"+name)
	if err != nil {
		return nil, errs.Internal("built-in plugin %s: %v", name, err)
	}
	return read(sub, name, "built-in", true)
}

// IsPath tells whether use names a directory of the project rather than a built-in plugin.
func IsPath(use string) bool { return strings.ContainsAny(use, `/\`) || use == "." }

// Load reads the plugin use names: a built-in plugin, or a directory of the project at dir.
func Load(dir, use string) (*Plugin, error) {
	if !IsPath(use) {
		if _, err := fs.Stat(builtin, "builtin/"+use+"/"+ManifestName); err != nil {
			names := []string{}
			if all, err := Builtins(); err == nil {
				for _, p := range all {
					names = append(names, p.Name)
				}
			}
			return nil, errs.Config("plugins: no built-in plugin %q", use).
				WithHint("the built-in plugins are %s; a plugin of the project is a path, like ./deploy/plugins/%s", strings.Join(names, ", "), use)
		}
		return builtinPlugin(use)
	}
	clean := filepath.Clean(use)
	if filepath.IsAbs(use) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return nil, errs.Config("plugins: %q must be a directory inside the project", use)
	}
	root := filepath.Join(dir, clean)
	if _, err := os.Stat(filepath.Join(root, ManifestName)); err != nil {
		return nil, errs.Config("plugins: %s has no %s", use, ManifestName)
	}
	return read(os.DirFS(root), filepath.Base(root), filepath.ToSlash(clean), false)
}

// read reads a plugin's manifest and every other file of its directory.
func read(fsys fs.FS, name, source string, isBuiltin bool) (*Plugin, error) {
	at := "plugin " + source
	b, err := fs.ReadFile(fsys, ManifestName)
	if err != nil {
		return nil, errs.Config("%s: %v", at, err)
	}
	var m manifest
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err := dec.Decode(&m); err != nil {
		return nil, errs.Config("%s: %s is not valid: %s", at, ManifestName, strings.TrimPrefix(err.Error(), "yaml: "))
	}
	if m.Name != "" {
		name = m.Name
	}
	p := &Plugin{Name: name, Description: m.Description, Builtin: isBuiltin, Source: source, m: m,
		files: map[string]render.BundleFile{}}
	seen := map[string]bool{}
	for i := range m.Inputs {
		in := &m.Inputs[i]
		if !inputName.MatchString(in.Name) || in.Name == "id" {
			return nil, errs.Config("%s: input %q: a name matches %s, and id is reserved", at, in.Name, inputName)
		}
		if seen[in.Name] {
			return nil, errs.Config("%s: input %s is declared twice", at, in.Name)
		}
		seen[in.Name] = true
		if in.RequiredUnless != "" && !slices.ContainsFunc(m.Inputs, func(o Input) bool { return o.Name == in.RequiredUnless && o.Name != in.Name }) {
			return nil, errs.Config("%s: input %s: required_unless names no other input, %q", at, in.Name, in.RequiredUnless)
		}
		switch in.Type {
		case "":
			in.Type = TypeString
		case TypeString, TypeBoolean, TypeList, TypeFile:
		default:
			return nil, errs.Config("%s: input %s: type must be string, boolean, list or file, not %q", at, in.Name, in.Type)
		}
	}
	p.Inputs = m.Inputs
	err = fs.WalkDir(fsys, ".", func(p2 string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		if p2 == ManifestName {
			return nil
		}
		data, err := fs.ReadFile(fsys, p2)
		if err != nil {
			return err
		}
		mode := fs.FileMode(0o644)
		if st, err := fs.Stat(fsys, p2); err == nil && !isBuiltin {
			mode = st.Mode().Perm()
		}
		p.files[p2] = render.BundleFile{Data: data, Mode: mode}
		return nil
	})
	if err != nil {
		return nil, errs.Config("%s: %v", at, err)
	}
	return p, nil
}

// Expanded is what the plugins of an environment add to it.
type Expanded struct {
	Uploads []config.UploadEntry
	Hooks   []domain.Hook
}

// Values are the variables a plugin sees, besides its inputs and id.
type Values struct {
	// Public are the built-in variables and vars: plugin.yml's values see these.
	Public map[string]string
	// All adds the secrets: the plugin's templates see these, as the project's own do.
	All map[string]string
}

// Expand expands each use of a plugin into uploads and hooks.
func Expand(dir string, uses []config.PluginUse, v Values) (*Expanded, error) {
	out := &Expanded{}
	ids := map[string]bool{}
	for i, u := range uses {
		if u.Use == "" {
			return nil, errs.Config("plugins[%d]: use is required", i)
		}
		p, err := Load(dir, u.Use)
		if err != nil {
			return nil, err
		}
		id := u.ID
		if id == "" {
			id = p.Name
		}
		if !idName.MatchString(id) {
			return nil, errs.Config("plugins[%d]: the id %q must match %s", i, id, idName).
				WithHint("give the use an id")
		}
		if ids[id] {
			return nil, errs.Config("plugins[%d]: two uses have the id %s", i, id).
				WithHint("give each use of the same plugin its own id")
		}
		ids[id] = true
		e, err := p.expand(dir, id, u.With, v)
		if err != nil {
			return nil, err
		}
		out.Uploads = append(out.Uploads, e.Uploads...)
		out.Hooks = append(out.Hooks, e.Hooks...)
	}
	return out, nil
}

func (p *Plugin) expand(dir, id string, with map[string]any, v Values) (*Expanded, error) {
	at := "plugin " + id
	bundle := &render.Bundle{Name: id, Files: map[string]render.BundleFile{}}
	for k, f := range p.files {
		bundle.Files[k] = f
	}
	inputs, err := p.inputs(dir, at, with, bundle)
	if err != nil {
		return nil, err
	}
	ctx := func(base map[string]string) map[string]any {
		m := make(map[string]any, len(base)+len(inputs)+1)
		for k, val := range base {
			m[k] = val
		}
		for k, val := range inputs {
			m[k] = val
		}
		m["id"] = id
		return m
	}
	public, all := ctx(v.Public), ctx(v.All)

	// templates: rendered into the bundle, with every value the project's own templates see
	var templates []config.TemplateEntry
	if err := decode(&p.m.Templates, public, &templates); err != nil {
		return nil, errs.Config("%s: templates: %v", at, err)
	}
	sources := map[string]string{}
	for k, f := range bundle.Files {
		sources[k] = string(f.Data)
	}
	for _, t := range templates {
		src, err := inside(t.Src)
		if err != nil {
			return nil, errs.Config("%s: templates: %v", at, err)
		}
		dest := src
		if t.Dest != "" {
			if dest, err = inside(t.Dest); err != nil {
				return nil, errs.Config("%s: templates: %v", at, err)
			}
		}
		f, ok := bundle.Files[src]
		if !ok {
			return nil, errs.Config("%s: templates: %s is not a file of the plugin", at, src)
		}
		data, err := render.Source(src, sources, all)
		if err != nil {
			return nil, errs.Config("%s: template %s cannot be rendered", at, src).WithCause(err).
				WithHint("every variable must be an input, id, or a variable of the project")
		}
		bundle.Files[dest] = render.BundleFile{Data: data, Mode: f.Mode}
	}

	var uploads []config.UploadEntry
	if err := decode(&p.m.Uploads, public, &uploads); err != nil {
		return nil, errs.Config("%s: uploads: %v", at, err)
	}
	dests := map[string]bool{}
	for i := range uploads {
		u := &uploads[i]
		src, err := inside(u.Src)
		if err != nil {
			return nil, errs.Config("%s: uploads[%d]: %v", at, i, err)
		}
		if !has(bundle, src) {
			return nil, errs.Config("%s: uploads[%d]: %s is not a file or directory of the plugin", at, i, src)
		}
		u.Src, u.Plugin, u.Bundle = filepath.FromSlash(src), id, bundle
		dests[u.Dest] = true
	}

	var hooks pluginHooks
	if err := decode(&p.m.Hooks, public, &hooks); err != nil {
		return nil, errs.Config("%s: hooks: %v", at, err)
	}
	h, err := hooks.expand(at, id, dests)
	if err != nil {
		return nil, err
	}
	return &Expanded{Uploads: uploads, Hooks: h}, nil
}

// inputs checks with against the declared inputs, and returns each input's value: a string, a
// bool, a list of strings, or for a file, its path in the bundle, where it is copied.
func (p *Plugin) inputs(dir, at string, with map[string]any, bundle *render.Bundle) (map[string]any, error) {
	declared := map[string]bool{}
	names := []string{}
	for _, in := range p.Inputs {
		declared[in.Name] = true
		names = append(names, in.Name)
	}
	keys := make([]string, 0, len(with))
	for k := range with {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !declared[k] {
			hint := "it takes no input"
			if len(names) > 0 {
				hint = "its inputs are " + strings.Join(names, ", ")
			}
			return nil, errs.Config("%s: unknown input %s", at, k).WithHint("%s", hint)
		}
	}
	out := map[string]any{}
	for _, in := range p.Inputs {
		val, ok := with[in.Name]
		if !ok || val == nil {
			val = in.Default
		}
		if val == nil && in.Required {
			return nil, errs.Config("%s: the input %s is required", at, in.Name).WithHint("%s", in.Description)
		}
		if val == nil && in.RequiredUnless != "" && with[in.RequiredUnless] == nil {
			return nil, errs.Config("%s: the input %s is required without %s", at, in.Name, in.RequiredUnless).
				WithHint("%s", in.Description)
		}
		v, err := coerce(in.Type, val)
		if err != nil {
			return nil, errs.Config("%s: input %s: %v", at, in.Name, err)
		}
		if in.Type == TypeFile && v != "" {
			rel := v.(string)
			clean, err := inside(filepath.ToSlash(rel))
			if err != nil {
				return nil, errs.Config("%s: input %s: %v", at, in.Name, err)
			}
			data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(clean)))
			if err != nil {
				return nil, errs.Config("%s: input %s: %s is not a file of the project", at, in.Name, rel)
			}
			mode := fs.FileMode(0o644)
			if st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(clean))); err == nil {
				mode = st.Mode().Perm()
			}
			where := "inputs/" + in.Name + "/" + path.Base(clean)
			bundle.Files[where] = render.BundleFile{Data: data, Mode: mode}
			v = where
		}
		out[in.Name] = v
	}
	return out, nil
}

func coerce(typ string, val any) (any, error) {
	switch typ {
	case TypeBoolean:
		switch b := val.(type) {
		case nil:
			return false, nil
		case bool:
			return b, nil
		case string:
			if v, err := strconv.ParseBool(b); err == nil {
				return v, nil
			}
		}
		return nil, fmt.Errorf("%v is not true or false", val)
	case TypeList:
		switch l := val.(type) {
		case nil:
			return []string{}, nil
		case []any:
			out := make([]string, 0, len(l))
			for _, x := range l {
				s, err := scalar(x)
				if err != nil {
					return nil, err
				}
				out = append(out, s)
			}
			return out, nil
		default:
			s, err := scalar(val)
			if err != nil {
				return nil, err
			}
			return []string{s}, nil
		}
	default:
		if val == nil {
			return "", nil
		}
		return scalar(val)
	}
}

func scalar(val any) (string, error) {
	switch x := val.(type) {
	case string:
		return x, nil
	case bool, int, int64, uint64, float64:
		return fmt.Sprint(x), nil
	}
	return "", fmt.Errorf("a value must be a string, a number or a boolean")
}

// inside cleans a slash path of the plugin, which must stay inside it.
func inside(p string) (string, error) {
	clean := path.Clean(strings.ReplaceAll(p, `\`, "/"))
	if p == "" || path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("%q must be a path inside the plugin", p)
	}
	return clean, nil
}

// has tells whether p is a file or a directory of the bundle.
func has(b *render.Bundle, p string) bool {
	if _, ok := b.Files[p]; ok || p == "." {
		return ok || len(b.Files) > 0
	}
	for k := range b.Files {
		if strings.HasPrefix(k, p+"/") {
			return true
		}
	}
	return false
}
