// Package project resolves everything Dockflow knows about one environment of a project before
// talking to a server: dockflow.yml, secrets, variables and the Compose files, converted to the
// desired state.
package project

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Shawiizz/dockflow/internal/compose"
	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/image"
	"github.com/Shawiizz/dockflow/internal/plugin"
	"github.com/Shawiizz/dockflow/internal/secrets"
	"github.com/Shawiizz/dockflow/internal/sopsfile"
)

// Git describes the working tree a deploy is made from.
type Git struct {
	SHA    string
	Branch string
	Dirty  bool
}

// ReadGit reads the git state of dir. Outside a repository it returns an empty Git.
func ReadGit(dir string) Git {
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	g := Git{SHA: run("rev-parse", "HEAD"), Branch: run("rev-parse", "--abbrev-ref", "HEAD")}
	if g.Branch == "HEAD" {
		// a detached checkout
		g.Branch = ""
	}
	if g.SHA != "" {
		g.Dirty = run("status", "--porcelain") != ""
	}
	return g
}

// VersionLabel is the default version label of a release: the short commit, -dirty when the
// tree has changes, empty outside git (the agent then uses r<seq>).
func (g Git) VersionLabel() string {
	if len(g.SHA) < 7 {
		return ""
	}
	v := g.SHA[:7]
	if g.Dirty {
		v += "-dirty"
	}
	return v
}

// Options are the inputs of Load.
type Options struct {
	Dir     string // the project directory, holding dockflow.yml
	Env     string // as typed: a name or a unique prefix
	Version string // --version; empty for the default label
	Environ []string
	Git     Git
	// Server is the name of the environment's server, known once the connection is resolved.
	Server string
	// ConfigOnly stops after dockflow.yml: no plugins, no Compose files, so none of the
	// variables they use is needed. Commands that act on what the server already runs use it.
	ConfigOnly bool
}

// Loaded is an environment, ready to plan.
type Loaded struct {
	Raw      *config.Raw
	Config   *config.Resolved
	Secrets  *secrets.Store
	App      domain.App
	Builds   []image.Build
	Builtins map[string]string
	// Values are every variable templates see: built-ins, secrets and vars.
	Values   map[string]string
	Warnings []string
	Version  string
	Git      Git
	// Files are the files read: dockflow.yml, the Compose files and the local secrets file.
	Files []string
	// FileContents are the contents of the Compose secrets and configs, by server path; secret
	// ones are in FileSecrets too, to mask.
	FileContents map[string]string
	FileSecrets  []string
}

// unlistedPorts warns about ports published on every interface that firewall.public_ports does
// not list: the port filter drops them from outside (ADR-0014).
func unlistedPorts(a *domain.App) []string {
	listed := map[string]bool{}
	for _, p := range a.PublicPorts {
		for _, proto := range []string{"tcp", "udp"} {
			if p.Protocol == "" || p.Protocol == proto {
				listed[fmt.Sprintf("%d/%s", p.Port, proto)] = true
			}
		}
	}
	var out []string
	for _, s := range a.Services {
		for _, p := range s.Spec.Ports {
			if p.HostPort == "" || (p.HostIP != "" && p.HostIP != "0.0.0.0" && p.HostIP != "::") {
				continue
			}
			if !listed[p.HostPort+"/"+p.Protocol] {
				out = append(out, fmt.Sprintf("service %s: port %s/%s is published on every interface, but firewall.public_ports does not list it: the port filter drops it from outside. Write 127.0.0.1:%s:%d to keep it on the server, or list it",
					s.Name, p.HostPort, p.Protocol, p.HostPort, p.ContainerPort))
			}
		}
	}
	return out
}

// ReadSecretsFile decrypts an environment's SOPS file, in memory, with the age keys sops would
// use (SOPS_AGE_KEY, SOPS_AGE_KEY_FILE, the user's keys file).
func ReadSecretsFile(dir, file string, environ []string) (map[string]string, error) {
	data, err := os.ReadFile(filepath.Join(dir, file))
	if err != nil {
		return nil, errs.Config("cannot read the secrets file %s", file).WithCause(err)
	}
	ids, err := sopsfile.Identities(lookupIn(environ))
	if err != nil {
		return nil, errs.Config("the age key: %v", err)
	}
	f, err := sopsfile.Decrypt(data, ids)
	if err != nil {
		return nil, errs.Newf("secrets.file", errs.ExitConfig, "cannot decrypt %s: %v", file, err).
			WithHint("give the age key with SOPS_AGE_KEY in CI, or in %s on your machine", sopsfile.DefaultKeyFile())
	}
	for _, k := range f.Keys {
		if !keyName.MatchString(k) {
			return nil, errs.Config("%s: the key %q must match %s", file, k, keyName)
		}
	}
	return f.Values, nil
}

var keyName = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

