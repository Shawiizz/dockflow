package cli

import (
	"context"
	"errors"
	"io"
	"os"
	"os/user"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/connection"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/engine/docker"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/hooks"
	"github.com/Shawiizz/dockflow/internal/launcher"
	"github.com/Shawiizz/dockflow/internal/project"
	"github.com/Shawiizz/dockflow/internal/version"
)

// session is a loaded environment and a connection to its server.
type session struct {
	app      *app
	loaded   *project.Loaded
	target   *connection.Target
	ssh      *ssh.Client
	engine   *docker.Engine
	info     engine.Info
	launcher *launcher.Launcher
	run      string
}

// load reads the project for env (as typed) without reaching the server.
func (a *app) load(ctx context.Context, env, versionFlag string) (*project.Loaded, error) {
	dir := a.dir
	git := project.ReadGit(dir)
	if versionFlag == "" {
		versionFlag = ciVersion()
	}
	o := project.Options{Dir: dir, Env: env, Version: versionFlag, Environ: os.Environ(), Git: git}
	l, err := project.Load(ctx, o)
	if err != nil {
		return nil, err
	}
	a.emitter.Masker().Add(l.Secrets.Values()...)
	return l, nil
}

// connect loads env and opens a connection to its server.
func (a *app) connect(ctx context.Context, env, versionFlag string) (*session, error) {
	l, err := a.load(ctx, env, versionFlag)
	if err != nil {
		return nil, err
	}
	t, err := connection.Resolve(l.Config.Env, l.Config, l.Secrets.Lookup, a.connection, os.Getenv)
	if err != nil {
		return nil, err
	}
	if t.Server.Name != "main" {
		// DOCKFLOW_SERVER is known now
		o := project.Options{Dir: a.dir, Env: l.Config.Env, Version: l.Version, Environ: os.Environ(), Git: l.Git, Server: t.Server.Name}
		if l, err = project.Load(ctx, o); err != nil {
			return nil, err
		}
	}
	a.emitter.Masker().Add(t.PrivateKey, t.Password)
	s, err := a.dial(ctx, t)
	if err != nil {
		return nil, err
	}
	s.loaded = l
	return s, nil
}

func (a *app) dial(ctx context.Context, t *connection.Target) (*session, error) {
	c, err := connection.Dial(ctx, t)
	if err != nil {
		return nil, err
	}
	eng, err := docker.New(connection.DockerDialer(c))
	if err != nil {
		c.Close()
		return nil, err
	}
	info, err := eng.Info(ctx)
	if err != nil {
		eng.Close()
		c.Close()
		return nil, err
	}
	if err := checkEngine(info); err != nil {
		eng.Close()
		c.Close()
		return nil, err
	}
	return &session{
		app: a, target: t, ssh: c, engine: eng, info: info,
		launcher: &launcher.Launcher{Engine: eng, Info: info, Version: version.Version, Events: a.emitter},
		run:      launcher.NewRunID(time.Now()),
	}, nil
}

func (s *session) Close() {
	s.engine.Close()
	s.ssh.Close()
}

// request returns an agent request for the session's environment.
func (s *session) request(op string) agent.Request {
	l := s.loaded
	req := agent.Request{
		Op: op, Run: s.run, App: l.Config.App, Env: l.Config.Env, Stack: domain.Stack(l.Config.App, l.Config.Env),
		Server: s.target.Server.Name, Author: author(), Version: l.Version,
		Source:          domain.Source{GitSHA: l.Git.SHA, Branch: l.Git.Branch, Dirty: l.Git.Dirty},
		DockflowVersion: version.Version, Keep: l.Config.Keep, OnFailure: l.Config.OnFailure,
		Timeout: domain.Duration(l.Config.Timeout), Mask: l.Secrets.Values(), RegistryAuth: registryAuth(l),
		Endpoints: l.Config.Endpoints, StartupDelay: domain.Duration(l.Config.StartupDelay),
	}
	return req
}

// runAgent runs req on the server and returns its result, mapping a failed run to its exit code.
func (s *session) runAgent(ctx context.Context, req agent.Request) (*launcher.Result, error) {
	s.app.agentRunning.Store(true)
	res, err := s.launcher.Run(ctx, req, s.app.interrupts)
	s.app.agentRunning.Store(false)
	if err != nil {
		return nil, err
	}
	if !s.app.json {
		s.app.human.finish(res.RunFinishedData)
	}
	if res.ExitCode != 0 {
		return res, &errs.Error{Code: errCode(res.Error), Exit: res.ExitCode, Message: errMessage(res.Error), Hint: errHint(res.Error), Reported: true}
	}
	return res, nil
}

func errCode(e *events.ErrorData) string {
	if e == nil {
		return "run.failed"
	}
	return e.Code
}

