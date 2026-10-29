package agent

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/state"
)

// A backup or a restore that stops a service, quiesces it, or replaces its volumes records it
// first in backup.json (state-v1.md), and finishes it last: whatever happens to the run, the
// service resumes, and runs on its data or on the whole snapshot, never on a part of it. The next
// run that takes the lock, or the watchdog once the agent is gone, finishes a record left behind.

// helperPrefix starts the names of a run's one-off containers: restic, and a restore's copies.
func helperPrefix(run string) string { return "dockflow-restic-" + run + "-" }

// copyScript replaces the files of /to with those of /from, in a one-off container of restic's
// image. Run again, it does the same: a copy cut short is done again from the start.
const copyScript = `set -e
find /to -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a /from/. /to/
`

// newBackupRun is the record of this run's backup or restore of svc.
func (r *runner) newBackupRun(svc *domain.Service) *state.BackupRun {
	return &state.BackupRun{Run: r.req.Run, Op: r.req.Op, Service: svc.Name, Since: r.Now().UTC()}
}

// serviceContainers are the service's containers, running only unless all.
func (r *runner) serviceContainers(ctx context.Context, service string, all bool) ([]engine.Container, error) {
	return r.Engine.Containers(ctx, engine.Filter{All: all, Labels: map[string]string{
		domain.LabelProject: r.stack, domain.LabelService: service, domain.LabelKind: domain.KindService,
	}})
}

// pause stops the writes of svc as mode says, stop or exec, after recording it in rec. endBackup
// resumes them, even when pause fails half-way.
func (r *runner) pause(ctx context.Context, svc *domain.Service, mode, why string, rec *state.BackupRun) error {
	if mode == domain.QuiesceExec {
		c, err := r.runningContainer(ctx, svc)
		if err != nil {
			return err
		}
		rec.Quiesce, rec.Containers = domain.QuiesceExec, []string{c.ID}
		if err := r.app.SetBackupRun(*rec); err != nil {
			return err
		}
		if err := r.backupExec(ctx, svc, c, svc.Backup.Quiesce.Pre); err != nil {
			return fmt.Errorf("quiesce pre: %w", err)
		}
		return nil
	}
	cs, err := r.serviceContainers(ctx, svc.Name, false)
	if err != nil || len(cs) == 0 {
		return err
	}
	rec.Quiesce, rec.Containers = domain.QuiesceStop, nil
	for _, c := range cs {
		rec.Containers = append(rec.Containers, c.ID)
	}
	if err := r.app.SetBackupRun(*rec); err != nil {
		return err
	}
	var grace *time.Duration
	if svc.Spec.StopGrace != nil {
		d := svc.Spec.StopGrace.D()
		grace = &d
	}
	for _, c := range cs {
		r.ev.Info(events.Log, "stopping "+c.Name+" for "+why, map[string]any{"line": "stop " + c.Name})
		if err := r.Engine.Stop(ctx, c.ID, grace); err != nil {
			return err
		}
	}
	return nil
}

// endBackup finishes what rec records, in an order that a cut at any step can resume: the volumes
// of a restore whose copy may have begun are replaced again, the service resumes, the staging
// volumes are removed, then the record. It is the end of every backup and restore that paused a
// service, and what the next run or the watchdog does with a record a dead run left.
func (r *runner) endBackup(ctx context.Context, rec *state.BackupRun) error {
	ctx = context.WithoutCancel(ctx)
	if rec.Run != r.req.Run {
		// a restic or a copy the dead run started must not go on once the service resumes
		if err := r.removeHelpers(ctx, rec.Run); err != nil {
			return err
		}
	}
	if rec.Copying {
		if err := r.replaceVolumes(ctx, rec); err != nil {
			return err
		}
	}
	if rec.Copying || len(rec.Volumes) > 0 {
		// from here on, the volumes are never copied again: the service is about to write
		rec.Copying = false
		if err := r.app.SetBackupRun(*rec); err != nil {
			return err
		}
	}
	if err := r.resume(ctx, rec); err != nil {
		return err
	}
	for _, v := range rec.Volumes {
		if err := r.Engine.RemoveVolume(ctx, v.Staging); err != nil {
			return &cleanupErr{err}
		}
	}
	if err := r.app.ClearBackupRun(); err != nil {
		return &cleanupErr{err}
	}
	return nil
}

// cleanupErr is a failure of endBackup once the service has resumed: what is left is removed by
// the next run, or the watchdog.
type cleanupErr struct{ err error }

func (e *cleanupErr) Error() string { return e.err.Error() }
func (e *cleanupErr) Unwrap() error { return e.err }

// endFailed is the error of endBackup that the run reports: a failure to tidy up once the
// service resumed is only a warning.
func (r *runner) endFailed(ctx context.Context, rec *state.BackupRun) error {
	err := r.endBackup(ctx, rec)
	var c *cleanupErr
	if errors.As(err, &c) {
		r.warn("backup.cleanup", fmt.Sprintf("%s resumed, but what its %s left could not be removed: %v; the next run or the watchdog removes it", rec.Service, rec.Op, c.err))
		return nil
	}
	return err
}

