package agent

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/planner"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// plan computes and shows the plan, changing nothing: no lock, no pull.
func (r *runner) plan(ctx context.Context) events.RunFinishedData {
	if r.req.Desired == nil {
		return failed(errs.Usage("plan needs the desired app"))
	}
	desired, err := r.only(*r.req.Desired)
	if err != nil {
		return failed(err)
	}
	if err := r.resolve(ctx, &desired, false); err != nil {
		return failed(err)
	}
	o, err := observe(ctx, r.Engine, r.app, r.stack)
	if err != nil {
		return failed(err)
	}
	o.actual.Files = existingFiles(&desired)
	if err := r.checkSwitch(ctx, &desired); err != nil {
		return failed(err)
	}
	p, err := planner.Plan(desired, o.actual)
	if err != nil {
		return failed(err)
	}
	r.warnLimits(&desired)
	if msg, err := r.pendingRestore(o); err != nil {
		return failed(err)
	} else if msg != "" {
		r.warn("run.unfinished", msg)
		p.Warnings = append(p.Warnings, msg)
	}
	r.showPlan(p)
	if p.Empty() {
		return events.RunFinishedData{Outcome: events.OutcomeNoop}
	}
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// pendingRestore tells what the next run that takes the lock undoes before its plan, which is
// computed from the current release: a failed release left in place, or a run whose agent died.
func (r *runner) pendingRestore(o *observed) (string, error) {
	env := o.actual.Env
	abandoned, inPlace, err := r.unfinished(env)
	if err != nil || env == nil {
		return "", err
	}
	switch {
	case inPlace != nil && len(o.leftovers) > 0:
		return fmt.Sprintf("release %d failed and was left in place: the next run that takes the lock first rolls it back to release %d, then applies this plan", inPlace.Seq, env.Current), nil
	case len(abandoned) > 0 && abandoned[0].Status == domain.StatusApplying:
		return fmt.Sprintf("release %d is being applied by run %s; if that run stopped, the next run rolls it back to release %d first", abandoned[0].Seq, abandoned[0].Run, env.Current), nil
	}
	return "", nil
}

func (r *runner) showPlan(p *domain.Plan) {
	if p.Empty() {
		r.ev.Info(events.PlanEmpty, "nothing to change", nil)
		return
	}
	r.ev.Info(events.PlanComputed, fmt.Sprintf("%d to create, %d to update, %d to remove",
		p.Summary.Create, p.Summary.Update, p.Summary.Remove), p)
}

// deploy applies the desired app (deploy) or a recorded release (rollback) under the lock.
func (r *runner) deploy(ctx context.Context) events.RunFinishedData {
	l, err := r.lock(ctx)
	if err != nil {
		return failed(err)
	}
	defer r.unlock(l)
	defer r.leaveNetworks(ctx)

	if err := r.receive(); err != nil {
		return failed(err)
	}
	if err := r.recover(ctx); err != nil {
		return failed(err)
	}

	var desired domain.App
	var restart []string
	rollbackOf := 0
	version, source := r.req.Version, r.req.Source
	switch r.req.Op {
	case OpRollback:
		target, err := r.rollbackTarget()
		if err != nil {
			return failed(err)
		}
		desired, rollbackOf, version, source = target.Desired, target.Seq, target.Version, target.Source
		if len(r.req.Services) > 0 {
			// rollback --service: those services as the target has them, the rest as now
			cur, err := r.currentRelease()
			if err != nil {
				return failed(err)
			}
			if desired, err = planner.Only(target.Desired, cur.Desired, r.req.Services); err != nil {
				return failed(err)
			}
			desired.Uploads = cur.Desired.Uploads
			version, source = cur.Version, cur.Source
		}
		r.ev.Info(events.Log, fmt.Sprintf("rolling back to release %d (%s)", target.Seq, target.Version), map[string]any{"line": "target release " + strconv.Itoa(target.Seq)})
	case OpDeploy:
		if r.req.Desired == nil {
			return failed(errs.Usage("deploy needs the desired app"))
		}
		var err error
		if desired, err = r.only(*r.req.Desired); err != nil {
			return failed(err)
		}
	default:
		// restart, stop, scale, destroy --only: the current release, changed
		cur, err := r.currentRelease()
		if err != nil {
			return failed(err)
		}
		version, source = cur.Version, cur.Source
		if desired, restart, err = r.changed(cur.Desired); err != nil {
			return failed(err)
		}
	}
	if err := r.resolve(ctx, &desired, true); err != nil {
		return failed(err)
	}
	if err := r.checkSwitch(ctx, &desired); err != nil {
		return failed(err)
	}
	o, err := observe(ctx, r.Engine, r.app, r.stack)
	if err != nil {
		return failed(err)
	}
	o.actual.Files = existingFiles(&desired)
	p, err := planner.Plan(desired, o.actual, restart...)
	if err != nil {
		return failed(err)
	}
	if r.req.Op == OpDeploy {
		r.warnLimits(&desired)
	}
	r.showPlan(p)
	if r.req.Fingerprint != "" && r.req.Fingerprint != p.Fingerprint {
		return failed(errs.Plan("plan.stale", "the server changed since the plan was computed").
			WithHint("compute the plan again"))
	}
	if p.Empty() {
		return events.RunFinishedData{Outcome: events.OutcomeNoop}
	}
	if ctx.Err() != nil {
		return failed(interrupted())
	}

	// the release record comes first, so a dead agent leaves a trace (state-v1.md)
	env := o.actual.Env
	if env == nil {
		env = &domain.EnvRecord{}
	}
	seq := env.LastSeq + 1
	rel := &domain.Release{
		App: desired.Name, Env: desired.Env, Server: r.req.Server, Seq: seq, Version: version,
		Status: domain.StatusApplying, Run: r.req.Run, CreatedAt: r.Now().UTC(), CreatedBy: r.req.Author,
		Source: source, DockflowVersion: r.req.DockflowVersion, RollbackOf: rollbackOf, Desired: desired,
		PlanFingerprint: p.Fingerprint, Op: r.req.Op,
	}
	if err := r.app.WriteRelease(rel); err != nil {
		return failed(err)
	}
	env.LastSeq = seq
	if err := r.app.WriteEnv(*env); err != nil {
		return failed(err)
	}
	r.ev.Info(events.ReleaseCreated, fmt.Sprintf("release %d (%s)", seq, version), map[string]any{"seq": seq, "version": version})

	x := newExecution(o)
	runErr := r.execute(ctx, p, &desired, o, seq, x)
	if runErr == nil {
		runErr = r.checkPolicy(r.publicChecks(ctx))
	}
	if runErr == nil {
		runErr = r.execHooks(ctx, domain.HookAfterDeploy)
	}
	if runErr == nil {
		runErr = r.drain(ctx, x)
	}
	if runErr == nil {
		// a release that cannot be recorded as live rolls back, as any failure before the commit
		runErr = r.commit(rel, &desired, x)
	}
	if runErr == nil {
		r.finish(ctx, x)
		return events.RunFinishedData{Outcome: events.OutcomeSuccess, ReleaseSeq: seq}
	}
	return r.fail(ctx, rel, env, x, runErr)
}

// only applies --only to the desired app, against the current release: on a server where the app
// was never deployed, the named services are all there is.
func (r *runner) only(desired domain.App) (domain.App, error) {
	if len(r.req.Only) == 0 {
		return desired, nil
	}
	base := domain.App{Name: desired.Name, Env: desired.Env, Stack: desired.Stack}
	env, err := r.app.Env()
	if err != nil {
		return desired, err
	}
	if env != nil && env.Current != 0 {
		cur, err := r.currentRelease()
		if err != nil {
			return desired, err
		}
		base = cur.Desired
	}
	return planner.Only(desired, base, r.req.Only)
}

// releaseOf is the newest release of version that went live, other than the current one.
func (r *runner) releaseOf(version string, env *domain.EnvRecord) (int, error) {
	seqs, err := r.app.Releases()
	if err != nil {
		return 0, err
	}
	current := false
	for i := len(seqs) - 1; i >= 0; i-- {
		rel, err := r.app.Release(seqs[i])
		if err != nil {
			return 0, err
		}
		if rel == nil || rel.Version != version || (rel.Status != domain.StatusActive && rel.Status != domain.StatusSuperseded) {
			continue
		}
		if env != nil && rel.Seq == env.Current {
			current = true
			continue
		}
		return rel.Seq, nil
	}
	if current {
		return 0, errs.Plan("rollback.current", "version %s is the current release", version)
	}
	return 0, errs.Plan("rollback.unknown_release", "no kept release of version %s went live", version).
		WithHint("list the releases with `dockflow releases`")
}

func (r *runner) rollbackTarget() (*domain.Release, error) {
	env, err := r.app.Env()
	if err != nil {
		return nil, err
	}
	seq := r.req.Target
	if v := r.req.TargetVersion; v != "" {
		var err error
		if seq, err = r.releaseOf(v, env); err != nil {
			return nil, err
		}
	}
	if seq == 0 {
		if env == nil || env.Previous == 0 {
			return nil, errs.Plan("rollback.no_previous", "there is no previous release to roll back to").
				WithHint("list the releases with `dockflow releases`")
		}
		seq = env.Previous
	}
	if env != nil && seq == env.Current {
		return nil, errs.Plan("rollback.current", "release %d is the current release", seq)
	}
	rel, err := r.app.Release(seq)
	if err != nil {
		return nil, err
	}
	if rel == nil {
		return nil, errs.Plan("rollback.unknown_release", "release %d does not exist or is no longer kept", seq).
			WithHint("list the releases with `dockflow releases`")
	}
	if rel.Status != domain.StatusActive && rel.Status != domain.StatusSuperseded {
		return nil, errs.Plan("rollback.not_deployable", "release %d is %s; only a release that went live can be restored", seq, rel.Status)
	}
	return rel, nil
}

// resolve pins each image to its content. With pull, missing images are pulled according to
// the service's pull_policy; without, an image missing from the server stays unpinned.
func (r *runner) resolve(ctx context.Context, a *domain.App, pull bool) error {
	for i := range a.Services {
		s := &a.Services[i]
		ref := s.Spec.Image
		if ref == domain.FileServerImage {
			// a files route's server runs the switch's image (ADR-0011)
			srv, err := r.Store.Server()
			if err != nil {
				return err
			}
			if srv == nil || srv.SwitchImage == "" {
				return errs.Plan("plan.no_switch", "the files route %s needs the server's switch", s.Name).
					WithHint("run `dockflow server init`")
			}
			s.Spec.Image = srv.SwitchImage
			continue
		}
		if strings.HasPrefix(ref, "sha256:") {
			continue
		}
		if strings.Contains(ref, "@sha256:") {
			if !pull {
				continue
			}
			// a recorded release: pull it back only when it is gone
			ok, err := r.Engine.HasImage(ctx, ref)
			if err != nil {
				return err
			}
			if ok {
				continue
			}
		}
		policy := s.PullPolicy
		have, err := r.Engine.HasImage(ctx, ref)
		if err != nil {
			return err
		}
		if !pull {
			if !have || policy == "always" {
				continue
			}
			policy = "never"
		} else if (!have && policy != "never") || policy == "always" {
			r.ev.Info(events.Log, "pulling "+ref, map[string]any{"line": "pull " + ref})
		}
		pinned, err := r.Engine.ResolveImage(ctx, ref, policy, r.req.RegistryAuth)
		if err != nil {
			return err
		}
		s.Spec.Image = pinned
	}
	return nil
}

// checkSwitch refuses routes on a server without a switch.
func (r *runner) checkSwitch(ctx context.Context, a *domain.App) error {
	if !a.HasRoutes() {
		return nil
	}
	srv, err := r.Store.Server()
	if err != nil {
		return err
	}
	if srv != nil && srv.Edge == proxy.EdgeNone {
		return errs.Plan("plan.routes_without_switch", "this server has no switch (edge: none), and the app declares routes").
			WithHint("publish ports instead, or run `dockflow server init --edge builtin`")
	}
	cs, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelKind: domain.KindSwitch}})
	if err != nil {
		return err
	}
	if srv == nil || r.Switch == nil || len(cs) == 0 {
		return errs.Plan("plan.no_switch", "the app declares routes, and the server's switch is not installed").
			WithHint("run `dockflow server init`")
	}
	// the routes must fit with every other app's, and their raw directives must parse
	table, err := r.Store.SwitchRoutes()
	if err != nil {
		return err
	}
	serving := map[string][]string{}
	for _, s := range a.Services {
		serving[s.Name] = []string{s.Name}
	}
	mine := routesFor(r.stack, a, serving)
	table[r.stack] = mine
	if err := proxy.Unique(state.AllRoutes(table)); err != nil {
		return err
	}
	for _, rt := range mine {
		if rt.Caddy != "" {
			if _, err := r.Switch.Adapt(ctx, rt.Caddy); err != nil {
				if e, ok := errs.As(err); ok {
					e.Message = "service " + rt.Service + ": " + e.Message
				}
				return err
			}
		}
	}
	return nil
}

