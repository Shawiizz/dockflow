package agent

import (
	"context"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// maintenance turns the environment's maintenance mode on or off (ADR-0011). It is recorded with
// the environment's routes, so deploys keep it, and changes the switch's configuration, which is
// reloaded. It takes the server's lock, not the environment's: it works while a deploy hangs.
func (r *runner) maintenance(ctx context.Context) events.RunFinishedData {
	var m *proxy.Maintenance
	if r.req.Op == OpMaintenanceOn {
		m = &proxy.Maintenance{By: by(r.req.Author), Since: r.Now().UTC()}
		if q := r.req.Maintenance; q != nil {
			if len(q.Page) > proxy.MaxMaintenancePage {
				return failed(errs.Usage("the maintenance page is larger than %d KiB", proxy.MaxMaintenancePage>>10))
			}
			m.Page, m.Allow = q.Page, q.Allow
		}
	}
	l, err := r.Store.LockServer()
	if err != nil {
		return failed(err)
	}
	defer l.Release()
	table, err := r.Store.SwitchRoutes()
	if err != nil {
		return failed(err)
	}
	routes := table[r.stack]
	if len(routes) == 0 {
		return failed(errs.Plan("maintenance.no_routes", "%s has no routes: the switch serves nothing for it", r.stack).
			WithHint("the maintenance mode answers an environment's domains; deploy it with its routes first"))
	}
	if m == nil && routes[0].Maintenance == nil {
		r.result(map[string]any{"maintenance": nil})
		return events.RunFinishedData{Outcome: events.OutcomeNoop}
	}
	if r.Switch == nil {
		return failed(errs.Plan("plan.no_switch", "the server's switch is not installed").WithHint("run `dockflow server init`"))
	}
	srv, err := r.Store.Server()
	if err != nil {
		return failed(err)
	}
	for i := range routes {
		routes[i].Maintenance = m
	}
	if err := r.Switch.Apply(context.WithoutCancel(ctx), switchConfig(srv, state.AllRoutes(table))); err != nil {
		return failed(err)
	}
	if err := r.Store.SetSwitchRoutes(r.stack, routes); err != nil {
		return failed(err)
	}
	r.result(map[string]any{"maintenance": m})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}
