// Package config loads dockflow.yml, version 1 (docs/design/spec/config-v1.md): strict YAML,
// unknown keys refused, Compose-style interpolation of string values.
package config

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// FileName is the name of the configuration file at the project root.
const FileName = "dockflow.yml"

// File is dockflow.yml.
type File struct {
	Version      int                     `yaml:"version"`
	App          string                  `yaml:"app"`
	Compose      []string                `yaml:"compose"`
	Environments map[string]*Environment `yaml:"environments"`
	Settings     `yaml:",inline"`
}

// Settings are the keys that can be set at the top level or inside an environment.
type Settings struct {
	Releases  *Releases `yaml:"releases"`
	OnFailure string    `yaml:"on_failure"`

	Registry *Registry      `yaml:"registry"`
	Build    *BuildSettings `yaml:"build"`

	// Keys of the specification that arrive in later milestones. They are refused with a clear
	// message instead of being ignored.
	Templates *yaml.Node `yaml:"templates"`
	Uploads   *yaml.Node `yaml:"uploads"`
	Hooks     *yaml.Node `yaml:"hooks"`
	Notify    *yaml.Node `yaml:"notify"`
	Health    *yaml.Node `yaml:"health"`
	Firewall  *yaml.Node `yaml:"firewall"`
	Routes    *yaml.Node `yaml:"routes"`
	Plugins   *yaml.Node `yaml:"plugins"`
	Backups   *yaml.Node `yaml:"backups"`
}

// Registry is an external registry (ADR-0009). Without it, images go to the server's own.
type Registry struct {
	URL            string   `yaml:"url"`
	Username       string   `yaml:"username"`
	Password       string   `yaml:"password"`
	AdditionalTags []string `yaml:"additional_tags"`
}

// BuildSettings is the build block.
type BuildSettings struct {
	Builder string `yaml:"builder"` // local or remote
	Engine  string `yaml:"engine"`  // docker or podman
}

// Releases is the releases block.
type Releases struct {
	Keep int `yaml:"keep"`
}

// Environment is one entry of environments.
type Environment struct {
	Server      *Server           `yaml:"server"`
	Compose     []string          `yaml:"compose"`
	Profiles    []string          `yaml:"profiles"`
	Vars        map[string]string `yaml:"vars"`
	SecretsFile string            `yaml:"secrets_file"`
	Deploy      *Deploy           `yaml:"deploy"`
	CI          *CI               `yaml:"ci"`
	Settings    `yaml:",inline"`
}

// Server describes the server of an environment, when no connection string is used.
type Server struct {
	Name    string `yaml:"name" json:"name"`
	Host    string `yaml:"host" json:"host"`
	Port    int    `yaml:"port" json:"port"`
	User    string `yaml:"user" json:"user"`
	HostKey string `yaml:"host_key" json:"host_key"`
}

// Deploy is the deploy block of an environment.
type Deploy struct {
	Timeout string `yaml:"timeout"`
}

// CI is the ci block of an environment.
type CI struct {
	TagSuffix *string `yaml:"tag_suffix"`
}

// Resolved is the configuration of one environment, with top-level settings merged in.
type Resolved struct {
	Dir       string
	App       string
	Env       string
	Compose   []string
	Profiles  []string
	Vars      map[string]string
	Server    *Server
	Keep      int
	OnFailure string
	// Timeout overrides the computed health timeout of every service; 0 keeps it computed.
	Timeout   time.Duration
	TagSuffix string
	// Registry is nil for the server-local registry.
	Registry *Registry
	Build    BuildSettings
}

// laterKeys are spec keys not available yet, with the milestone that brings them.
var laterKeys = map[string]string{
	"templates": "M2", "uploads": "M2", "hooks": "M2",
	"notify": "M2", "health": "M2", "firewall": "M3", "routes": "M3", "plugins": "M3",
	"backups": "M4", "secrets_file": "M3",
}

// Find returns the project directory: dir, or the closest parent that holds dockflow.yml.
func Find(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	for d := abs; ; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, FileName)); err == nil {
			return d, nil
		}
		if filepath.Dir(d) == d {
			return "", errs.Config("no %s found in %s or its parents", FileName, abs).
				WithHint("run `dockflow init`, or pass the project directory with -C")
		}
	}
}

// Raw is dockflow.yml parsed but not yet interpolated.
type Raw struct {
	Dir  string
	root yaml.Node
	file File // decoded without interpolation, to read names
}

// Read parses dockflow.yml in dir, without interpolating it.
func Read(dir string) (*Raw, error) {
	path := filepath.Join(dir, FileName)
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, errs.Config("cannot read %s", path).WithCause(err)
	}
	r := &Raw{Dir: dir}
	if err := yaml.Unmarshal(b, &r.root); err != nil {
		return nil, errs.Config("%s is not valid YAML", FileName).WithCause(err)
	}
	if err := checkLater(&r.root, ""); err != nil {
		return nil, err
	}
	if err := decodeStrict(&r.root, &r.file); err != nil {
		return nil, err
	}
	if err := r.file.validateNames(); err != nil {
		return nil, err
	}
	return r, nil
}