// execution tracks what a run changed, to commit or undo it.
type execution struct {
	steps []*step
	// serving holds the container names that serve each service now.
	serving map[string][]string
	// releaseOf is the release whose containers serve each service.
	releaseOf map[string]int
	// routesBefore is what the switch served for the app before the run.
	routesBefore  []proxy.Route
	routesTouched bool
	drain         time.Duration
}

type step struct {
	svc        *domain.Service
	old        []engine.Container
	created    []string // container IDs
	newNames   []string
	stopped    []string // old container IDs the run stopped
	renamed    map[string]string
	remove     bool
	drainOld   bool
	switchedAt time.Time
}

func newExecution(o *observed) *execution {
	x := &execution{serving: map[string][]string{}, releaseOf: map[string]int{}}
	for name, cs := range o.serving {
		for _, c := range cs {
			x.serving[name] = append(x.serving[name], c.Name)
		}
		x.releaseOf[name] = o.actual.Services[name].Release
	}
	return x
}

func (r *runner) execute(ctx context.Context, p *domain.Plan, desired *domain.App, o *observed, seq int, x *execution) error {
	table, err := r.Store.SwitchRoutes()
	if err != nil {
		return err
	}
	x.routesBefore = table[r.stack]
	hooksDone := false
	for _, a := range p.Actions {
		if ctx.Err() != nil {
			return interrupted()
		}
		if !hooksDone && changesServices(a.Kind) {
			// before_deploy: after the before jobs, before any service changes (ADR-0022)
			hooksDone = true
			if err := r.execHooks(ctx, domain.HookBeforeDeploy); err != nil {
				return err
			}
		}
		started := r.Now()
		r.ev.Info(events.ActionStarted, actionMessage(a), map[string]any{"action": a.ID})
		err := r.action(ctx, a, desired, o, seq, x)
		if err != nil {
			r.ev.Errorf(events.ActionFailed, fmt.Sprintf("%s %s failed: %v", a.Kind, a.Target, err), map[string]any{"action": a.ID, "error": errData(err)})
			return err
		}
		r.ev.Info(events.ActionFinished, fmt.Sprintf("%s %s done", a.Kind, a.Target), map[string]any{"action": a.ID, "duration_ms": r.Now().Sub(started).Milliseconds()})
	}
	return nil
}

