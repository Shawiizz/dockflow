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

	ws *render.Workspace
	// manifests and blobs are the uploads' manifests and where each blob is read.
	manifests map[string]upload.Manifest
	blobs     map[string]string
	// payload, when set, follows the next agent request on its stdin.
	payload func(io.Writer) error
}

// load reads the project for env (as typed) without reaching the server.
func (a *app) load(ctx context.Context, env, versionFlag string) (*project.Loaded, error) {
	dir := a.dir
	git := project.ReadGit(dir)
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
		m, paths, err := upload.Scan(src, ignore.New(e.Exclude))
		if err != nil {
			return errs.Config("uploads: cannot read %s", e.Src).WithCause(err)
		}
		u := domain.Upload{Dest: e.Dest, Mirror: e.Mirror, Mode: e.Mode, Owner: e.Owner, Manifest: m.Digest()}
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
	s.payload = func(w io.Writer) error {
		tw := tar.NewWriter(w)
		for _, sum := range missing {
			path, ok := s.blobs[sum]
			if !ok {
				return fmt.Errorf("no local file for %s", sum)
			}
			if err := addFile(tw, path, sum); err != nil {
				return err
			}
		}
		return tw.Close()
	}
	s.app.emitter.Info(events.Log, fmt.Sprintf("uploading %d of %d files", len(missing), len(sums)), map[string]any{"line": "upload"})
	return nil
}

func addFile(tw *tar.Writer, path, name string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: st.Size(), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
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
	payload := s.payload
	s.payload = nil
	res, err := s.launcher.Run(ctx, req, s.app.interrupts, payload)
	s.app.agentRunning.Store(false)
	if err != nil {
		return nil, err
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

// notifies are the operations that change an environment, which webhooks report.
var notifies = map[string]bool{
	agent.OpDeploy: true, agent.OpRollback: true, agent.OpRestart: true, agent.OpStop: true,
	agent.OpScale: true, agent.OpDestroy: true,
}

// notify sends the environment's webhooks for a run that changed something or failed.
func (s *session) notify(ctx context.Context, req agent.Request, res *launcher.Result) {
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