func lookupIn(environ []string) func(string) string {
	return func(key string) string {
		for _, kv := range environ {
			if k, v, ok := strings.Cut(kv, "="); ok && k == key {
				return v
			}
		}
		return ""
	}
}

// Read parses dockflow.yml and picks the environment, without loading Compose or secrets.
func Read(dir, env string) (*config.Raw, string, error) {
	raw, err := config.Read(dir)
	if err != nil {
		return nil, "", err
	}
	name, err := raw.PickEnv(env)
	if err != nil {
		// the file is still read: callers that do not need an environment use it
		return raw, "", err
	}
	return raw, name, nil
}

// Load resolves an environment.
func Load(ctx context.Context, o Options) (*Loaded, error) {
	raw, env, err := Read(o.Dir, o.Env)
	if err != nil {
		return nil, err
	}
	store, err := secrets.Load(env, o.Dir, o.Environ)
	if err != nil {
		return nil, err
	}
	if file := raw.SecretsFile(env); file != "" {
		values, err := ReadSecretsFile(o.Dir, file, o.Environ)
		if err != nil {
			return nil, err
		}
		store.AddFile(file, values)
	}
	version := o.Version
	if version == "" {
		version = o.Git.VersionLabel()
	}
	if version == "" {
		// not a git checkout: the time of the deploy
		version = time.Now().UTC().Format("20060102-150405")
	}
	server := o.Server
	if server == "" {
		server = "main"
	}
	builtins := map[string]string{
		"DOCKFLOW_APP":        raw.App(),
		"DOCKFLOW_ENV":        env,
		"DOCKFLOW_STACK":      domain.Stack(raw.App(), env),
		"DOCKFLOW_VERSION":    version,
		"DOCKFLOW_GIT_SHA":    o.Git.SHA,
		"DOCKFLOW_GIT_BRANCH": o.Git.Branch,
		"DOCKFLOW_SERVER":     server,
	}
	vars := raw.Vars(env)
	lookup := func(name string) (string, bool) {
		if v, ok := builtins[name]; ok {
			return v, true
		}
		if v, ok := store.Lookup(name); ok {
			return v, true
		}
		v, ok := vars[name]
		return v, ok
	}

	cfg, err := raw.Resolve(env, lookup)
	if err != nil {
		return nil, err
	}
	if o.ConfigOnly {
		files := []string{config.FileName}
		if _, err := os.Stat(filepath.Join(o.Dir, secrets.LocalFile)); err == nil {
			files = append(files, secrets.LocalFile)
		}
		return &Loaded{Raw: raw, Config: cfg, Secrets: store, App: domain.App{Name: cfg.App, Env: env, Stack: domain.Stack(cfg.App, env)},
			Builtins: builtins, Version: version, Git: o.Git, Files: files}, nil
	}

	all := map[string]string{}
	for k, v := range vars {
		all[k] = v
	}
	for _, k := range store.Keys() {
		if v, ok := store.Lookup(k); ok {
			all[k] = v
		}
	}
	for k, v := range builtins {
		all[k] = v
	}
	if len(cfg.Plugins) > 0 {
		public := map[string]string{}
		for k, v := range vars {
			public[k] = v
		}
		for k, v := range builtins {
			public[k] = v
		}
		e, err := plugin.Expand(o.Dir, cfg.Plugins, plugin.Values{Public: public, All: all})
		if err != nil {
			return nil, err
		}
		// the plugins' first: a vhost is reloaded before the project's own after_deploy hooks
		cfg.Uploads = append(e.Uploads, cfg.Uploads...)
		cfg.Hooks = append(e.Hooks, cfg.Hooks...)
		if err := config.CheckUploads(cfg.Uploads); err != nil {
			return nil, err
		}
	}
	stack := domain.Stack(cfg.App, env)
	proj, err := compose.Load(ctx, o.Dir, stack, cfg.Compose, cfg.Profiles, compose.Variables{Lookup: lookup, All: all})
	if err != nil {
		return nil, err
	}
	res, err := compose.Convert(proj, o.Dir, cfg.App, env)
	if err != nil {
		return nil, err
	}
	res.App.PublicPorts = cfg.PublicPorts
	if err := appRoutes(cfg.Routes, &res.App); err != nil {
		return nil, err
	}
	res.Warnings = append(res.Warnings, unlistedPorts(&res.App)...)
	files := []string{config.FileName}
	for _, f := range proj.ComposeFiles {
		if rel, err := filepath.Rel(o.Dir, f); err == nil {
			f = rel
		}
		files = append(files, f)
	}
	if _, err := os.Stat(filepath.Join(o.Dir, secrets.LocalFile)); err == nil {
		files = append(files, secrets.LocalFile)
	}
	return &Loaded{
		Raw: raw, Config: cfg, Secrets: store, App: res.App, Builds: res.Builds, Builtins: builtins, Values: all,
		Warnings: res.Warnings, Version: version, Git: o.Git, Files: files,
		FileContents: res.Contents, FileSecrets: res.Secrets,
	}, nil
}