// App returns the app name.
func (r *Raw) App() string { return r.file.App }

// EnvNames returns the environment names, sorted.
func (r *Raw) EnvNames() []string {
	names := make([]string, 0, len(r.file.Environments))
	for n := range r.file.Environments {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Vars returns the vars of an environment, before interpolation (vars are literal).
func (r *Raw) Vars(env string) map[string]string {
	e := r.file.Environments[env]
	if e == nil {
		return nil
	}
	return e.Vars
}

// TagSuffix returns the tag suffix that selects env in CI.
func (r *Raw) TagSuffix(env string) string {
	e := r.file.Environments[env]
	if e != nil && e.CI != nil && e.CI.TagSuffix != nil {
		return *e.CI.TagSuffix
	}
	if env == "production" {
		return ""
	}
	return env
}

// PickEnv resolves the environment named on the command line: an exact name, a unique prefix,
// or the only environment when name is empty.
func (r *Raw) PickEnv(name string) (string, error) {
	names := r.EnvNames()
	if name == "" {
		if len(names) == 1 {
			return names[0], nil
		}
		return "", errs.Usage("name an environment: %s", strings.Join(names, ", "))
	}
	if _, ok := r.file.Environments[name]; ok {
		return name, nil
	}
	var matches []string
	for _, n := range names {
		if strings.HasPrefix(n, name) {
			matches = append(matches, n)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return "", errs.Usage("no environment %q in %s", name, FileName).
			WithHint("environments: %s", strings.Join(names, ", "))
	default:
		return "", errs.Usage("%q matches several environments: %s", name, strings.Join(matches, ", "))
	}
}

// Resolve interpolates dockflow.yml with lookup and returns the configuration of env.
func (r *Raw) Resolve(env string, lookup Lookup) (*Resolved, error) {
	if err := checkLater(&r.root, env); err != nil {
		return nil, err
	}
	node := cloneNode(&r.root)
	if err := interpolateNode(node, lookup, nil); err != nil {
		return nil, err
	}
	var f File
	if err := decodeStrict(node, &f); err != nil {
		return nil, err
	}
	e := f.Environments[env]
	if e == nil {
		return nil, errs.Usage("no environment %q in %s", env, FileName)
	}
	res := &Resolved{
		Dir: r.Dir, App: f.App, Env: env,
		Compose: f.Compose, Profiles: e.Profiles, Vars: e.Vars, Server: e.Server,
		Keep: 10, OnFailure: "rollback", TagSuffix: r.TagSuffix(env),
	}
	if len(e.Compose) > 0 {
		res.Compose = e.Compose
	}
	for _, s := range []Settings{f.Settings, e.Settings} {
		if s.Releases != nil {
			res.Keep = s.Releases.Keep
		}
		if s.OnFailure != "" {
			res.OnFailure = s.OnFailure
		}
		if s.Registry != nil {
			res.Registry = s.Registry
		}
		if s.Build != nil {
			res.Build = *s.Build
		}
	}
	if err := res.validateImages(env); err != nil {
		return nil, err
	}
	if e.Deploy != nil && e.Deploy.Timeout != "" {
		d, err := time.ParseDuration(e.Deploy.Timeout)
		if err != nil || d <= 0 {
			return nil, errs.Config("environments.%s.deploy.timeout %q is not a duration", env, e.Deploy.Timeout).
				WithHint("write it like 5m or 90s")
		}
		res.Timeout = d
	}
	if res.Keep < 2 {
		return nil, errs.Config("releases.keep must be at least 2, not %d", res.Keep)
	}
	switch res.OnFailure {
	case "rollback", "fail", "ignore":
	default:
		return nil, errs.Config("on_failure must be rollback, fail or ignore, not %q", res.OnFailure)
	}
	if res.Server != nil {
		if err := res.Server.validate(env); err != nil {
			return nil, err
		}
	}
	return res, nil
}

func (res *Resolved) validateImages(env string) error {
	if res.Build.Builder == "" {
		res.Build.Builder = "local"
	}
	if res.Build.Engine == "" {
		res.Build.Engine = "docker"
	}
	switch {
	case res.Build.Builder != "local" && res.Build.Builder != "remote":
		return errs.Config("build.builder must be local or remote, not %q", res.Build.Builder)
	case res.Build.Engine != "docker" && res.Build.Engine != "podman":
		return errs.Config("build.engine must be docker or podman, not %q", res.Build.Engine)
	case res.Build.Builder == "remote":
		return notYet("build.builder: remote", "M2, in a later step")
	case res.Build.Engine == "podman":
		return notYet("build.engine: podman", "M2, in a later step")
	}
	if r := res.Registry; r != nil {
		if r.URL == "" {
			return errs.Config("registry.url is required when registry is set").
				WithHint("remove registry to use the server's own registry")
		}
		r.URL = strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(r.URL, "https://"), "http://"), "/")
		if (r.Username == "") != (r.Password == "") {
			return errs.Config("registry.username and registry.password go together")
		}
	}
	return nil
}

func (s *Server) validate(env string) error {
	at := "environments." + env + ".server"
	if s.Host == "" {
		return errs.Config("%s.host is required", at)
	}
	if s.Name == "" {
		s.Name = "main"
	}
	if !domain.ServerName.MatchString(s.Name) {
		return errs.Config("%s.name %q must match %s", at, s.Name, domain.ServerName)
	}
	if s.Port == 0 {
		s.Port = 22
	}
	if s.User == "" {
		s.User = "dockflow"
	}
	return nil
}

func (f *File) validateNames() error {
	if f.Version != 1 {
		return errs.Config("%s: version must be 1, not %d", FileName, f.Version).
			WithHint("add `version: 1` at the top of %s", FileName)
	}
	if !domain.AppName.MatchString(f.App) {
		return errs.Config("%s: app %q must match %s (at most 24 characters)", FileName, f.App, domain.AppName)
	}
	if len(f.Environments) == 0 {
		return errs.Config("%s: at least one environment is required under environments", FileName)
	}
	for name, e := range f.Environments {
		if !domain.EnvName.MatchString(name) {
			return errs.Config("%s: environment %q must match %s (no hyphen or underscore, at most 12 characters)", FileName, name, domain.EnvName)
		}
		if e == nil {
			f.Environments[name] = &Environment{}
		}
		for k := range e.varsOrNil() {
			if !domain.KeyName.MatchString(k) {
				return errs.Config("%s: environments.%s.vars: key %q must match %s", FileName, name, k, domain.KeyName)
			}
		}
	}
	return nil
}

func (e *Environment) varsOrNil() map[string]string {
	if e == nil {
		return nil
	}
	return e.Vars
}

// checkLater refuses the keys of the specification that arrive in later milestones, at the top
// level and in env (every environment when env is empty), before anything else reads them.
func checkLater(root *yaml.Node, env string) error {
	doc := root
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		doc = doc.Content[0]
	}
	if doc.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(doc.Content); i += 2 {
		key := doc.Content[i].Value
		if ms, ok := laterKeys[key]; ok && key != "secrets_file" {
			return notYet(key, ms)
		}
		if key != "environments" || doc.Content[i+1].Kind != yaml.MappingNode {
			continue
		}
		envs := doc.Content[i+1]
		for j := 0; j+1 < len(envs.Content); j += 2 {
			name := envs.Content[j].Value
			if (env != "" && name != env) || envs.Content[j+1].Kind != yaml.MappingNode {
				continue
			}
			e := envs.Content[j+1]
			for k := 0; k+1 < len(e.Content); k += 2 {
				if ms, ok := laterKeys[e.Content[k].Value]; ok {
					return notYet("environments."+name+"."+e.Content[k].Value, ms)
				}
			}
		}
	}
	return nil
}