// finishLeft finishes what a backup or a restore that did not end left in backup.json. A run
// calls it under the lock, before anything else.
func (r *runner) finishLeft(ctx context.Context) error {
	rec, err := r.app.BackupRun()
	if err != nil || rec == nil {
		return err
	}
	if err := r.app.Writable(); err != nil {
		return err
	}
	what := "resuming " + rec.Service
	if rec.Copying {
		what = "finishing the restore of " + rec.Service
	}
	r.warn("backup.unfinished", fmt.Sprintf("the %s of %s by run %s did not finish: %s", rec.Op, rec.Service, rec.Run, what))
	return r.endFailed(ctx, rec)
}

// removeHelpers removes the one-off containers of run.
func (r *runner) removeHelpers(ctx context.Context, run string) error {
	cs, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{
		domain.LabelProject: r.stack, domain.LabelKind: domain.KindHelper,
	}})
	if err != nil {
		return err
	}
	for _, c := range cs {
		if strings.HasPrefix(c.Name, helperPrefix(run)) {
			if err := r.Engine.Remove(ctx, c.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// replaceVolumes replaces the restored volumes with their staging volumes, the service stopped.
func (r *runner) replaceVolumes(ctx context.Context, rec *state.BackupRun) error {
	have, err := r.Engine.Volumes(ctx)
	if err != nil {
		return err
	}
	for _, v := range rec.Volumes {
		if !have[v.Staging] {
			// Docker would create it empty, and the copy would empty the volume
			return fmt.Errorf("the staging volume %s of the restore of %s is gone: %s keeps its data and stays stopped; restore it again", v.Staging, rec.Service, rec.Service)
		}
	}
	cs, err := r.serviceContainers(ctx, rec.Service, false)
	if err != nil {
		return err
	}
	for _, c := range cs {
		// started again by a reboot: it must not run while its volumes change
		if !slices.Contains(rec.Containers, c.ID) {
			rec.Containers = append(rec.Containers, c.ID)
		}
		rec.Quiesce = domain.QuiesceStop
		if err := r.Engine.Stop(ctx, c.ID, nil); err != nil {
			return err
		}
	}
	image, err := r.Engine.ResolveImage(ctx, DefaultResticImage, "missing", nil)
	if err != nil {
		return err
	}
	for _, v := range rec.Volumes {
		spec := domain.ContainerSpec{
			Image: image, Entrypoint: []string{"sh", "-c", copyScript}, Restart: "no",
			Mounts: []domain.Mount{
				{Type: "volume", Source: v.Staging, Target: "/from", ReadOnly: true},
				{Type: v.Type, Source: v.Source, Target: "/to"},
			},
		}
		res, err := r.helper(ctx, spec, nil, nil)
		if err != nil {
			return err
		}
		if res.code != 0 {
			return fmt.Errorf("the copy of the restored files into %s exited with code %d: %s", v.Source, res.code, lastLines(res.stderr, 3))
		}
	}
	syncDisks()
	return nil
}

// resume starts again the containers rec stopped, or runs the quiesce post command.
func (r *runner) resume(ctx context.Context, rec *state.BackupRun) error {
	switch rec.Quiesce {
	case domain.QuiesceStop:
		cs, err := r.serviceContainers(ctx, rec.Service, true)
		if err != nil {
			return err
		}
		var errAll error
		for _, c := range cs {
			if slices.Contains(rec.Containers, c.ID) && c.State != "running" {
				errAll = errors.Join(errAll, r.Engine.Start(ctx, c.ID))
			}
		}
		return errAll
	case domain.QuiesceExec:
		rel, err := r.currentRelease()
		if err != nil {
			return err
		}
		svc, ok := rel.Desired.Service(rec.Service)
		if !ok || svc.Backup == nil || len(rec.Containers) == 0 {
			return nil
		}
		cs, err := r.serviceContainers(ctx, rec.Service, false)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(cs, func(c engine.Container) bool { return c.ID == rec.Containers[0] })
		if i < 0 {
			// a container that is gone, or stopped, starts with its writes on
			return nil
		}
		c := cs[i]
		err = r.backupExec(ctx, svc, c, svc.Backup.Quiesce.Post)
		var exit *hookExit
		if errors.As(err, &exit) {
			// it ran: running it again would fail the same way
			r.warn("backup.resume", fmt.Sprintf("%s: writes could not be resumed: %v", rec.Service, err))
			return nil
		}
		return err
	}
	return nil
}

// hookExit is a quiesce command that ran and failed.
type hookExit struct {
	cmd  string
	code int
}

func (e *hookExit) Error() string { return fmt.Sprintf("%s exited with code %d", e.cmd, e.code) }