func changesServices(kind string) bool {
	switch kind {
	case domain.ActionCreateService, domain.ActionUpdateService, domain.ActionRemoveService, domain.ActionRoutes:
		return true
	}
	return false
}

func actionMessage(a domain.Action) string {
	switch a.Kind {
	case domain.ActionCreateNetwork:
		return "creating network " + a.Target
	case domain.ActionCreateVolume:
		return "creating volume " + a.Target
	case domain.ActionCreateService:
		return "starting " + a.Target
	case domain.ActionUpdateService:
		return fmt.Sprintf("updating %s (%s)", a.Target, a.Strategy)
	case domain.ActionRemoveService:
		return "removing " + a.Target
	case domain.ActionRoutes:
		return "applying routes"
	case domain.ActionJob:
		return "running job " + a.Target
	case domain.ActionUpload:
		return "uploading to " + a.Target
	case domain.ActionPorts:
		return "public ports changed: the port filter follows once the release is live"
	case domain.ActionCreateSecret:
		return "writing the secret " + filepath.Base(a.Target)
	case domain.ActionCreateConfig:
		return "writing the config " + filepath.Base(a.Target)
	}
	return a.Kind + " " + a.Target
}

func (r *runner) action(ctx context.Context, a domain.Action, desired *domain.App, o *observed, seq int, x *execution) error {
	switch a.Kind {
	case domain.ActionCreateNetwork:
		for _, n := range desired.Networks {
			if n.Name == a.Target {
				return r.Engine.CreateNetwork(ctx, n, r.stack)
			}
		}
	case domain.ActionCreateVolume:
		for _, v := range desired.Volumes {
			if v.Name == a.Target {
				return r.Engine.CreateVolume(ctx, v, r.stack)
			}
		}
	case domain.ActionCreateService, domain.ActionUpdateService:
		s, _ := desired.Service(a.Target)
		return r.rollout(ctx, s, desired, o, seq, x)
	case domain.ActionRemoveService:
		st := &step{svc: &domain.Service{Name: a.Target}, old: o.serving[a.Target], remove: true}
		x.steps = append(x.steps, st)
		delete(x.serving, a.Target)
		if err := r.setRoutes(ctx, desired, x); err != nil {
			return err
		}
		return r.stopOld(ctx, st, nil)
	case domain.ActionRoutes:
		return r.setRoutes(ctx, desired, x)
	case domain.ActionJob:
		s, _ := desired.Service(a.Target)
		return r.runJob(ctx, s, seq)
	case domain.ActionUpload:
		return r.upload(ctx, desired, a.Target)
	case domain.ActionCreateSecret, domain.ActionCreateConfig:
		return r.writeFile(desired, a.Target)
	}
	return nil
}

