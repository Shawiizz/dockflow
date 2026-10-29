package cli

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/ci"
	"github.com/Shawiizz/dockflow/internal/connection"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/engine/docker"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/hooks"
	"github.com/Shawiizz/dockflow/internal/ignore"
	"github.com/Shawiizz/dockflow/internal/launcher"
	"github.com/Shawiizz/dockflow/internal/notify"
	"github.com/Shawiizz/dockflow/internal/project"
	"github.com/Shawiizz/dockflow/internal/render"
	"github.com/Shawiizz/dockflow/internal/upload"
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
	// detach returns from the next agent run once it has its input.
	detach bool

	ws *render.Workspace
	// manifests and blobs are the uploads' manifests and where each blob is read.
	manifests map[string]upload.Manifest
	blobs     map[string]string
	// payload, when set, follows the next agent request on its stdin.
	payload func(io.Writer) error
}

// load reads the project for env (as typed) without reaching the server.
func (a *app) load(ctx context.Context, env, versionFlag string) (*project.Loaded, error) {
	return a.loadProject(ctx, env, versionFlag, false)
}

// loadProject is load; configOnly reads dockflow.yml alone (project.Options.ConfigOnly).
func (a *app) loadProject(ctx context.Context, env, versionFlag string, configOnly bool) (*project.Loaded, error) {
	dir := a.dir
	git := project.ReadGit(dir)
	if a.branch != "" {
		git.Branch = a.branch
	}
	// CI checkouts are often detached and shallow: the provider knows the branch and commit
	if run := ci.Detect(os.Getenv); run.Provider != "" {
		if git.Branch == "" {
			git.Branch = run.Branch
		}
		if git.SHA == "" {
			git.SHA = run.SHA
		}
	}
	if versionFlag == "" {
		versionFlag = ciVersion()
	}
	o := project.Options{Dir: dir, Env: env, Version: versionFlag, Environ: os.Environ(), Git: git, ConfigOnly: configOnly,
		Mask: a.emitter.Masker().Add}
	l, err := project.Load(ctx, o)
	if err != nil {
		return nil, err
	}
	a.emitter.Masker().Add(l.FileSecrets...)
	return l, nil
}

// connect loads env and opens a connection to its server.
func (a *app) connect(ctx context.Context, env, versionFlag string) (*session, error) {
	return a.connectProject(ctx, env, versionFlag, false)
}

// attach opens a connection to env's server for a command that acts on what the server already
// runs: it reads dockflow.yml alone, so the variables of the Compose files are not needed.
func (a *app) attach(ctx context.Context, env string) (*session, error) {
	return a.connectProject(ctx, env, "", true)
}

func (a *app) connectProject(ctx context.Context, env, versionFlag string, configOnly bool) (*session, error) {
	l, err := a.loadProject(ctx, env, versionFlag, configOnly)
	if err != nil {
		return nil, err
	}
	t, err := connection.Resolve(l.Config.Env, l.Config, l.Secrets.Lookup, a.connection, os.Getenv)
	if err != nil {
		return nil, err
	}
	if t.Server.Name != "main" {
		// DOCKFLOW_SERVER is known now
		o := project.Options{Dir: a.dir, Env: l.Config.Env, Version: l.Version, Environ: os.Environ(), Git: l.Git, Server: t.Server.Name, ConfigOnly: configOnly, Mask: a.emitter.Masker().Add}
		if l, err = project.Load(ctx, o); err != nil {
			return nil, err
		}
	}
	a.emitter.Masker().Add(t.PrivateKey, t.Password)
	names := make([]string, 0, len(l.App.Services))
	for _, svc := range l.App.Services {
		names = append(names, svc.Name)
	}
	a.emitter.Debug(events.ConfigLoaded, fmt.Sprintf("%s: %d services", l.Config.Env, len(names)), map[string]any{"files": l.Files, "services": names})
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
	if s.ws != nil {
		s.ws.Close()
	}
	s.engine.Close()
	s.ssh.Close()
}

// workspace is the session's rendered copy of the build contexts and upload sources.
func (s *session) workspace() (*render.Workspace, error) {
	if s.ws == nil {
		ws, err := workspace(s.loaded)
		if err != nil {
			return nil, err
		}
		s.ws = ws
	}
	return s.ws, nil
}

