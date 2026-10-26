package agent

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
)

// execHooks runs the exec hooks of phase in every running container of their service
// (ADR-0022). A failed fatal hook is returned; a failed non-fatal one is a warning.
func (r *runner) execHooks(ctx context.Context, phase string) error {
	for _, h := range r.req.Hooks {
		if h.Phase != phase || h.Kind != domain.HookExec {
			continue
		}
		err := r.execHook(ctx, h)
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return interrupted()
		}
		if h.Fatal {
			exit := errs.ExitHook
			if !strings.HasPrefix(phase, "before_") {
				exit = errs.ExitRolledBack
			}
			return errs.Newf("hook.failed", exit, "hook %s (%s) failed: %v", h.Name, phase, err)
		}
		r.warn("hook.failed", fmt.Sprintf("hook %s failed: %v", h.Name, err))
	}
	return nil
}

func (r *runner) execHook(ctx context.Context, h domain.Hook) error {
	cs, err := r.Engine.Containers(ctx, engine.Filter{Labels: map[string]string{
		domain.LabelProject: r.stack, domain.LabelService: h.Service, domain.LabelKind: domain.KindService,
	}})
	if err != nil {
		return err
	}
	if len(cs) == 0 {
		return fmt.Errorf("service %s has no running container", h.Service)
	}
	ctx, cancel := context.WithTimeout(ctx, h.Timeout.D())
	defer cancel()
	for _, c := range cs {
		r.ev.Info(events.HookStarted, fmt.Sprintf("hook %s (%s, in %s)", h.Name, h.Phase, c.Name), map[string]any{
			"phase": h.Phase, "name": h.Name, "kind": h.Kind, "target": c.Name,
		})
		ex, err := r.Engine.Exec(ctx, c.ID, engine.ExecOptions{Cmd: h.Exec, Env: h.Env})
		if err != nil {
			return err
		}
		var wg sync.WaitGroup
		for _, stream := range []io.Reader{ex.Stdout, ex.Stderr} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				sc := bufio.NewScanner(stream)
				sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
				for sc.Scan() {
					r.ev.Info(events.HookLog, h.Name+" │ "+sc.Text(), map[string]any{"name": h.Name, "target": c.Name, "line": sc.Text()})
				}
			}()
		}
		ex.Stdin.Close()
		wg.Wait()
		ex.Close()
		code, err := ex.Wait(context.WithoutCancel(ctx))
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("did not finish within %s", h.Timeout.D())
		}
		if err != nil {
			return err
		}
		r.ev.Info(events.HookFinished, fmt.Sprintf("hook %s exited with code %d in %s", h.Name, code, c.Name), map[string]any{
			"name": h.Name, "target": c.Name, "exit_code": code, "fatal": h.Fatal,
		})
		if code != 0 {
			return fmt.Errorf("exit code %d in %s", code, c.Name)
		}
	}
	return nil
}
