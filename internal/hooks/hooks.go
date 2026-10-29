// Package hooks runs the hooks that run outside the server's containers: on the CLI's machine
// and on the server over SSH (ADR-0022). Hooks inside containers run in the agent.
package hooks

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
)

// Env is a hook's environment: the built-in variables, the environment's vars, and the secrets
// the hook lists, sorted. A listed secret without a value is an error.
func Env(h domain.Hook, builtins, vars map[string]string, secret func(string) (string, bool)) ([]string, error) {
	m := map[string]string{}
	for k, v := range vars {
		m[k] = v
	}
	for k, v := range builtins {
		m[k] = v
	}
	for _, k := range h.Secrets {
		v, ok := secret(k)
		if !ok {
			return nil, errs.Config("hook %s: secret %s has no value", h.Name, k).
				WithHint("set it in the CI variables, DOCKFLOW_SECRETS or .env.dockflow")
		}
		m[k] = v
	}
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out, nil
}

// inherited are the variables of the CLI's environment a local hook inherits: what a shell and
// the usual tools need to run (the paths, the user, the locale, the terminal, temporary
// directories, ssh-agent, proxies, the local Docker), on Unix and on Windows. Matched without
// regard to case, as Windows does.
var inherited = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true, "LANG": true, "LANGUAGE": true,
	"TZ": true, "TERM": true, "COLORTERM": true, "NO_COLOR": true, "TMPDIR": true, "TMP": true, "TEMP": true,
	"SSH_AUTH_SOCK": true, "HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "ALL_PROXY": true,
	"DOCKER_HOST": true, "DOCKER_CONTEXT": true, "DOCKER_CONFIG": true, "DOCKER_CERT_PATH": true, "DOCKER_TLS_VERIFY": true,
	"XDG_RUNTIME_DIR": true, "XDG_CONFIG_HOME": true, "XDG_CACHE_HOME": true, "XDG_DATA_HOME": true,
	"SYSTEMROOT": true, "SYSTEMDRIVE": true, "WINDIR": true, "COMSPEC": true, "PATHEXT": true, "USERPROFILE": true,
	"USERNAME": true, "HOMEDRIVE": true, "HOMEPATH": true, "APPDATA": true, "LOCALAPPDATA": true, "PROGRAMDATA": true,
	"PROGRAMFILES": true, "PROCESSOR_ARCHITECTURE": true, "NUMBER_OF_PROCESSORS": true,
	// the CI's description of the run: GitHub, GitLab, Buildkite, Bitbucket, Jenkins
	"CI": true, "BUILD_ID": true, "BUILD_NUMBER": true, "BUILD_URL": true, "JOB_NAME": true, "BRANCH_NAME": true,
	"TAG_NAME": true, "GIT_COMMIT": true, "GIT_BRANCH": true, "WORKSPACE": true, "JENKINS_URL": true,
}

// inheritedPrefixes are the families of variables a local hook inherits: the locale's, and the
// CI's description of the run, but for credentials (credential).
var inheritedPrefixes = []string{"LC_", "GITHUB_", "RUNNER_", "CI_", "GITLAB_", "BUILDKITE_", "BITBUCKET_"}

// credential tells a variable of the CI's families that holds a credential: a token (GITHUB_TOKEN,
// CI_JOB_TOKEN), a password, a key, or the repository's URL, which GitLab writes with its token.
func credential(name string) bool {
	for _, s := range []string{"TOKEN", "SECRET", "PASSWORD", "PASSWD", "JWT", "KEY", "CREDENTIAL", "AUTH"} {
		if strings.Contains(name, s) {
			return true
		}
	}
	return name == "CI_REPOSITORY_URL"
}

// Environ returns the part of the CLI's environment a local hook inherits (ADR-0022): the
// variables of inherited and inheritedPrefixes, none of which is a credential, and none of which
// starts with the prefix of one of envs (PRODUCTION_ for production), where an environment's
// secrets live. DOCKFLOW_SECRETS, the SOPS keys and everything else stay out: a hook gets a
// secret by listing it under secrets:.
func Environ(environ, envs []string) []string {
	var out []string
	for _, kv := range environ {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			continue
		}
		name := strings.ToUpper(k)
		allowed := inherited[name]
		if !allowed {
			for _, p := range inheritedPrefixes {
				if strings.HasPrefix(name, p) && !credential(name) {
					allowed = true
					break
				}
			}
		}
		for _, env := range envs {
			if strings.HasPrefix(name, strings.ToUpper(env)+"_") {
				allowed = false
			}
		}
		if allowed {
			out = append(out, kv)
		}
	}
	return out
}

// Host runs script on the server, feeding it to `sh -s` on stdin, and returns its exit code.
type Host func(ctx context.Context, script string, out io.Writer) (int, error)

// Runner runs the local and host hooks of a phase.
type Runner struct {
	Dir    string
	Events *events.Emitter
	Host   Host
	// Environ is what local hooks inherit of the CLI's environment, before their own variables
	// (Environ); nil inherits Environ(os.Environ(), nil).
	Environ []string
	// Render returns a script listed under templates:, rendered now so it sees what earlier
	// hooks wrote, and the mode of its template; ok is false for a script that is no template.
	Render func(script string) (content []byte, mode os.FileMode, ok bool, err error)
	// Changed tells whether the deploy changed an upload's destination, for the hooks that run
	// only then (if_changed); nil runs them.
	Changed func(dest string) bool
}

