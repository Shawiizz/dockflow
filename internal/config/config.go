// Package config loads dockflow.yml, version 1 (docs/design/spec/config-v1.md): strict YAML,
// unknown keys refused, Compose-style interpolation of string values.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/notify"
	"github.com/Shawiizz/dockflow/internal/render"
	"github.com/Shawiizz/dockflow/internal/upload"
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

	Registry  *Registry       `yaml:"registry"`
	Build     *BuildSettings  `yaml:"build"`
	Health    *Health         `yaml:"health"`
	Templates []TemplateEntry `yaml:"templates"`
	Hooks     *Hooks          `yaml:"hooks"`
	Uploads   []UploadEntry   `yaml:"uploads"`
	Notify    []NotifyEntry   `yaml:"notify"`
	Firewall  *Firewall       `yaml:"firewall"`
	Plugins   []PluginUse     `yaml:"plugins"`

	// Keys of the specification that arrive in later milestones. They are refused with a clear
	// message instead of being ignored.
	Routes  *yaml.Node `yaml:"routes"`
	Backups *yaml.Node `yaml:"backups"`
}

// PluginUse is one entry of plugins (ADR-0017): a built-in plugin's name, or the path of a
// directory of the project that holds a plugin.yml.
type PluginUse struct {
	Use  string         `yaml:"use" json:"use"`
	ID   string         `yaml:"id" json:"id,omitempty"`
	With map[string]any `yaml:"with" json:"with,omitempty"`
}

// Firewall is the firewall block (ADR-0014).
type Firewall struct {
	PublicPorts []PortEntry `yaml:"public_ports"`
}

// PortEntry is a public port: a number (tcp and udp, from anywhere), or a map.
type PortEntry struct {
	domain.PublicPort
}

// UnmarshalYAML reads 25565 or { port: 4326, protocol: tcp, from: [203.0.113.0/24] }.
func (p *PortEntry) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		return n.Decode(&p.Port)
	}
	var m struct {
		Port     int      `yaml:"port"`
		Protocol string   `yaml:"protocol"`
		From     []string `yaml:"from"`
	}
	if err := n.Decode(&m); err != nil {
		return err
	}
	p.PublicPort = domain.PublicPort{Port: m.Port, Protocol: m.Protocol, From: m.From}
	return nil
}

// Registry is an external registry (ADR-0009). Without it, images go to the server's own.
type Registry struct {
	URL            string   `yaml:"url"`
	Username       string   `yaml:"username"`
	Password       string   `yaml:"password"`
	AdditionalTags []string `yaml:"additional_tags"`
}

// Health is the health block: public checks, after the switch (ADR-0010).
type Health struct {
	StartupDelay string     `yaml:"startup_delay"`
	Endpoints    []Endpoint `yaml:"endpoints"`
}

// Endpoint is one public check.
type Endpoint struct {
	Name           string `yaml:"name"`
	URL            string `yaml:"url"`
	Method         string `yaml:"method"`
	ExpectedStatus int    `yaml:"expected_status"`
	Timeout        string `yaml:"timeout"`
	Retries        *int   `yaml:"retries"`
	RetryDelay     string `yaml:"retry_delay"`
	ValidateCerts  *bool  `yaml:"validate_certs"`
}

// NotifyEntry is one webhook.
type NotifyEntry struct {
	URL     string            `yaml:"url"`
	On      []string          `yaml:"on"`
	Secret  string            `yaml:"secret"`
	Headers map[string]string `yaml:"headers"`
	Timeout string            `yaml:"timeout"`
}

// UploadEntry is one entry of uploads (ADR-0021).
type UploadEntry struct {
	Src     string   `yaml:"src"`
	Dest    string   `yaml:"dest"`
	Mirror  bool     `yaml:"mirror"`
	Exclude []string `yaml:"exclude"`
	Mode    string   `yaml:"mode"`
	Owner   string   `yaml:"owner"`
	// Plugin and Bundle are set on an upload a plugin adds: src is a path of the bundle.
	Plugin string         `yaml:"-"`
	Bundle *render.Bundle `yaml:"-"`
}