// rollout moves one service to the new release with its strategy (ADR-0010).
func (r *runner) rollout(ctx context.Context, s *domain.Service, desired *domain.App, o *observed, seq int, x *execution) error {
	st := &step{svc: s, old: o.serving[s.Name], renamed: map[string]string{}}
	x.steps = append(x.steps, st)
	oldRelease := o.actual.Services[s.Name].Release

	switch s.Strategy {
	case domain.StrategyStopFirst:
		if err := r.stopOld(ctx, st, s.Spec.StopGrace); err != nil {
			return err
		}
		if s.ContainerName != "" {
			// the new container takes the fixed name; the old one keeps a release-scoped name until commit
			for _, c := range st.old {
				tmp := domain.ContainerName(r.stack, s.Name, oldRelease, max(number(c), 1))
				if c.Name == tmp {
					continue
				}
				// recorded first: a rename that fails may have happened all the same
				st.renamed[c.ID] = c.Name
				if err := r.Engine.Rename(ctx, c.ID, tmp); err != nil {
					return err
				}
			}
		}
		if err := r.startNew(ctx, s, seq, st); err != nil {
			return err
		}
		r.serve(x, s, seq, st)
		if len(s.Routes) > 0 {
			return r.switchTo(ctx, desired, s, oldRelease, seq, x)
		}
	case domain.StrategyStartFirst:
		if err := r.startNew(ctx, s, seq, st); err != nil {
			return err
		}
		r.serve(x, s, seq, st)
		if len(s.Routes) > 0 {
			if err := r.switchTo(ctx, desired, s, oldRelease, seq, x); err != nil {
				return err
			}
		}
		return r.stopOld(ctx, st, s.Spec.StopGrace)
	default: // switch
		if err := r.startNew(ctx, s, seq, st); err != nil {
			return err
		}
		r.serve(x, s, seq, st)
		if len(s.Routes) == 0 {
			return r.stopOld(ctx, st, s.Spec.StopGrace)
		}
		if err := r.switchTo(ctx, desired, s, oldRelease, seq, x); err != nil {
			return err
		}
		if len(st.old) > 0 {
			st.drainOld = true
			st.switchedAt = r.Now()
			x.drain = max(x.drain, s.Drain.D())
		}
	}
	return nil
}

func (r *runner) serve(x *execution, s *domain.Service, seq int, st *step) {
	x.serving[s.Name] = st.newNames
	x.releaseOf[s.Name] = seq
}

func (r *runner) switchTo(ctx context.Context, desired *domain.App, s *domain.Service, from, to int, x *execution) error {
	if err := r.setRoutes(ctx, desired, x); err != nil {
		return err
	}
	r.ev.Info(events.SwitchChanged, fmt.Sprintf("%s: traffic now goes to release %d", s.Name, to), map[string]any{
		"service": s.Name, "from_release": from, "to_release": to, "routes": routeDomains(s.Routes),
	})
	return nil
}

