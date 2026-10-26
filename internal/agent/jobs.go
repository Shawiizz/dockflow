package agent

import (
	"bufio"
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
)

// defaultJobTimeout bounds a job when deploy.timeout is not set.
const defaultJobTimeout = 30 * time.Minute

// runJob runs a job of release seq as a one-off container on the new image, streams its output,
// and fails unless it exits 0 (ADR-0010).
func (r *runner) runJob(ctx context.Context, s *domain.Service, seq int) error {
	if r.req.Op != OpDeploy {
		r.ev.Info(events.Log, fmt.Sprintf("%s: jobs run on deploys only, not on %s", s.Name, r.req.Op), map[string]any{"line": "skip job " + s.Name})
		return nil
	}
	timeout := r.req.Timeout.D()
	if timeout <= 0 {
		timeout = defaultJobTimeout
	}
	labels := containerLabels(r.stack, s, seq, 1)
	labels[domain.LabelOneOff] = "True"
	labels[domain.LabelKind] = domain.KindJob
	name := domain.JobName(r.stack, s.Name, seq)
	id, err := r.Engine.Create(ctx, name, s.Spec, labels)
	if err != nil {
		return err
	}
	defer func() { _ = r.Engine.Remove(context.WithoutCancel(ctx), id) }()
	if err := r.Engine.Start(ctx, id); err != nil {
		return err
	}
	jctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	logs, err := r.Engine.Logs(jctx, id, engine.LogOptions{Follow: true, Stderr: true})
	if err != nil {
		return err
	}
	sc := bufio.NewScanner(logs)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		r.ev.Info(events.JobLog, s.Name+" │ "+line, map[string]any{"service": s.Name, "line": line})
	}
	logs.Close()
	if jctx.Err() != nil {
		_ = r.Engine.Kill(context.WithoutCancel(ctx), id, "SIGKILL")
		if ctx.Err() != nil {
			return interrupted()
		}
		return errs.Newf("job.timeout", errs.ExitRolledBack, "job %s did not finish within %s", s.Name, timeout).
			WithHint("raise environments.<env>.deploy.timeout")
	}
	code, err := r.Engine.Wait(ctx, id)
	if err != nil {
		return err
	}
	r.ev.Info(events.JobFinished, fmt.Sprintf("%s exited with code %d", s.Name, code), map[string]any{"service": s.Name, "exit_code": code})
	if code != 0 {
		return errs.Newf("job.failed", errs.ExitRolledBack, "job %s exited with code %d", s.Name, code).
			WithHint("its output is above")
	}
	return nil
}

// removeJobs removes job containers an interrupted run left behind.
func (r *runner) removeJobs(ctx context.Context) error {
	cs, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{
		domain.LabelProject: r.stack, domain.LabelKind: domain.KindJob,
	}})
	if err != nil {
		return err
	}
	for _, c := range cs {
		r.warn("run.leftover", "removing "+c.Name+", left by an unfinished run (release "+strconv.Itoa(c.Release)+")")
		if err := r.Engine.Remove(ctx, c.ID); err != nil {
			return err
		}
	}
	return nil
}
