package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// SwitchContainer is the name of the switch's container.
const SwitchContainer = "dockflow-switch"

// Deps are the agent's ports.
type Deps struct {
	Engine engine.Engine
	Store  *state.Store
	// Switch is nil when the server runs no switch.
	Switch proxy.Switch
	Events *events.Emitter
	Now    func() time.Time
	// Payload is what follows the request on stdin: the uploaded files.
	Payload io.Reader
}

type runner struct {
	Deps
	req   Request
	ev    *events.Emitter
	app   *state.App
	stack string
	start time.Time
	// joined are the app networks the agent's container joined for internal checks.
	joined map[string]bool
	// uploads are the uploads this run applied, to undo on failure.
	uploads []appliedUpload
}

// Run executes one request. It emits run.started first and run.finished last, and returns the
// data of run.finished.
func Run(ctx context.Context, d Deps, req Request) events.RunFinishedData {
	if d.Now == nil {
		d.Now = time.Now
	}
	r := &runner{Deps: d, req: req, ev: d.Events, stack: req.Stack, start: d.Now()}
	r.ev.Masker().Add(req.Mask...)
	r.ev.Info(events.RunStarted, fmt.Sprintf("%s %s", req.Op, describe(req)), map[string]any{
		"app": req.App, "env": req.Env, "op": req.Op, "dockflow_version": req.DockflowVersion, "server": req.Server,
	})
	res := r.dispatch(ctx)
	res.DurationMS = d.Now().Sub(r.start).Milliseconds()
	level, msg := events.Info, "done"
	switch res.Outcome {
	case events.OutcomeNoop:
		msg = "nothing to do"
	case events.OutcomeSuccess:
		if res.ReleaseSeq > 0 {
			msg = fmt.Sprintf("release %d is live", res.ReleaseSeq)
		}
	default:
		level = events.Error
		msg = res.Outcome
		if res.Error != nil {
			msg = res.Error.Message
		}
	}
	r.ev.Emit(level, events.RunFinished, msg, res)
	return res
}

func describe(req Request) string {
	if req.Stack != "" {
		return req.Stack
	}
	return req.Server
}

func (r *runner) dispatch(ctx context.Context) events.RunFinishedData {
	if r.req.Op != OpServerInit {
		if r.stack == "" {
			return failed(errs.Usage("the request names no app environment"))
		}
		app, err := r.Store.App(r.stack)
		if err != nil {
			return failed(err)
		}
		r.app = app
	}
	switch r.req.Op {
	case OpPlan:
		return r.plan(ctx)
	case OpDeploy, OpRollback, OpRestart, OpStop, OpScale:
		return r.deploy(ctx)
	case OpDestroy:
		if len(r.req.Services) > 0 {
			return r.deploy(ctx)
		}
		return r.destroy(ctx)
	case OpPrune:
		return r.prune(ctx)
	case OpRevoke:
		return r.revoke(ctx)
	case OpDetails:
		return r.details()
	case OpUploadHave:
		return r.haveBlobs()
	case OpStatus:
		return r.status(ctx)
	case OpReleases:
		return r.releases()
	case OpLockAcquire, OpLockRelease, OpLockStatus:
		return r.manualLock()
	case OpServerInit:
		return r.serverInit(ctx)
	}
	return failed(errs.Usage("unknown operation %q", r.req.Op))
}

func failed(err error) events.RunFinishedData {
	outcome := events.OutcomeFailed
	if errs.ExitCode(err) == errs.ExitInterrupted {
		outcome = events.OutcomeCancelled
	}
	return events.RunFinishedData{Outcome: outcome, ExitCode: errs.ExitCode(err), Error: errData(err)}
}

func errData(err error) *events.ErrorData {
	if err == nil {
		return nil
	}
	var e *errs.Error
	if errors.As(err, &e) {
		msg := e.Message
		if e.Cause != nil {
			msg += ": " + e.Cause.Error()
		}
		return &events.ErrorData{Code: e.Code, Message: msg, Hint: e.Hint}
	}
	if errors.Is(err, context.Canceled) {
		return &events.ErrorData{Code: "run.cancelled", Message: "the run was cancelled"}
	}
	return &events.ErrorData{Code: "internal", Message: err.Error()}
}