func routeDomains(rs []domain.Route) []string {
	var out []string
	for _, r := range rs {
		for _, d := range r.Domains {
			out = append(out, d+r.Path)
		}
	}
	return out
}

func containerLabels(stack string, s *domain.Service, seq, n int) map[string]string {
	return map[string]string{
		domain.LabelProject:   stack,
		domain.LabelService:   s.Name,
		domain.LabelNumber:    strconv.Itoa(n),
		domain.LabelOneOff:    "False",
		domain.LabelSchema:    "1",
		domain.LabelRelease:   strconv.Itoa(seq),
		domain.LabelKind:      domain.KindService,
		domain.LabelHash:      s.Hash(),
		domain.LabelManagedBy: "true",
	}
}

// startNew creates and starts the containers of release seq, and waits until they are healthy.
func (r *runner) startNew(ctx context.Context, s *domain.Service, seq int, st *step) error {
	for n := 1; n <= s.Count(); n++ {
		name := containerName(r.stack, s, seq, n)
		id, err := r.Engine.Create(ctx, name, s.Spec, containerLabels(r.stack, s, seq, n))
		if err != nil {
			// a create that failed may have created it all the same: undo removes it
			if c, ierr := r.Engine.Inspect(ctx, name); ierr == nil && c.Release == seq && c.Labels[domain.LabelProject] == r.stack {
				st.created = append(st.created, c.ID)
			}
			return err
		}
		st.created = append(st.created, id)
		st.newNames = append(st.newNames, name)
		r.containerState(s.Name, name, seq, "created", nil)
		if err := r.Engine.Start(ctx, id); err != nil {
			if errs.CodeOf(err) == engine.CodePortInUse {
				r.ev.Errorf(events.ServiceFailed, s.Name+": a published port is in use", map[string]any{"service": s.Name, "reason": "port_in_use"})
			}
			return err
		}
		r.containerState(s.Name, name, seq, "running", nil)
	}
	timeout := healthTimeout(s, r.req.Timeout.D())
	errc := make([]error, len(st.created))
	var wg sync.WaitGroup
	for i, id := range st.created {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errc[i] = r.Engine.WaitHealthy(ctx, id, s.HealthGrace.D(), timeout)
			if errc[i] == nil {
				r.containerState(s.Name, st.newNames[i], seq, "healthy", nil)
			}
		}()
	}
	wg.Wait()
	for _, err := range errc {
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return interrupted()
		}
		var he *engine.HealthError
		if errors.As(err, &he) {
			r.ev.Errorf(events.ServiceFailed, fmt.Sprintf("%s: %s", s.Name, he.Reason), map[string]any{"service": s.Name, "reason": he.Kind})
			return errs.Newf("health.failed", errs.ExitRolledBack, "service %s did not become healthy: %s", s.Name, he.Reason).
				WithHint("look at its logs with `dockflow logs %s`", s.Name)
		}
		return err
	}
	r.ev.Info(events.ServiceHealthy, fmt.Sprintf("%s: %d/%d healthy", s.Name, s.Count(), s.Count()), map[string]any{
		"service": s.Name, "healthy": s.Count(), "desired": s.Count(),
	})
	return r.checkPolicy(r.checkContainers(ctx, s, st.newNames))
}

func (r *runner) containerState(svc, name string, seq int, st string, extra map[string]any) {
	data := map[string]any{"service": svc, "container": name, "release": seq, "state": st}
	for k, v := range extra {
		data[k] = v
	}
	r.ev.Debug(events.ContainerState, name+" "+st, data)
}

// stopOld stops the old containers of a step; they are kept until the run commits.
func (r *runner) stopOld(ctx context.Context, st *step, grace *domain.Duration) error {
	var g *time.Duration
	if grace != nil {
		d := grace.D()
		g = &d
	}
	for _, c := range st.old {
		if c.State != "running" && c.State != "restarting" {
			continue
		}
		// recorded first: a stop that fails may have stopped it all the same, and undo starts it
		st.stopped = append(st.stopped, c.ID)
		if err := r.Engine.Stop(ctx, c.ID, g); err != nil {
			if now, ierr := r.Engine.Inspect(ctx, c.ID); ierr != nil || now.State == "running" || now.State == "restarting" {
				return err
			}
		}
		r.containerState(c.Service, c.Name, c.Release, "exited", nil)
	}
	return nil
}

// healthTimeout is how long a container may take to become healthy (ADR-0010).
func healthTimeout(s *domain.Service, override time.Duration) time.Duration {
	if override > 0 {
		return override
	}
	h := s.Spec.Healthcheck
	if h == nil || h.Disable || len(h.Test) == 0 || h.Test[0] == "NONE" {
		return s.HealthGrace.D() + 60*time.Second
	}
	interval, timeout, start, retries := 30*time.Second, 30*time.Second, time.Duration(0), uint64(3)
	if h.Interval != nil {
		interval = h.Interval.D()
	}
	if h.Timeout != nil {
		timeout = h.Timeout.D()
	}
	if h.StartPeriod != nil {
		start = h.StartPeriod.D()
	}
	if h.Retries != nil {
		retries = *h.Retries
	}
	return max(start+(interval+timeout)*time.Duration(retries+1)+30*time.Second, 60*time.Second)
}

