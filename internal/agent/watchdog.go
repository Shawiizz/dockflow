package agent

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// The watchdog (ADR-0010): a permanent container, running the Dockflow binary, that restarts the
// containers of current releases that stay unhealthy, and brings an app back after a reboot.
const (
	WatchdogContainer = "dockflow-watchdog"
	// WatchdogInterval is how often the watchdog looks at the containers.
	WatchdogInterval = 10 * time.Second
)

// Watchdog looks after the app environments of a server.
type Watchdog struct {
	Engine engine.Engine
	Store  *state.Store
	// Switch moves an app's routes back when the watchdog recovers a dead run; nil when the
	// server runs no switch.
	Switch proxy.Switch
	Events *events.Emitter
	Now    func() time.Time
	// since is when each container was first seen unhealthy, by ID.
	since map[string]time.Time
}

// Run looks at the containers every interval until ctx ends.
func (w *Watchdog) Run(ctx context.Context, interval time.Duration) {
	if w.Now == nil {
		w.Now = time.Now
	}
	w.Events.Info(events.Log, "watchdog started", map[string]any{"line": "watchdog started"})
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		w.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Tick looks at every app environment once.
func (w *Watchdog) Tick(ctx context.Context) {
	if w.since == nil {
		w.since = map[string]time.Time{}
	}
	stacks, err := w.Store.Stacks()
	if err != nil {
		w.warn("cannot list the apps: " + err.Error())
		return
	}
	seen := map[string]bool{}
	for _, stack := range stacks {
		if err := w.stack(ctx, stack, seen); err != nil {
			w.warn(stack + ": " + err.Error())
		}
	}
	for id := range w.since {
		if !seen[id] {
			delete(w.since, id)
		}
	}
}

// stack looks after one app environment: the secret files of its current release, a run that
// stopped before it finished, its containers that failed to start, and those that stay
// unhealthy. seen collects the unhealthy containers.
func (w *Watchdog) stack(ctx context.Context, stack string, seen map[string]bool) error {
	app, err := w.Store.App(stack)
	if err != nil {
		return err
	}
	env, err := app.Env()
	if err != nil || env == nil {
		return err
	}
	if env.Current == 0 {
		return w.recoverDead(ctx, stack, app)
	}
	rel, err := app.Release(env.Current)
	if err != nil || rel == nil {
		return err
	}
	// the files first: the containers recovery starts again may mount them
	w.restoreFiles(app, rel)
	if err := w.recoverDead(ctx, stack, app); err != nil {
		w.warn(stack + ": cannot recover the run that stopped: " + err.Error())
	}
	cs, err := w.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{
		domain.LabelProject: stack, domain.LabelKind: domain.KindService,
	}})
	if err != nil {
		return err
	}
	type action struct {
		c       engine.Container
		svc     *domain.Service
		reason  string
		unready time.Duration
	}
	var todo []action
	for _, c := range cs {
		serving := env.Current
		if seq, ok := rel.Serving[c.Service]; ok {
			// a service a deploy left unchanged keeps the containers of an older release
			serving = seq
		}
		if c.Release != serving {
			// a rollout in progress, or containers a deploy is about to remove
			continue
		}
		svc, ok := rel.Desired.Service(c.Service)
		if !ok || svc.Stopped || svc.Job != "" {
			continue
		}
		switch {
		case (c.State == "exited" || c.State == "created") && keptRunning(svc) && mountsSecret(svc):
			// after a reboot, Docker could not start it before its secrets were written again;
			// Docker's restart policy covers the other containers
			todo = append(todo, action{c: c, svc: svc, reason: "boot"})
		case c.Health == "unhealthy":
			seen[c.ID] = true
			first, ok := w.since[c.ID]
			if !ok {
				w.since[c.ID] = w.Now()
				continue
			}
			delay := svc.RestartDelay()
			if delay > 0 && w.Now().Sub(first) >= delay {
				todo = append(todo, action{c: c, svc: svc, reason: "unhealthy", unready: w.Now().Sub(first)})
			}
		}
	}
	if len(todo) == 0 {
		return nil
	}
	// never during a run: a deploy or a rollback decides for itself
	l, err := app.Lock(domain.LockInfo{Run: "watchdog", Op: "watchdog", By: "watchdog", Since: w.Now().UTC()})
	if err != nil {
		return nil
	}
	defer l.Release()
	for _, a := range todo {
		var err error
		switch a.reason {
		case "boot":
			err = w.Engine.Start(ctx, a.c.ID)
		default:
			var grace *time.Duration
			if a.svc.Spec.StopGrace != nil {
				d := a.svc.Spec.StopGrace.D()
				grace = &d
			}
			if err = w.Engine.Stop(ctx, a.c.ID, grace); err == nil {
				err = w.Engine.Start(ctx, a.c.ID)
			}
			delete(w.since, a.c.ID)
		}
		if err != nil {
			w.warn(fmt.Sprintf("%s: cannot restart %s: %v", stack, a.c.Name, err))
			continue
		}
		msg := fmt.Sprintf("%s: %s started again after a reboot", stack, a.c.Name)
		if a.reason == "unhealthy" {
			msg = fmt.Sprintf("%s: %s restarted, unhealthy for %s", stack, a.c.Name, a.unready.Round(time.Second))
		}
		w.Events.Warn(events.WatchdogRestarted, msg, map[string]any{
			"stack": stack, "service": a.c.Service, "container": a.c.Name, "reason": a.reason,
		})
		if err := app.AddWatchdogRestart(state.WatchdogRestart{
			Service: a.c.Service, Container: a.c.Name, At: w.Now().UTC(), Reason: a.reason,
		}); err != nil {
			w.warn(stack + ": " + err.Error())
		}
	}
	return nil
}