func notYet(key, milestone string) error {
	return errs.Config("%s: `%s` is not available yet in this version of Dockflow", FileName, key).
		WithHint("it arrives with milestone %s (docs/design/roadmap.md); remove it for now", milestone)
}

func decodeStrict(node *yaml.Node, out any) error {
	b, err := yaml.Marshal(node)
	if err != nil {
		return errs.Internal("re-encode %s", FileName).WithCause(err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err := dec.Decode(out); err != nil {
		var te *yaml.TypeError
		if errors.As(err, &te) {
			return errs.Config("%s: %s", FileName, strings.Join(te.Errors, "; ")).
				WithHint("every key is listed in docs/design/spec/config-v1.md")
		}
		return errs.Config("%s is not valid", FileName).WithCause(err)
	}
	return nil
}

func cloneNode(n *yaml.Node) *yaml.Node {
	c := *n
	c.Content = make([]*yaml.Node, len(n.Content))
	for i, child := range n.Content {
		c.Content[i] = cloneNode(child)
	}
	return &c
}

// interpolateNode replaces ${VAR} in string scalars. Mapping keys are never interpolated, and
// neither are the app name, environment names or vars (path tells where we are).
func interpolateNode(n *yaml.Node, lookup Lookup, path []string) error {
	switch n.Kind {
	case yaml.DocumentNode, yaml.SequenceNode:
		for _, c := range n.Content {
			if err := interpolateNode(c, lookup, path); err != nil {
				return err
			}
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			key := n.Content[i].Value
			p := append(append([]string{}, path...), key)
			if len(p) == 1 && (key == "app" || key == "version") {
				continue
			}
			if len(p) == 3 && p[0] == "environments" && key == "vars" {
				continue
			}
			if err := interpolateNode(n.Content[i+1], lookup, p); err != nil {
				return err
			}
		}
	case yaml.ScalarNode:
		if n.Tag != "!!str" && n.Tag != "" {
			return nil
		}
		out, err := Interpolate(n.Value, lookup)
		if err != nil {
			return errs.Config("%s: %s: %s", FileName, strings.Join(path, "."), err.Error()).
				WithHint("define it under environments.<env>.vars or as a secret, or write ${NAME:-default}")
		}
		n.Value = out
	}
	return nil
}