// routesFor returns the routes of a, served by the given containers.
func routesFor(stack string, a *domain.App, serving map[string][]string) []proxy.Route {
	var out []proxy.Route
	for _, s := range a.Services {
		for _, rt := range s.Routes {
			if len(serving[s.Name]) == 0 {
				continue
			}
			path := rt.Path
			if path == "" {
				path = "/"
			}
			route := proxy.Route{
				Stack: stack, Service: s.Name, Domains: rt.Domains, Path: path, Port: rt.Port,
				TLS: rt.TLS, StripPrefix: rt.StripPrefix, Upstreams: append([]string(nil), serving[s.Name]...),
				Headers: rt.Headers, Encode: rt.Encode, MaxBody: rt.MaxBody, Timeouts: rt.Timeouts, Caddy: rt.Caddy,
			}
			route.Name, route.ErrorPages = rt.Name, rt.ErrorPages
			if rt.Auth != nil {
				route.AuthUser, route.AuthPassword = rt.Auth.User, rt.Auth.Password
			}
			if len(s.Spec.Networks) > 0 {
				route.Network = s.Spec.Networks[0].Network
			}
			out = append(out, route)
		}
	}
	// the routes of dockflow.yml: redirects and proxies, which no container serves
	for i, ar := range a.Routes {
		name := ar.Name
		if name == "" {
			name = strconv.Itoa(i)
		}
		rt := ar.Route
		route := proxy.Route{
			Stack: stack, Service: "routes." + name, Name: ar.Name, Domains: rt.Domains, Path: rt.Path, TLS: rt.TLS,
			StripPrefix: rt.StripPrefix, Upstreams: []string{}, Network: ar.Network,
			Headers: rt.Headers, Encode: rt.Encode, MaxBody: rt.MaxBody, Timeouts: rt.Timeouts, Caddy: rt.Caddy,
			ErrorPages: rt.ErrorPages, Redirect: ar.Redirect, RedirectStatus: ar.Status, ProxyURL: ar.Proxy,
		}
		if rt.Auth != nil {
			route.AuthUser, route.AuthPassword = rt.Auth.User, rt.Auth.Password
		}
		out = append(out, route)
	}
	return out
}

// setRoutes points the switch at the containers that serve the app now.
func (r *runner) setRoutes(ctx context.Context, desired *domain.App, x *execution) error {
	x.routesTouched = true
	return r.applyRoutes(ctx, routesFor(r.stack, desired, x.serving))
}

// applyRoutes replaces the app's routes in the switch, under the server lock, after joining
// the switch to the networks of the routed services.
func (r *runner) applyRoutes(ctx context.Context, routes []proxy.Route) error {
	l, err := r.Store.LockServer()
	if err != nil {
		return err
	}
	defer l.Release()
	table, err := r.Store.SwitchRoutes()
	if err != nil {
		return err
	}
	if len(routes) == 0 && len(table[r.stack]) == 0 {
		return nil
	}
	if r.Switch == nil {
		return errs.Plan("plan.no_switch", "the server's switch is not installed").WithHint("run `dockflow server init`")
	}
	if err := r.prepareRoutes(ctx, routes, table[r.stack]); err != nil {
		return err
	}
	if err := r.joinNetworks(ctx, routes); err != nil {
		return err
	}
	srv, err := r.Store.Server()
	if err != nil {
		return err
	}
	table[r.stack] = routes
	// the switch keeps serving if the agent dies here: the files follow what it serves
	if err := r.Switch.Apply(context.WithoutCancel(ctx), switchConfig(srv, state.AllRoutes(table))); err != nil {
		return err
	}
	if err := r.Store.SetSwitchRoutes(r.stack, routes); err != nil {
		return err
	}
	var domains []string
	for _, rt := range routes {
		domains = append(domains, rt.Domains...)
	}
	sort.Strings(domains)
	r.ev.Debug(events.RoutesApplied, "routes applied", map[string]any{"domains": domains})
	return nil
}

// drain gives requests in flight on the old containers of switched services time to finish,
// then stops those containers.
func (r *runner) drain(ctx context.Context, x *execution) error {
	var waiting []*step
	for _, st := range x.steps {
		if st.drainOld {
			waiting = append(waiting, st)
		}
	}
	if len(waiting) == 0 {
		return nil
	}
	var until time.Time
	for _, st := range waiting {
		end := st.switchedAt.Add(st.svc.Drain.D())
		if end.After(until) {
			until = end
		}
		r.ev.Info(events.DrainStarted, fmt.Sprintf("%s: draining release %d for %s", st.svc.Name, st.old[0].Release, st.svc.Drain.D()), map[string]any{
			"service": st.svc.Name, "release": st.old[0].Release, "timeout_ms": st.svc.Drain.D().Milliseconds(),
		})
	}
	if wait := until.Sub(r.Now()); wait > 0 {
		select {
		case <-ctx.Done():
			return interrupted()
		case <-time.After(wait):
		}
	}
	for _, st := range waiting {
		if err := r.stopOld(ctx, st, st.svc.Spec.StopGrace); err != nil {
			return err
		}
	}
	return nil
}