// Failed is the error of a fatal hook.
func Failed(h domain.Hook, detail string) *errs.Error {
	// only a failed after_deploy hook rolls a deploy back; the others change nothing
	exit := errs.ExitHook
	if h.Phase == domain.HookAfterDeploy {
		exit = errs.ExitRolledBack
	}
	return errs.Newf("hook.failed", exit, "hook %s (%s) failed: %s", h.Name, h.Phase, detail)
}

// Run runs the local and host hooks of phase in order. A failed fatal hook stops it and is
// returned; a failed non-fatal one is a warning.
func (r *Runner) Run(ctx context.Context, phase string, hooks []domain.Hook) error {
	for _, h := range hooks {
		if h.Phase != phase || h.Kind == domain.HookExec {
			continue
		}
		if h.IfChanged != "" && r.Changed != nil && !r.Changed(h.IfChanged) {
			r.Events.Debug(events.Log, fmt.Sprintf("hook %s skipped: %s did not change", h.Name, h.IfChanged), nil)
			continue
		}
		code, err := r.one(ctx, h)
		if err == nil && code == 0 {
			continue
		}
		detail := fmt.Sprintf("exit code %d", code)
		if err != nil {
			detail = err.Error()
		}
		if h.Fatal {
			return Failed(h, detail)
		}
		r.Events.Warn(events.Warning, fmt.Sprintf("hook %s failed: %s", h.Name, detail), map[string]any{"code": "hook.failed", "detail": detail})
	}
	return nil
}

func (r *Runner) one(ctx context.Context, h domain.Hook) (int, error) {
	target := "local"
	if h.Kind == domain.HookHost {
		target = "server"
	}
	r.Events.Info(events.HookStarted, fmt.Sprintf("hook %s (%s, %s)", h.Name, h.Phase, h.Kind), map[string]any{
		"phase": h.Phase, "name": h.Name, "kind": h.Kind, "target": target,
	})
	ctx, cancel := context.WithTimeout(ctx, h.Timeout.D())
	defer cancel()
	out := r.lines(h.Name, target)
	var code int
	var err error
	switch h.Kind {
	case domain.HookHost:
		if r.Host == nil {
			return -1, errs.Internal("host hooks need the server's connection")
		}
		code, err = r.Host(ctx, Script(h.Env, h.Command), out)
	default:
		code, err = r.local(ctx, h, out)
	}
	out.Close()
	if ctx.Err() == context.DeadlineExceeded {
		err = fmt.Errorf("did not finish within %s", h.Timeout.D())
	}
	r.Events.Info(events.HookFinished, fmt.Sprintf("hook %s exited with code %d", h.Name, code), map[string]any{
		"name": h.Name, "target": target, "exit_code": code, "fatal": h.Fatal,
	})
	return code, err
}

func (r *Runner) local(ctx context.Context, h domain.Hook, out io.Writer) (int, error) {
	var cmd *exec.Cmd
	if h.Script != "" {
		path, cleanup, err := r.script(h.Script)
		if err != nil {
			return -1, err
		}
		defer cleanup()
		if st, err := os.Stat(path); err == nil && st.Mode()&0o111 != 0 {
			cmd = exec.CommandContext(ctx, path)
		} else {
			cmd = exec.CommandContext(ctx, "sh", path)
		}
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", h.Command)
	}
	cmd.Dir = r.Dir
	base := r.Environ
	if base == nil {
		base = Environ(os.Environ(), nil)
	}
	cmd.Env = append(slices.Clone(base), h.Env...)
	cmd.Stdout, cmd.Stderr = out, out
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

// script returns the file to run for a script hook: the project's, or a temporary copy rendered
// from templates:, with the project's file mode.
func (r *Runner) script(name string) (string, func(), error) {
	none := func() {}
	if r.Render != nil {
		content, mode, ok, err := r.Render(name)
		if err != nil {
			return "", none, err
		}
		if ok {
			return temporary(content, 0o600|mode&0o100)
		}
	}
	path := filepath.Join(r.Dir, name)
	if _, err := os.Stat(path); err != nil {
		return "", none, fmt.Errorf("%s does not exist", name)
	}
	return path, none, nil
}

// temporary writes content to a temporary file with mode; the project is never modified
// (ADR-0006).
func temporary(content []byte, mode os.FileMode) (string, func(), error) {
	f, err := os.CreateTemp("", "dockflow-hook-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { os.Remove(f.Name()) }
	_, err = f.Write(content)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(f.Name(), mode)
	}
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	return f.Name(), cleanup, nil
}

// lines turns a hook's output into hook.log events, one per line.
func (r *Runner) lines(name, target string) io.WriteCloser {
	pr, pw := io.Pipe()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
		for sc.Scan() {
			r.Events.Info(events.HookLog, name+" │ "+sc.Text(), map[string]any{"name": name, "target": target, "line": sc.Text()})
		}
		io.Copy(io.Discard, pr)
	}()
	return &waitCloser{PipeWriter: pw, wg: &wg}
}

type waitCloser struct {
	*io.PipeWriter
	wg *sync.WaitGroup
}

func (w *waitCloser) Close() error {
	err := w.PipeWriter.Close()
	w.wg.Wait()
	return err
}

// Script is the shell script a host hook runs: its environment exported, then its command. It
// travels on stdin, so values never appear in a command line on the server.
func Script(env []string, command string) string {
	var b strings.Builder
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		b.WriteString("export " + k + "='" + strings.ReplaceAll(v, "'", `'\''`) + "'\n")
	}
	b.WriteString(command + "\n")
	return b.String()
}
