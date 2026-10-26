package agent

import (
	"context"
	"fmt"
	"sort"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// recover brings the environment back to its current release after a run that did not finish:
// an agent that died, or a failed run left in place. It runs under the lock, before planning.
func (r *runner) recover(ctx context.Context) error {
	env, err := r.app.Env()
	if err != nil {
		return err
	}
	unfinished := false
	if env != nil && env.LastSeq > env.Current {
		rel, err := r.app.Release(env.LastSeq)
		if err != nil {
			return err
		}
		if rel != nil && rel.Status == domain.StatusApplying {
			now := r.Now().UTC()
			rel.Status, rel.FinishedAt = domain.StatusAbandoned, &now
			rel.Error = &domain.ReleaseError{Code: "run.abandoned", Message: "the agent stopped before the run finished"}
			if err := r.app.WriteRelease(rel); err != nil {
				return err
			}
			r.warn("run.abandoned", fmt.Sprintf("release %d was abandoned by run %s: restoring release %d", rel.Seq, rel.Run, env.Current))
			unfinished = true
		}
	}
	o, err := observe(ctx, r.Engine, r.app, r.stack)
	if err != nil {
		return err
	}
	if len(o.leftovers) == 0 && !unfinished {
		return nil
	}
	for _, c := range o.leftovers {
		r.warn("run.leftover", fmt.Sprintf("removing %s, left by an unfinished run", c.Name))
		if err := r.Engine.Remove(ctx, c.ID); err != nil {
			return err
		}
	}
	serving := map[string][]string{}
	for name, cs := range o.serving {
		var s *domain.Service
		if o.current != nil {
			s, _ = o.current.Desired.Service(name)
		}
		for _, c := range cs {
			proper := c.Name
			if s != nil {
				proper = containerName(r.stack, s, c.Release, max(number(c), 1))
			}
			if c.Name != proper {
				if err := r.Engine.Rename(ctx, c.ID, proper); err != nil {
					return err
				}
			}
			if c.State != "running" && c.State != "restarting" {
				r.warn("run.restarted", "starting "+proper+", stopped by an unfinished run")
				if err := r.Engine.Start(ctx, c.ID); err != nil {
					return err
				}
			}
			serving[name] = append(serving[name], proper)
		}
	}
	var routes []proxy.Route
	if o.current != nil {
		routes = routesFor(r.stack, &o.current.Desired, serving)
	}
	return r.applyRoutes(ctx, routes)
}

func (r *runner) status(ctx context.Context) events.RunFinishedData {
	o, err := observe(ctx, r.Engine, r.app, r.stack)
	if err != nil {
		return failed(err)
	}
	st := Status{App: r.req.App, Env: r.req.Env, State: o.actual.Env, Services: []ServiceStatus{}}
	if st.Lock, err = r.app.ManualLock(); err != nil {
		return failed(err)
	}
	names := map[string]bool{}
	if o.current != nil {
		sum := Summarise(o.current)
		st.Current = &sum
		for _, s := range o.current.Desired.Services {
			names[s.Name] = true
		}
	}
	for name := range o.actual.Services {
		names[name] = true
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	for _, name := range sorted {
		ss := ServiceStatus{Name: name, Containers: []domain.ContainerInfo{}}
		if o.current != nil {
			if s, ok := o.current.Desired.Service(name); ok {
				ss.Strategy, ss.Desired = s.Strategy, s.Replicas
				for _, rt := range s.Routes {
					for _, d := range rt.Domains {
						ss.Domains = append(ss.Domains, d+rt.Path)
					}
				}
			}
		}
		if as, ok := o.actual.Services[name]; ok {
			ss.Release = as.Release
			ss.Containers = as.Containers
			for _, c := range as.Containers {
				if c.State == "running" && c.Health != "unhealthy" {
					ss.Running++
				}
			}
		}
		st.Services = append(st.Services, ss)
	}
	r.result(st)
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

func (r *runner) releases() events.RunFinishedData {
	seqs, err := r.app.Releases()
	if err != nil {
		return failed(err)
	}
	env, err := r.app.Env()
	if err != nil {
		return failed(err)
	}
	list := []ReleaseSummary{}
	for i := len(seqs) - 1; i >= 0; i-- {
		rel, err := r.app.Release(seqs[i])
		if err != nil {
			return failed(err)
		}
		if rel != nil {
			list = append(list, Summarise(rel))
		}
	}
	r.result(map[string]any{"state": env, "releases": list})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// Switch volumes: Caddy's data (certificates), its autosaved configuration, and the admin socket.
const (
	SwitchAdminVolume  = "dockflow-switch-admin"
	switchDataVolume   = "dockflow-switch-data"
	switchConfigVolume = "dockflow-switch-config"
	// DefaultSwitchImage is the official Caddy image; it is pinned by digest when installed.
	DefaultSwitchImage = "caddy:2"
)

// SwitchAdminDir is where the admin socket's volume is mounted, in the switch and in the agent.
const SwitchAdminDir = "/run/dockflow-switch"

// serverInit installs or updates the switch and records the server's settings.
func (r *runner) serverInit(ctx context.Context) events.RunFinishedData {
	edge := r.req.Edge
	if edge == "" {
		edge = proxy.EdgeBuiltin
	}
	if edge != proxy.EdgeBuiltin && edge != proxy.EdgeNone {
		return failed(errs.Usage("edge %q is not available yet: use builtin or none", edge))
	}
	l, err := r.Store.LockServer()
	if err != nil {
		return failed(err)
	}
	table, err := r.Store.SwitchRoutes()
	l.Release()
	if err != nil {
		return failed(err)
	}
	existing, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelKind: domain.KindSwitch}})
	if err != nil {
		return failed(err)
	}
	srv := state.Server{Name: r.req.Server, Edge: edge, DockflowVersion: r.req.DockflowVersion}

	if edge == proxy.EdgeNone {
		if routes := state.AllRoutes(table); len(routes) > 0 {
			return failed(errs.Plan("server.routes_in_use", "%d routes still go through the switch", len(routes)).
				WithHint("remove the routes of the apps on this server first"))
		}
		for _, c := range existing {
			if err := r.Engine.Remove(ctx, c.ID); err != nil {
				return failed(err)
			}
		}
		if err := r.Store.WriteServer(srv); err != nil {
			return failed(err)
		}
		r.result(srv)
		return events.RunFinishedData{Outcome: events.OutcomeSuccess}
	}

	image := r.req.SwitchImage
	if image == "" {
		image = DefaultSwitchImage
	}
	pinned, err := r.Engine.ResolveImage(ctx, image, "missing")
	if err != nil {
		return failed(err)
	}
	srv.SwitchImage = pinned
	spec := switchSpec(pinned)
	labels := map[string]string{
		domain.LabelKind: domain.KindSwitch, domain.LabelSchema: "1", domain.LabelManagedBy: "true",
		domain.LabelHash: (&domain.Service{Name: SwitchContainer, Spec: spec, Replicas: 1}).Hash(),
	}
	var keep *engine.Container
	for i, c := range existing {
		if c.Hash == labels[domain.LabelHash] && keep == nil {
			keep = &existing[i]
			continue
		}
		r.ev.Info(events.Log, "replacing the switch", map[string]any{"line": "remove " + c.Name})
		if err := r.Engine.Remove(ctx, c.ID); err != nil {
			return failed(err)
		}
	}
	if keep == nil {
		id, err := r.Engine.Create(ctx, SwitchContainer, spec, labels)
		if err != nil {
			return failed(err)
		}
		if err := r.Engine.Start(ctx, id); err != nil {
			return failed(errs.New("server.switch_start", errs.ExitInternal, "the switch cannot start").WithCause(err).
				WithHint("ports 80 and 443 must be free on the server"))
		}
		r.ev.Info(events.Log, "switch installed", map[string]any{"line": SwitchContainer + " " + pinned})
	} else if keep.State != "running" {
		if err := r.Engine.Start(ctx, keep.ID); err != nil {
			return failed(err)
		}
	}
	if err := r.Store.WriteServer(srv); err != nil {
		return failed(err)
	}
	// a new switch starts empty: give it every app's routes back
	routes := state.AllRoutes(table)
	if err := r.joinNetworks(ctx, routes); err != nil {
		return failed(err)
	}
	if r.Switch == nil {
		return failed(errs.Internal("the agent has no switch client"))
	}
	if err := r.Switch.Apply(ctx, proxy.Config{Edge: edge, Routes: routes}); err != nil {
		return failed(err)
	}
	r.result(srv)
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

func switchSpec(image string) domain.ContainerSpec {
	return domain.ContainerSpec{
		Image:   image,
		Command: []string{"caddy", "run", "--resume"},
		Env:     []string{"CADDY_ADMIN=unix/" + SwitchAdminDir + "/admin.sock"},
		Restart: "unless-stopped",
		Ports: []domain.Port{
			{HostPort: "80", ContainerPort: 80, Protocol: "tcp"},
			{HostPort: "443", ContainerPort: 443, Protocol: "tcp"},
			{HostPort: "443", ContainerPort: 443, Protocol: "udp"},
		},
		Mounts: []domain.Mount{
			{Type: "volume", Source: switchDataVolume, Target: "/data"},
			{Type: "volume", Source: switchConfigVolume, Target: "/config"},
			{Type: "volume", Source: SwitchAdminVolume, Target: SwitchAdminDir},
		},
		Logging: &domain.Logging{Driver: "json-file", Options: map[string]string{"max-size": "10m", "max-file": "3"}},
	}
}