// commit makes the release current. The write of env.json, a rename, is the commit point
// (state-v1.md): before it, the run rolls back; after it, the release is live whatever happens
// next, and the next run, or the watchdog, completes it.
func (r *runner) commit(rel *domain.Release, desired *domain.App, x *execution) error {
	now := r.Now().UTC()
	rel.FinishedAt = &now
	rel.Serving = map[string]int{}
	rel.Hashes = map[string]string{}
	for _, s := range desired.Services {
		rel.Serving[s.Name] = x.releaseOf[s.Name]
		rel.Hashes[s.Name] = s.Hash()
	}
	// what serves is recorded first, still applying: env.json names a complete record
	if err := r.app.WriteRelease(rel); err != nil {
		return commitFailed(rel.Seq, err)
	}
	env, err := r.app.Env()
	if err != nil {
		return commitFailed(rel.Seq, err)
	}
	next := domain.EnvRecord{LastSeq: rel.Seq}
	if env != nil {
		next = *env
	}
	if next.Current > 0 {
		next.Previous = next.Current
	}
	next.Current, next.Degraded = rel.Seq, false
	if err := r.app.WriteEnv(next); err != nil {
		// a write that failed after its rename committed all the same
		now, rerr := r.app.Env()
		switch {
		case rerr != nil:
			r.warn("state.write_failed", fmt.Sprintf("cannot tell whether release %d was recorded as live: %v; the next run settles it", rel.Seq, err))
		case now == nil || now.Current != rel.Seq:
			return commitFailed(rel.Seq, err)
		}
	}
	return nil
}

func commitFailed(seq int, err error) error {
	return errs.Newf("state.commit_failed", errs.ExitRolledBack, "release %d could not be recorded as live", seq).WithCause(err).
		WithHint("check the disk of the server (df -h /var/lib/dockflow), then deploy again")
}

// finish completes a committed release: the statuses follow env.json, and the containers it
// replaced go. A failure here is a warning: the release is live, and the next run, or the
// watchdog, completes it.
func (r *runner) finish(ctx context.Context, x *execution) {
	ctx = context.WithoutCancel(ctx)
	if err := r.settle(); err != nil {
		r.warn("state.write_failed", "the release is live, but its status could not be recorded: "+err.Error()+"; the next run records it")
	}
	for _, st := range x.steps {
		for _, c := range st.old {
			if err := r.Engine.Remove(ctx, c.ID); err != nil {
				r.warn("cleanup.failed", fmt.Sprintf("cannot remove %s: %v", c.Name, err))
			}
		}
	}
	r.forgetBaselines()
	r.pruneReleases(ctx)
}

// settle makes the statuses of the releases agree with env.json, the commit point: the current
// release is active, and the previous one superseded. It completes a commit that an agent did not
// finish.
func (r *runner) settle() error {
	env, err := r.app.Env()
	if err != nil || env == nil || env.Current == 0 {
		return err
	}
	cur, err := r.app.Release(env.Current)
	if err != nil {
		return err
	}
	if cur != nil && cur.Status == domain.StatusApplying {
		cur.Status = domain.StatusActive
		if cur.FinishedAt == nil {
			now := r.Now().UTC()
			cur.FinishedAt = &now
		}
		if err := r.app.WriteRelease(cur); err != nil {
			return err
		}
	}
	if env.Previous == 0 || env.Previous == env.Current {
		return nil
	}
	prev, err := r.app.Release(env.Previous)
	if err != nil || prev == nil || prev.Status != domain.StatusActive {
		return err
	}
	prev.Status = domain.StatusSuperseded
	return r.app.WriteRelease(prev)
}

// pruneReleases applies the retention rule and removes the images no kept release uses.
func (r *runner) pruneReleases(ctx context.Context) {
	keep := r.req.Keep
	if keep < 2 {
		keep = 10
	}
	kept, deleted, err := r.app.Prune(keep)
	if err != nil {
		r.warn("cleanup.failed", "cannot prune releases: "+err.Error())
		return
	}
	r.pruneUploads(kept)
	for _, rel := range kept {
		r.keepCopies(&rel.Desired)
	}
	r.pruneFiles(kept)
	if err := r.syncFilter(ctx); err != nil {
		r.warn("filter.failed", err.Error())
	}
	used := map[string]bool{}
	for _, rel := range kept {
		for _, s := range rel.Desired.Services {
			used[s.Spec.Image] = true
		}
	}
	var gone []string
	for _, rel := range deleted {
		for _, s := range rel.Desired.Services {
			if img := s.Spec.Image; !used[img] {
				used[img] = true // once
				gone = append(gone, img)
				if err := r.Engine.RemoveImage(ctx, img); err != nil {
					r.warn("cleanup.failed", fmt.Sprintf("cannot remove image %s: %v", img, err))
				}
			}
		}
	}
	r.forgetImages(ctx, gone)
}

// joinNetworks connects the switch to the networks it reaches routes through.
func (r *runner) joinNetworks(ctx context.Context, routes []proxy.Route) error {
	seen := map[string]bool{}
	for _, rt := range routes {
		if rt.Network == "" || seen[rt.Network] {
			continue
		}
		seen[rt.Network] = true
		if err := r.Engine.Connect(ctx, rt.Network, SwitchContainer, nil); err != nil {
			return err
		}
	}
	return nil
}

func (r *runner) warn(code, msg string) {
	r.ev.Warn(events.Warning, msg, map[string]any{"code": code, "detail": msg})
}