// recoverDead does at once, for a run whose agent died, what the next run would do first
// (ADR-0008), so that a container the run had stopped does not stay down until someone runs a
// command. It takes the lock, so it never acts during a run.
func (w *Watchdog) recoverDead(ctx context.Context, stack string, app *state.App) error {
	why, err := w.stopped(ctx, stack, app)
	if err != nil || why == "" {
		return quiet(err)
	}
	l, err := app.Lock(domain.LockInfo{Run: "watchdog", Op: "watchdog", By: "watchdog", Since: w.Now().UTC()})
	if err != nil {
		// a run holds it, and recovers for itself; or a newer Dockflow wrote this state
		return quiet(err)
	}
	defer l.Release()
	// a run may have ended in between
	if why, err = w.stopped(ctx, stack, app); err != nil || why == "" {
		return quiet(err)
	}
	w.Events.Warn(events.Warning, stack+": "+why+": recovering", map[string]any{"code": "watchdog.recovered", "stack": stack})
	r := &runner{
		Deps: Deps{Engine: w.Engine, Store: w.Store, Switch: w.Switch, Events: w.Events, Now: w.Now},
		req:  Request{Op: "recover", Run: "watchdog", Stack: stack}, ev: w.Events, app: app, stack: stack, start: w.Now(),
	}
	return r.recover(ctx)
}