// Hooks is the hooks block, per phase (ADR-0022).
type Hooks struct {
	BeforeBuild  []HookEntry `yaml:"before_build"`
	AfterBuild   []HookEntry `yaml:"after_build"`
	BeforeDeploy []HookEntry `yaml:"before_deploy"`
	AfterDeploy  []HookEntry `yaml:"after_deploy"`
	AfterFailure []HookEntry `yaml:"after_failure"`
}

// HookEntry is one hook: exactly one of run, script, host and exec.
type HookEntry struct {
	Name    string   `yaml:"name"`
	Run     string   `yaml:"run"`
	Script  string   `yaml:"script"`
	Host    string   `yaml:"host"`
	Exec    []string `yaml:"exec"`
	Service string   `yaml:"service"`
	Secrets []string `yaml:"secrets"`
	Timeout string   `yaml:"timeout"`
	Fatal   *bool    `yaml:"fatal"`
}

// TemplateEntry is one entry of templates: a path rendered in place, or src and dest.
type TemplateEntry struct {
	Src  string `yaml:"src"`
	Dest string `yaml:"dest"`
}

// UnmarshalYAML reads a plain path as a file rendered in place.
func (t *TemplateEntry) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		t.Src, t.Dest = n.Value, n.Value
		return nil
	}
	type plain TemplateEntry
	return n.Decode((*plain)(t))
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
	// StartupDelay is waited after the switch, before the public checks.
	StartupDelay time.Duration
	Endpoints    []domain.Endpoint
	Templates    []render.Template
	Hooks        []domain.Hook
	Uploads      []UploadEntry
	Notify       []notify.Webhook
	// PublicPorts are firewall.public_ports.
	PublicPorts []domain.PublicPort
	// Plugins are expanded into Uploads and Hooks once the variables are known.
	Plugins []PluginUse
}

