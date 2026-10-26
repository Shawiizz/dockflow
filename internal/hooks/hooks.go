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

// Host runs script on the server, feeding it to `sh -s` on stdin, and returns its exit code.
type Host func(ctx context.Context, script string, out io.Writer) (int, error)

// Runner runs the local and host hooks of a phase.
type Runner struct {
	Dir    string
	Events *events.Emitter
	Host   Host
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
		path := filepath.Join(r.Dir, h.Script)
		if st, err := os.Stat(path); err != nil {
			return -1, fmt.Errorf("%s does not exist", h.Script)
		} else if st.Mode()&0o111 != 0 {
			cmd = exec.CommandContext(ctx, path)
		} else {
			cmd = exec.CommandContext(ctx, "sh", path)
		}
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", h.Command)
	}
	cmd.Dir = r.Dir
	cmd.Env = append(os.Environ(), h.Env...)
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