// stopped tells why app was left by a run that stopped before it finished, if it was: a release
// left applying whose agent container no longer runs, a commit whose statuses were not all
// written, or containers of other releases than the current one, when no failed release was
// left in place on purpose (on_failure: fail).
func (w *Watchdog) stopped(ctx context.Context, stack string, app *state.App) (string, error) {
	env, err := app.Env()
	if err != nil || env == nil {
		return "", err
	}
	seqs, err := app.Releases()
	if err != nil {
		return "", err
	}
	for i := len(seqs) - 1; i >= 0 && seqs[i] >= env.Current; i-- {
		rel, err := app.Release(seqs[i])
		if err != nil || rel == nil || rel.Status != domain.StatusApplying {
			if err != nil {
				return "", err
			}
			continue
		}
		agents, err := w.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelKind: domain.KindRun}})
		if err != nil {
			return "", err
		}
		for _, c := range agents {
			if c.Name == RunContainerPrefix+rel.Run && c.State != "exited" && c.State != "dead" {
				return "", nil // the run goes on
			}
		}
		return fmt.Sprintf("the agent of run %s stopped before release %d was finished", rel.Run, rel.Seq), nil
	}
	if env.Current == 0 {
		return "", nil
	}
	cur, err := app.Release(env.Current)
	if err != nil || cur == nil {
		return "", err
	}
	if env.Previous > 0 && env.Previous != env.Current {
		if prev, err := app.Release(env.Previous); err != nil || (prev != nil && prev.Status == domain.StatusActive) {
			return fmt.Sprintf("release %d went live, but its run stopped before it finished", cur.Seq), err
		}
	}
	if env.LastSeq > env.Current {
		if latest, err := app.Release(env.LastSeq); err != nil || (latest != nil && latest.Status == domain.StatusFailed) {
			return "", err
		}
	}
	cs, err := w.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{
		domain.LabelProject: stack, domain.LabelKind: domain.KindService,
	}})
	if err != nil {
		return "", err
	}
	for _, c := range cs {
		if seq, ok := cur.Serving[c.Service]; !c.OneOff && c.Service != "" && (!ok || c.Release != seq) {
			return c.Name + " was left by a run that stopped", nil
		}
	}
	return "", nil
}

// quiet drops the errors the watchdog meets every time it looks, and must leave to a run: a held
// lock, and a state a newer Dockflow wrote.
func quiet(err error) error {
	switch errs.CodeOf(err) {
	case "lock.held", "state.newer", "state.schema":
		return nil
	}
	return err
}

// restoreFiles writes again, from their copies, the secret files of rel that are missing: a
// reboot empties the tmpfs (ADR-0012).
func (w *Watchdog) restoreFiles(app *state.App, rel *domain.Release) {
	wrote := false
	for _, f := range rel.Desired.Files {
		if !f.Secret {
			continue
		}
		if _, err := os.Stat(f.Path); err == nil {
			continue
		}
		b, err := os.ReadFile(SecretCopy(app.Dir(), f.Path))
		if err != nil {
			w.warn(fmt.Sprintf("the secret %s of %s is missing, and has no copy: deploy again", f.Name, rel.Desired.Stack))
			continue
		}
		if err := WriteSecretFile(f, string(b), "watchdog"); err != nil {
			w.warn(err.Error())
			continue
		}
		wrote = true
	}
	if wrote {
		w.Events.Info(events.Log, rel.Desired.Stack+": secret files written again", map[string]any{"line": "restore " + rel.Desired.Stack})
	}
}

// keptRunning tells whether Docker keeps the service's containers running.
func keptRunning(svc *domain.Service) bool {
	return svc.Spec.Restart == "unless-stopped" || svc.Spec.Restart == "always"
}

// mountsSecret tells whether the service mounts a Compose secret, which a reboot takes away.
func mountsSecret(svc *domain.Service) bool {
	for _, m := range svc.Spec.Mounts {
		if strings.HasPrefix(m.Source, domain.SecretsRoot+"/") {
			return true
		}
	}
	return false
}

func (w *Watchdog) warn(msg string) {
	w.Events.Warn(events.Warning, msg, map[string]any{"code": "watchdog.failed"})
}

// watchdogSpec is the watchdog's container: the agent's image, Docker's socket, the state, the
// secrets' tmpfs, and the switch's admin socket, to move routes back when it recovers a run. It
// needs no network.
func watchdogSpec(image string) domain.ContainerSpec {
	return domain.ContainerSpec{
		Image:       image,
		Entrypoint:  []string{"/dockflow", "watchdog"},
		Restart:     "unless-stopped",
		NetworkMode: "none",
		Mounts: []domain.Mount{
			{Type: "bind", Source: "/var/run/docker.sock", Target: "/var/run/docker.sock"},
			{Type: "bind", Source: state.Root, Target: state.Root, CreateHostPath: true},
			{Type: "bind", Source: "/run/dockflow", Target: "/run/dockflow", CreateHostPath: true},
			{Type: "volume", Source: SwitchAdminVolume, Target: SwitchAdminDir},
		},
		Logging: &domain.Logging{Driver: "json-file", Options: map[string]string{"max-size": "10m", "max-file": "3"}},
	}
}