// laterKeys are spec keys not available yet, with the milestone that brings them.
var laterKeys = map[string]string{
	"routes":  "M3",
	"backups": "M4",
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
				WithHint("run dockflow in the project directory, or pass it with -C")
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

// SecretsFile returns the SOPS file of an environment, relative to the project: secrets_file, or
// secrets/<env>.sops.yaml when it exists; empty without one (ADR-0012).
func (r *Raw) SecretsFile(env string) string {
	if e := r.file.Environments[env]; e != nil && e.SecretsFile != "" {
		return e.SecretsFile
	}
	def := filepath.Join("secrets", env+".sops.yaml")
	if _, err := os.Stat(filepath.Join(r.Dir, def)); err == nil {
		return def
	}
	return ""
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
	if err := (interpolation{lookup: lookup, env: env, overridden: r.overridden(env)}).node(node, nil); err != nil {
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
		if s.Health != nil {
			if err := res.readHealth(s.Health); err != nil {
				return nil, err
			}
		}
		if s.Hooks != nil {
			h, err := ParseHooks(s.Hooks)
			if err != nil {
				return nil, err
			}
			res.Hooks = h
		}
		if s.Firewall != nil {
			res.PublicPorts = nil
			for i, e := range s.Firewall.PublicPorts {
				pp := e.PublicPort
				switch {
				case pp.Port < 1 || pp.Port > 65535:
					return nil, errs.Config("firewall.public_ports[%d]: %d is not a port", i, pp.Port)
				case pp.Protocol != "" && pp.Protocol != "tcp" && pp.Protocol != "udp":
					return nil, errs.Config("firewall.public_ports[%d]: protocol must be tcp or udp, not %q", i, pp.Protocol)
				}
				for _, f := range pp.From {
					if _, err := netip.ParsePrefix(f); err != nil {
						if _, err := netip.ParseAddr(f); err != nil {
							return nil, errs.Config("firewall.public_ports[%d]: from %q is not an address or a CIDR", i, f)
						}
					}
				}
				res.PublicPorts = append(res.PublicPorts, pp)
			}
		}
		if s.Notify != nil {
			w, err := webhooks(s.Notify)
			if err != nil {
				return nil, err
			}
			res.Notify = w
		}
		if s.Uploads != nil {
			if err := CheckUploads(s.Uploads); err != nil {
				return nil, err
			}
			res.Uploads = s.Uploads
		}
		if s.Plugins != nil {
			res.Plugins = s.Plugins
		}
		if s.Templates != nil {
			t, err := templates(r.Dir, s.Templates)
			if err != nil {
				return nil, err
			}
			res.Templates = t
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

func webhooks(entries []NotifyEntry) ([]notify.Webhook, error) {
	out := make([]notify.Webhook, 0, len(entries))
	for i, e := range entries {
		at := fmt.Sprintf("notify[%d]", i)
		u, err := url.Parse(e.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, errs.Config("%s.url %q is not an http or https URL", at, e.URL)
		}
		for _, on := range e.On {
			if on != "success" && on != "failure" {
				return nil, errs.Config("%s.on: %q is not success or failure", at, on)
			}
		}
		w := notify.Webhook{URL: e.URL, On: e.On, Secret: e.Secret, Headers: e.Headers}
		if e.Timeout != "" {
			d, err := time.ParseDuration(e.Timeout)
			if err != nil || d <= 0 {
				return nil, errs.Config("%s.timeout %q is not a duration", at, e.Timeout)
			}
			w.Timeout = d
		}
		out = append(out, w)
	}
	return out, nil
}

// CheckUploads validates uploads, and that no two have the same destination.
func CheckUploads(entries []UploadEntry) error {
	dests := map[string]bool{}
	for i, u := range entries {
		at := fmt.Sprintf("uploads[%d]", i)
		if u.Plugin != "" {
			at = "plugin " + u.Plugin + ": " + at
		}
		clean := filepath.Clean(u.Src)
		if u.Src == "" || filepath.IsAbs(u.Src) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return errs.Config("%s.src %q must be a path inside the project", at, u.Src)
		}
		switch {
		case strings.HasPrefix(u.Dest, "volume:"):
			if key := strings.TrimPrefix(u.Dest, "volume:"); key == "" || strings.ContainsAny(key, "/:") {
				return errs.Config("%s.dest %q: volume:<name>, a volume of the Compose file", at, u.Dest)
			}
		case filepath.IsAbs(u.Dest) && !strings.Contains(u.Dest, ".."):
		default:
			return errs.Config("%s.dest %q must be volume:<name> or an absolute path on the server", at, u.Dest)
		}
		if dests[u.Dest] {
			return errs.Config("%s.dest %s is the destination of two uploads", at, u.Dest)
		}
		dests[u.Dest] = true
		if _, _, err := upload.ParseOwner(u.Owner); err != nil {
			return errs.Config("%s.owner: %v", at, err)
		}
		if u.Mode != "" {
			if _, err := strconv.ParseUint(u.Mode, 8, 32); err != nil {
				return errs.Config("%s.mode %q is not an octal mode like 644", at, u.Mode)
			}
		}
	}
	return nil
}

// ParseHooks validates the hooks block, and returns its hooks in phase order.
func ParseHooks(h *Hooks) ([]domain.Hook, error) {
	var out []domain.Hook
	phases := []struct {
		name    string
		entries []HookEntry
	}{
		{domain.HookBeforeBuild, h.BeforeBuild}, {domain.HookAfterBuild, h.AfterBuild},
		{domain.HookBeforeDeploy, h.BeforeDeploy}, {domain.HookAfterDeploy, h.AfterDeploy},
		{domain.HookAfterFailure, h.AfterFailure},
	}
	for _, ph := range phases {
		for i, e := range ph.entries {
			at := fmt.Sprintf("hooks.%s[%d]", ph.name, i)
			hk := domain.Hook{Phase: ph.name, Name: e.Name, Secrets: e.Secrets, Timeout: domain.Duration(5 * time.Minute),
				Fatal: strings.HasPrefix(ph.name, "before_")}
			kinds := 0
			if e.Run != "" {
				kinds++
				hk.Kind, hk.Command = domain.HookLocal, e.Run
			}
			if e.Script != "" {
				kinds++
				hk.Kind, hk.Script = domain.HookLocal, e.Script
			}
			if e.Host != "" {
				kinds++
				hk.Kind, hk.Command = domain.HookHost, e.Host
			}
			if len(e.Exec) > 0 {
				kinds++
				hk.Kind, hk.Exec, hk.Service = domain.HookExec, e.Exec, e.Service
				if e.Service == "" {
					return nil, errs.Config("%s: exec needs the service to run in", at)
				}
				if ph.name == domain.HookBeforeBuild || ph.name == domain.HookAfterBuild {
					return nil, errs.Config("%s: exec hooks run in containers, from before_deploy on", at)
				}
			} else if e.Service != "" {
				return nil, errs.Config("%s: service goes with exec", at)
			}
			if kinds != 1 {
				return nil, errs.Config("%s: set exactly one of run, script, host and exec", at)
			}
			if hk.Name == "" {
				hk.Name = hookName(hk)
			}
			for _, k := range e.Secrets {
				if !domain.KeyName.MatchString(k) {
					return nil, errs.Config("%s: secret %q must match %s", at, k, domain.KeyName)
				}
			}
			if e.Timeout != "" {
				d, err := time.ParseDuration(e.Timeout)
				if err != nil || d <= 0 {
					return nil, errs.Config("%s.timeout %q is not a duration", at, e.Timeout)
				}
				hk.Timeout = domain.Duration(d)
			}
			if e.Fatal != nil {
				hk.Fatal = *e.Fatal
			}
			out = append(out, hk)
		}
	}
	return out, nil
}

func hookName(h domain.Hook) string {
	s := h.Command
	switch {
	case h.Script != "":
		s = h.Script
	case len(h.Exec) > 0:
		s = h.Service + ": " + strings.Join(h.Exec, " ")
	}
	if len(s) > 40 {
		s = s[:37] + "…"
	}
	return s
}

func templates(dir string, entries []TemplateEntry) ([]render.Template, error) {
	out := make([]render.Template, 0, len(entries))
	for i, e := range entries {
		if e.Dest == "" {
			e.Dest = e.Src
		}
		for _, p := range []string{e.Src, e.Dest} {
			clean := filepath.Clean(p)
			if p == "" || filepath.IsAbs(p) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
				return nil, errs.Config("templates[%d]: %q must be a path inside the project", i, p)
			}
		}
		if fi, err := os.Stat(filepath.Join(dir, e.Src)); err != nil || fi.IsDir() {
			return nil, errs.Config("templates[%d]: %s is not a file of the project", i, e.Src)
		}
		out = append(out, render.Template{Src: filepath.Clean(e.Src), Dest: filepath.Clean(e.Dest)})
	}
	return out, nil
}

func (res *Resolved) readHealth(h *Health) error {
	res.StartupDelay, res.Endpoints = 0, nil
	if h.StartupDelay != "" {
		d, err := time.ParseDuration(h.StartupDelay)
		if err != nil || d < 0 {
			return errs.Config("health.startup_delay %q is not a duration", h.StartupDelay)
		}
		res.StartupDelay = d
	}
	durations := func(at, s string, def time.Duration) (domain.Duration, error) {
		if s == "" {
			return domain.Duration(def), nil
		}
		d, err := time.ParseDuration(s)
		if err != nil || d <= 0 {
			return 0, errs.Config("%s %q is not a duration", at, s)
		}
		return domain.Duration(d), nil
	}
	for i, e := range h.Endpoints {
		at := fmt.Sprintf("health.endpoints[%d]", i)
		u, err := url.Parse(e.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return errs.Config("%s.url %q is not an http or https URL", at, e.URL)
		}
		ep := domain.Endpoint{Name: e.Name, URL: e.URL, Method: strings.ToUpper(e.Method), ExpectedStatus: e.ExpectedStatus,
			Retries: 3, ValidateCerts: true}
		if ep.Name == "" {
			ep.Name = u.Host + u.Path
		}
		if ep.Method == "" {
			ep.Method = http.MethodGet
		}
		if ep.ExpectedStatus == 0 {
			ep.ExpectedStatus = http.StatusOK
		}
		if e.Retries != nil {
			if *e.Retries < 1 {
				return errs.Config("%s.retries must be at least 1", at)
			}
			ep.Retries = *e.Retries
		}
		if e.ValidateCerts != nil {
			ep.ValidateCerts = *e.ValidateCerts
		}
		if ep.Timeout, err = durations(at+".timeout", e.Timeout, 30*time.Second); err != nil {
			return err
		}
		if ep.RetryDelay, err = durations(at+".retry_delay", e.RetryDelay, 5*time.Second); err != nil {
			return err
		}
		res.Endpoints = append(res.Endpoints, ep)
	}
	return nil
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
	case res.Build.Builder == "remote" && res.Build.Engine == "podman":
		return errs.Config("build.engine: podman builds on this machine; build.builder: remote builds with the server's Docker").
			WithHint("choose one of them")
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
	// port and user default once ~/.ssh/config is read (connection.Resolve)
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
		if ms, ok := laterKeys[key]; ok {
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

// interpolation replaces ${VAR} in the string scalars env uses. Mapping keys are never
// interpolated, and neither are the app name, vars or hook commands (ADR-0022: they get values
// as environment variables). Other environments, and the top-level keys env overrides, are left
// alone: their variables need not exist for env.
type interpolation struct {
	lookup     Lookup
	env        string
	overridden map[string]bool
}

func (in interpolation) node(n *yaml.Node, path []string) error {
	switch n.Kind {
	case yaml.DocumentNode, yaml.SequenceNode:
		for _, c := range n.Content {
			if err := in.node(c, path); err != nil {
				return err
			}
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			key := n.Content[i].Value
			p := append(append([]string{}, path...), key)
			if in.skip(p) {
				continue
			}
			if err := in.node(n.Content[i+1], p); err != nil {
				return err
			}
		}
	case yaml.ScalarNode:
		if n.Tag != "!!str" && n.Tag != "" {
			return nil
		}
		out, err := Interpolate(n.Value, in.lookup)
		if err != nil {
			return errs.Config("%s: %s: %s", FileName, strings.Join(path, "."), err.Error()).
				WithHint("define it under environments.<env>.vars or as a secret, or write ${NAME:-default}")
		}
		n.Value = out
	}
	return nil
}

func (in interpolation) skip(p []string) bool {
	switch {
	case len(p) == 1:
		return p[0] == "app" || p[0] == "version" || in.overridden[p[0]]
	case p[0] == "environments" && len(p) >= 2 && p[1] != in.env:
		return true
	case p[0] == "environments" && len(p) == 3:
		return p[2] == "vars"
	}
	// hook commands: hooks.<phase>[i].run|host|exec, at the top level or in the environment
	hook := p
	if p[0] == "environments" && len(p) > 2 {
		hook = p[2:]
	}
	return len(hook) == 3 && hook[0] == "hooks" && (hook[2] == "run" || hook[2] == "host" || hook[2] == "exec")
}

// PluginUses returns the use of each plugin entry, at the top level and in every environment,
// once each, as written.
func (r *Raw) PluginUses() []string {
	seen := map[string]bool{}
	var out []string
	add := func(uses []PluginUse) {
		for _, u := range uses {
			if u.Use != "" && !seen[u.Use] {
				seen[u.Use] = true
				out = append(out, u.Use)
			}
		}
	}
	add(r.file.Plugins)
	for _, name := range r.EnvNames() {
		if e := r.file.Environments[name]; e != nil {
			add(e.Plugins)
		}
	}
	return out
}

// overridden are the top-level keys env sets itself.
func (r *Raw) overridden(env string) map[string]bool {
	out := map[string]bool{}
	doc := &r.root
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		doc = doc.Content[0]
	}
	envs := mapValue(doc, "environments")
	if envs == nil {
		return out
	}
	e := mapValue(envs, env)
	if e == nil || e.Kind != yaml.MappingNode {
		return out
	}
	for i := 0; i+1 < len(e.Content); i += 2 {
		out[e.Content[i].Value] = true
	}
	return out
}

func mapValue(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}