// fail handles a run that failed after the release was created: it rolls back, or leaves the
// environment in place and degraded (ADR-0008). Only a failed HTTP check may be left in place: a
// failure of the rollout itself always rolls back.
func (r *runner) fail(ctx context.Context, rel *domain.Release, env *domain.EnvRecord, x *execution, runErr error) events.RunFinishedData {
	cancelled := ctx.Err() != nil || errs.ExitCode(runErr) == errs.ExitInterrupted
	if cancelled {
		r.ev.Warn(events.CancelRequested, "cancelled", map[string]any{"by": "signal"})
	}
	ctx = context.WithoutCancel(ctx)
	now := r.Now().UTC()
	rel.FinishedAt = &now
	// a commit that failed may have recorded them
	rel.Serving, rel.Hashes = nil, nil
	rel.Error = &domain.ReleaseError{Code: errs.CodeOf(runErr), Message: errData(runErr).Message}
	if rel.Error.Code == "" {
		rel.Error.Code = "run.cancelled"
	}

	leaveInPlace := !cancelled && (r.req.NoRollback || r.req.OnFailure == "fail") && errs.CodeOf(runErr) == checkFailed
	var undoErr error
	if !leaveInPlace {
		r.ev.Warn(events.RollbackStarted, "rolling back to the previous containers", map[string]any{"reason": rel.Error.Message, "target_seq": env.Current})
		undoErr = r.undo(ctx, x)
		r.ev.Info(events.RollbackFinished, "rollback finished", map[string]any{"ok": undoErr == nil})
	}
	if err := r.execHooks(ctx, domain.HookAfterFailure); err != nil {
		r.warn("hook.failed", err.Error())
	}
	cur, _ := r.app.Env()
	if cur == nil {
		cur = env
	}
	res := events.RunFinishedData{ReleaseSeq: rel.Seq, Error: errData(runErr)}
	switch {
	case leaveInPlace || undoErr != nil:
		rel.Status = domain.StatusFailed
		cur.Degraded = true
		res.Outcome, res.ExitCode = events.OutcomeFailed, errs.ExitDegraded
		if undoErr != nil {
			res.Error = errData(errs.Newf("rollback.failed", errs.ExitDegraded, "%s; the rollback failed too: %v", rel.Error.Message, undoErr).
				WithHint("the environment is degraded: fix the cause and deploy again"))
		}
	case cancelled:
		rel.Status = domain.StatusRolledBack
		res.Outcome, res.ExitCode = events.OutcomeCancelled, errs.ExitInterrupted
	case errs.ExitCode(runErr) == errs.ExitHook:
		rel.Status = domain.StatusRolledBack
		res.Outcome, res.ExitCode = events.OutcomeHookFailed, errs.ExitHook
	default:
		rel.Status = domain.StatusRolledBack
		res.Outcome, res.ExitCode = events.OutcomeRolledBack, errs.ExitRolledBack
	}
	if err := r.app.WriteRelease(rel); err != nil {
		r.warn("state.write_failed", err.Error())
	}
	if err := r.app.WriteEnv(*cur); err != nil {
		r.warn("state.write_failed", err.Error())
	}
	return res
}

// undo restores the containers and routes the run started from. Old containers come back first,
// then the switch moves back to them, then the new containers go.
func (r *runner) undo(ctx context.Context, x *execution) error {
	var errsSeen []string
	note := func(err error) {
		if err != nil {
			errsSeen = append(errsSeen, err.Error())
		}
	}
	var restarted []string
	for i := len(x.steps) - 1; i >= 0; i-- {
		st := x.steps[i]
		if st.svc.Strategy == domain.StrategyStopFirst {
			// the new containers hold the fixed name or the host ports
			for _, id := range st.created {
				note(r.Engine.Remove(ctx, id))
			}
			st.created = nil
			for _, id := range slices.Sorted(maps.Keys(st.renamed)) {
				note(r.rename(ctx, id, st.renamed[id]))
			}
		}
		for _, id := range st.stopped {
			if err := r.Engine.Start(ctx, id); err != nil {
				note(err)
				continue
			}
			restarted = append(restarted, id)
		}
	}
	for _, err := range r.waitAll(ctx, restarted) {
		note(err)
	}
	if x.routesTouched {
		note(r.applyRoutes(ctx, x.routesBefore))
	}
	note(r.undoUploads(ctx))
	for _, st := range x.steps {
		for _, id := range st.created {
			note(r.Engine.Remove(ctx, id))
		}
	}
	if len(errsSeen) > 0 {
		return errors.New(strings.Join(errsSeen, "; "))
	}
	return nil
}

// waitAll waits, in parallel, until the restarted containers ids are healthy again.
func (r *runner) waitAll(ctx context.Context, ids []string) []error {
	out := make([]error, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Go(func() { out[i] = r.Engine.WaitHealthy(ctx, id, 2*time.Second, 2*time.Minute) })
	}
	wg.Wait()
	return out
}

// rename gives container id its name back, unless it has it.
func (r *runner) rename(ctx context.Context, id, name string) error {
	if c, err := r.Engine.Inspect(ctx, id); err == nil && c.Name == name {
		return nil
	}
	return r.Engine.Rename(ctx, id, name)
}
