// Package project resolves everything Dockflow knows about one environment of a project before
// talking to a server: dockflow.yml, secrets, variables and the Compose files, converted to the
// desired state.
package project

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/Shawiizz/dockflow/internal/compose"
	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/image"
	"github.com/Shawiizz/dockflow/internal/secrets"
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
}

// Loaded is an environment, ready to plan.
type Loaded struct {
	Raw      *config.Raw
	Config   *config.Resolved
	Secrets  *secrets.Store
	App      domain.App
	Builds   []image.Build
	Builtins map[string]string
	Warnings []string
	Version  string
	Git      Git
}

// Read parses dockflow.yml and picks the environment, without loading Compose or secrets.
func Read(dir, env string) (*config.Raw, string, error) {
	raw, err := config.Read(dir)
	if err != nil {
		return nil, "", err
	}
	name, err := raw.PickEnv(env)
	if err != nil {
		return nil, "", err
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
	stack := domain.Stack(cfg.App, env)
	proj, err := compose.Load(ctx, o.Dir, stack, cfg.Compose, cfg.Profiles, compose.Variables{Lookup: lookup, All: all})
	if err != nil {
		return nil, err
	}
	res, err := compose.Convert(proj, cfg.App, env)
	if err != nil {
		return nil, err
	}
	return &Loaded{
		Raw: raw, Config: cfg, Secrets: store, App: res.App, Builds: res.Builds, Builtins: builtins,
		Warnings: res.Warnings, Version: version, Git: o.Git,
	}, nil
}