func (r *runner) result(data any) {
	r.ev.Info(events.Result, r.req.Op, data)
}

// lock takes the environment's lock, waiting for it when the request allows.
func (r *runner) lock(ctx context.Context) (*state.Lock, error) {
	if !r.req.Force {
		if m, err := r.app.ManualLock(); err != nil {
			return nil, err
		} else if m != nil {
			return nil, errs.Newf("lock.manual", errs.ExitLocked, "%s locked this environment on %s: %s", m.By, m.Since.Format(time.RFC3339), m.Message).
				WithHint("run `dockflow lock release`, or pass --force")
		}
	}
	info := domain.LockInfo{Run: r.req.Run, Op: r.req.Op, By: by(r.req.Author), CI: r.req.Author.CI, Since: r.Now().UTC()}
	deadline := r.Now().Add(r.req.WaitLock.D())
	waiting := false
	for {
		l, err := r.app.Lock(info)
		if err == nil {
			r.ev.Info(events.LockAcquired, "lock acquired", map[string]any{"scope": r.stack})
			return l, nil
		}
		if errs.CodeOf(err) != "lock.held" || !r.Now().Before(deadline) {
			return nil, err
		}
		if !waiting {
			waiting = true
			h, _ := r.app.Holder()
			data := map[string]any{}
			if h != nil {
				data = map[string]any{"holder": h.Run, "op": h.Op, "by": h.By, "since": h.Since}
			}
			r.ev.Info(events.LockWaiting, "waiting for the lock", data)
		}
		select {
		case <-ctx.Done():
			return nil, interrupted()
		case <-time.After(time.Second):
		}
	}
}

func (r *runner) unlock(l *state.Lock) {
	l.Release()
	r.ev.Info(events.LockReleased, "lock released", map[string]any{"scope": r.stack})
}

func by(a domain.Author) string {
	if a.Machine == "" {
		return a.User
	}
	return a.User + "@" + a.Machine
}

func interrupted() error {
	return errs.New("run.cancelled", errs.ExitInterrupted, "the run was cancelled")
}

func (r *runner) manualLock() events.RunFinishedData {
	switch r.req.Op {
	case OpLockAcquire:
		if m, err := r.app.ManualLock(); err != nil {
			return failed(err)
		} else if m != nil && !r.req.Force {
			return failed(errs.Newf("lock.manual", errs.ExitLocked, "%s already locked this environment: %s", m.By, m.Message))
		} else if m != nil && m.By != by(r.req.Author) {
			r.ev.Warn(events.LockTakenOver, "took over the lock of "+m.By, map[string]any{"scope": "manual", "previous_holder": m.By})
		}
		info := domain.LockInfo{Op: "manual", By: by(r.req.Author), CI: r.req.Author.CI, Since: r.Now().UTC()}
		if r.req.Lock != nil {
			info.Message = r.req.Lock.Message
		}
		if err := r.app.SetManualLock(info); err != nil {
			return failed(err)
		}
		r.result(info)
	case OpLockRelease:
		m, err := r.app.ManualLock()
		if err != nil {
			return failed(err)
		}
		if m != nil && m.By != by(r.req.Author) && !r.req.Force {
			return failed(errs.Newf("lock.manual", errs.ExitLocked, "%s holds this lock: %s", m.By, m.Message).
				WithHint("release it anyway with `dockflow lock release --force`"))
		}
		if err := r.app.ClearManualLock(); err != nil {
			return failed(err)
		}
		r.result(map[string]any{"released": true})
	case OpLockStatus:
		m, err := r.app.ManualLock()
		if err != nil {
			return failed(err)
		}
		h, _ := r.app.Holder()
		r.result(map[string]any{"manual": m, "last_holder": h})
	}
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}