func errMessage(e *events.ErrorData) string {
	if e == nil {
		return "the run failed"
	}
	return e.Message
}

func errHint(e *events.ErrorData) string {
	if e == nil {
		return ""
	}
	return e.Hint
}

func author() domain.Author {
	a := domain.Author{User: os.Getenv("USER")}
	if u, err := user.Current(); err == nil && u.Username != "" {
		a.User = u.Username
	}
	a.Machine, _ = os.Hostname()
	switch {
	case os.Getenv("GITHUB_ACTIONS") == "true":
		a.CI = "github"
		a.User = os.Getenv("GITHUB_ACTOR")
	case os.Getenv("GITLAB_CI") == "true":
		a.CI = "gitlab"
		a.User = os.Getenv("GITLAB_USER_LOGIN")
	case os.Getenv("CI") != "":
		a.CI = "ci"
	}
	return a
}

// ciTag returns the tag a CI run was started for, if any.
func ciTag() string {
	if os.Getenv("GITHUB_REF_TYPE") == "tag" {
		return os.Getenv("GITHUB_REF_NAME")
	}
	return os.Getenv("CI_COMMIT_TAG")
}

// ciVersion is the version label of a CI run started for a tag: the tag without its suffix.
func ciVersion() string {
	tag := ciTag()
	if tag == "" {
		return ""
	}
	if i := strings.LastIndex(tag, "-"); i > 0 {
		return tag[:i]
	}
	return tag
}

// envFromTag picks the environment of a CI tag: 1.2.0 is the environment without a tag
// suffix, 1.2.0-staging the one whose suffix is staging.
func (a *app) envFromTag() (string, error) {
	tag := ciTag()
	if tag == "" {
		return "", nil
	}
	raw, _, err := project.Read(a.dir, "")
	if err != nil && raw == nil {
		return "", err
	}
	suffix := ""
	if i := strings.LastIndex(tag, "-"); i > 0 {
		suffix = tag[i+1:]
	}
	for _, env := range raw.EnvNames() {
		if raw.TagSuffix(env) == suffix {
			return env, nil
		}
	}
	return "", errs.Usage("the tag %s names no environment (suffix %q)", tag, suffix).
		WithHint("set ci.tag_suffix on an environment, or name the environment")
}

// minDocker is the oldest Docker Engine Dockflow supports (ADR-0003).
const minDocker = 27

func checkEngine(info engine.Info) error {
	if info.OS != "" && info.OS != "linux" {
		return errs.Connect("the server's Docker runs %s containers; Dockflow deploys Linux containers", info.OS)
	}
	major, _, _ := strings.Cut(info.EngineVersion, ".")
	if n, err := strconv.Atoi(major); err == nil && n < minDocker {
		return errs.Newf("server.docker_too_old", errs.ExitConnect, "the server runs Docker %s; Dockflow needs Docker %d or later", info.EngineVersion, minDocker).
			WithHint("upgrade Docker on the server")
	}
	return nil
}

// hooks returns the project's hooks with their environments.
func (s *session) hooks() ([]domain.Hook, error) {
	l := s.loaded
	out := make([]domain.Hook, 0, len(l.Config.Hooks))
	for _, h := range l.Config.Hooks {
		env, err := hooks.Env(h, l.Builtins, l.Config.Vars, l.Secrets.Lookup)
		if err != nil {
			return nil, err
		}
		h.Env = env
		out = append(out, h)
	}
	return out, nil
}

func (s *session) hookRunner() *hooks.Runner {
	return &hooks.Runner{Dir: s.loaded.Config.Dir, Events: s.app.emitter, Host: s.hostScript}
}

// hostScript runs a script on the server with `sh -s`, feeding it on stdin.
func (s *session) hostScript(ctx context.Context, script string, out io.Writer) (int, error) {
	sess, err := s.ssh.NewSession()
	if err != nil {
		return -1, errs.Connect("cannot open an SSH session").WithCause(err)
	}
	defer sess.Close()
	sess.Stdin = strings.NewReader(script)
	sess.Stdout, sess.Stderr = out, out
	done := make(chan error, 1)
	go func() { done <- sess.Run("sh -s") }()
	select {
	case <-ctx.Done():
		_ = sess.Signal(ssh.SIGKILL)
		return -1, ctx.Err()
	case err := <-done:
		var exit *ssh.ExitError
		if errors.As(err, &exit) {
			return exit.ExitStatus(), nil
		}
		if err != nil {
			return -1, err
		}
		return 0, nil
	}
}

// execHooks keeps the hooks the agent runs: those inside containers.
func execHooks(all []domain.Hook) []domain.Hook {
	var out []domain.Hook
	for _, h := range all {
		if h.Kind == domain.HookExec {
			out = append(out, h)
		}
	}
	return out
}