// prepareUploads describes each upload source by its manifest, and adds the uploads to the
// desired app (ADR-0021).
func (s *session) prepareUploads() error {
	l := s.loaded
	if len(l.Config.Uploads) == 0 || s.manifests != nil {
		return nil
	}
	ws, err := s.workspace()
	if err != nil {
		return err
	}
	s.manifests, s.blobs = map[string]upload.Manifest{}, map[string]string{}
	for _, e := range l.Config.Uploads {
		src := ws.Path(filepath.Join(l.Config.Dir, e.Src))
		if e.Bundle != nil {
			dir, err := ws.Bundle(e.Bundle)
			if err != nil {
				return err
			}
			src = filepath.Join(dir, e.Src)
		}
		m, paths, err := upload.Scan(src, ignore.New(e.Exclude))
		if err != nil {
			return errs.Config("uploads: cannot read %s", e.Src).WithCause(err)
		}
		u := domain.Upload{Dest: e.Dest, Mirror: e.Mirror, Mode: e.Mode, Owner: e.Owner, Manifest: m.Digest(), Plugin: e.Plugin}
		if key, ok := strings.CutPrefix(e.Dest, "volume:"); ok {
			for _, v := range l.App.Volumes {
				if v.Key == key {
					u.Volume = v.Name
				}
			}
			if u.Volume == "" {
				return errs.Config("uploads: %s names no volume of the Compose file", e.Dest).
					WithHint("declare it under volumes: in the Compose file")
			}
		}
		l.App.Uploads = append(l.App.Uploads, u)
		s.manifests[u.Manifest] = *m
		for sum, p := range paths {
			s.blobs[sum] = p
		}
	}
	return nil
}

// sendUploads asks the agent which files it lacks, and sends them with req.
func (s *session) sendUploads(ctx context.Context, req *agent.Request) error {
	if len(s.manifests) == 0 {
		return nil
	}
	sums := make([]string, 0, len(s.blobs))
	for sum := range s.blobs {
		sums = append(sums, sum)
	}
	sort.Strings(sums)
	ask := s.request(agent.OpUploadHave)
	ask.Have = sums
	s.run = launcher.NewRunID(timeNow())
	res, err := s.runAgent(ctx, ask)
	if err != nil {
		return err
	}
	var have struct {
		Missing []string `json:"missing"`
	}
	if len(res.Results) > 0 {
		_ = json.Unmarshal(res.Results[len(res.Results)-1], &have)
	}
	s.run = launcher.NewRunID(timeNow())
	req.Run = s.run
	req.Manifests, req.Blobs = s.manifests, len(have.Missing)
	missing := have.Missing
	var total int64
	for _, sum := range missing {
		if st, err := os.Stat(s.blobs[sum]); err == nil {
			total += st.Size()
		}
	}
	s.payload = func(w io.Writer) error {
		tw := tar.NewWriter(w)
		var sent int64
		last := time.Time{}
		for i, sum := range missing {
			path, ok := s.blobs[sum]
			if !ok {
				return fmt.Errorf("no local file for %s", sum)
			}
			n, err := addFile(tw, path, sum)
			if err != nil {
				return err
			}
			sent += n
			// every destination's files go together: at most once a second, and at the end
			if now := timeNow(); now.Sub(last) >= time.Second || i == len(missing)-1 {
				last = now
				s.app.emitter.Debug(events.UploadProgress, fmt.Sprintf("%d of %d files sent (%s of %s)", i+1, len(missing), humanBytes(uint64(sent)), humanBytes(uint64(total))),
					map[string]any{"files_sent": i + 1, "files_total": len(missing), "bytes_sent": sent, "bytes_total": total})
			}
		}
		return tw.Close()
	}
	s.app.emitter.Info(events.Log, fmt.Sprintf("uploading %d of %d files", len(missing), len(sums)), map[string]any{"line": "upload"})
	return nil
}

// addFile writes the file at path into tw under name, and returns its size.
func addFile(tw *tar.Writer, path, name string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: st.Size(), Typeflag: tar.TypeReg}); err != nil {
		return 0, err
	}
	return io.Copy(tw, f)
}

// request returns an agent request for the session's environment.
func (s *session) request(op string) agent.Request {
	l := s.loaded
	req := agent.Request{
		Op: op, Run: s.run, App: l.Config.App, Env: l.Config.Env, Stack: domain.Stack(l.Config.App, l.Config.Env),
		Server: s.target.Server.Name, Author: author(), Version: l.Version,
		Source:          domain.Source{GitSHA: l.Git.SHA, Branch: l.Git.Branch, Dirty: l.Git.Dirty},
		DockflowVersion: version.Version, Keep: l.Config.Keep, OnFailure: l.Config.OnFailure,
		Timeout: domain.Duration(l.Config.Timeout), Mask: append(l.Secrets.Values(), l.FileSecrets...), RegistryAuth: registryAuth(l),
		Files:     l.FileContents,
		Endpoints: l.Config.Endpoints, StartupDelay: domain.Duration(l.Config.StartupDelay),
	}
	return req
}

// runAgent runs req on the server and returns its result, mapping a failed run to its exit code.
func (s *session) runAgent(ctx context.Context, req agent.Request) (*launcher.Result, error) {
	s.app.agentRunning.Store(true)
	payload := s.payload
	s.payload = nil
	res, err := s.launcher.Run(ctx, req, s.app.interrupts, payload, s.detach)
	s.app.agentRunning.Store(false)
	if err != nil {
		return nil, err
	}
	if res.Detached {
		s.app.emitter.Info(events.Log, fmt.Sprintf("run %s goes on on the server: follow it with `dockflow attach %s %s`", req.Run, req.Env, req.Run),
			map[string]any{"line": "detached " + req.Run, "run": req.Run})
		return res, nil
	}
	if !s.app.json {
		s.app.human.finish(res.RunFinishedData)
	}
	s.notify(ctx, req, res)
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
	if run := ci.Detect(os.Getenv); run.Provider != "" {
		a.CI = run.Provider
		if run.Actor != "" {
			a.User = run.Actor
		}
	}
	return a
}

// ciTag returns the tag a CI run was started for, if any.
func ciTag() string {
	return ci.Detect(os.Getenv).Tag
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
	return &hooks.Runner{Dir: s.loaded.Config.Dir, Events: s.app.emitter, Host: s.hostScript, Render: s.renderScript,
		Environ: hooks.Environ(os.Environ(), s.loaded.Raw.EnvNames())}
}

// renderScript renders a hook script that templates: lists (ADR-0022).
func (s *session) renderScript(script string) ([]byte, os.FileMode, bool, error) {
	l := s.loaded
	for _, t := range l.Config.Templates {
		if filepath.Clean(t.Dest) != filepath.Clean(script) {
			continue
		}
		src := filepath.Join(l.Config.Dir, t.Src)
		st, err := os.Stat(src)
		if err != nil {
			return nil, 0, false, errs.Config("template %s: %v", t.Src, err)
		}
		b, err := render.File(src, l.Values)
		if err != nil {
			return nil, 0, false, errs.Config("template %s: %v", t.Src, err)
		}
		return b, st.Mode().Perm(), true, nil
	}
	return nil, 0, false, nil
}

// hostScript runs a script on the server with `sh -s`, feeding it on stdin.
func (s *session) hostScript(ctx context.Context, script string, out io.Writer) (int, error) {
	return runScript(ctx, s.ssh, "sh -s", script, out)
}

// runScript runs command on the server with script on its stdin, so no value of the script
// appears in a command line, and returns its exit code.
func runScript(ctx context.Context, c *ssh.Client, command, script string, out io.Writer) (int, error) {
	sess, err := c.NewSession()
	if err != nil {
		return -1, errs.Connect("cannot open an SSH session").WithCause(err)
	}
	defer sess.Close()
	sess.Stdin = strings.NewReader(script)
	sess.Stdout, sess.Stderr = out, out
	done := make(chan error, 1)
	go func() { done <- sess.Run(command) }()
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

// notifies are the operations that change an environment, which webhooks report.
var notifies = map[string]bool{
	agent.OpDeploy: true, agent.OpRollback: true, agent.OpRestart: true, agent.OpStop: true,
	agent.OpScale: true, agent.OpDestroy: true,
}

// notify sends the environment's webhooks for a run that changed something or failed.
func (s *session) notify(ctx context.Context, req agent.Request, res *launcher.Result) {
	if s.loaded == nil {
		// a server-level run, outside any project
		return
	}
	hooks := s.loaded.Config.Notify
	if len(hooks) == 0 || !notifies[req.Op] || res.Outcome == events.OutcomeNoop || errCode(res.Error) == "lock.held" {
		return
	}
	p := notify.Payload{
		Event: "run.finished", App: req.App, Env: req.Env, Server: req.Server, Op: req.Op, Run: req.Run,
		Version: req.Version, Release: res.ReleaseSeq, Outcome: res.Outcome, Status: "failure",
		ExitCode: res.ExitCode, DurationMS: res.DurationMS, At: time.Now().UTC(),
	}
	if res.Outcome == events.OutcomeSuccess {
		p.Status = "success"
	}
	if res.Error != nil {
		p.Error = s.app.mask(res.Error.Message)
	}
	for _, err := range notify.Send(context.WithoutCancel(ctx), hooks, p, nil) {
		s.app.emitter.Warn(events.Warning, s.app.mask(err.Error()), map[string]any{"code": "notify.failed"})
	}
}
