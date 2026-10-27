package agent

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
)

// sharedName is the name of a shared network, as Docker accepts it.
var sharedName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`)

// networks creates, lists or removes the networks shared between the apps of the server
// (ADR-0018): bridge networks owned by the server, which apps join as external networks.
func (r *runner) networks(ctx context.Context) events.RunFinishedData {
	if r.req.Op == OpNetworkList {
		list, err := r.Engine.LabeledNetworks(ctx, domain.LabelShared)
		if err != nil {
			return failed(err)
		}
		r.result(map[string]any{"networks": list})
		return events.RunFinishedData{Outcome: events.OutcomeSuccess}
	}
	name := r.req.Name
	if !sharedName.MatchString(name) {
		return failed(errs.Usage("%q is not a network name: letters, digits, _, . and -", name))
	}
	l, err := r.Store.LockServer()
	if err != nil {
		return failed(err)
	}
	defer l.Release()
	all, err := r.Engine.Networks(ctx)
	if err != nil {
		return failed(err)
	}
	shared, err := r.Engine.LabeledNetworks(ctx, domain.LabelShared)
	if err != nil {
		return failed(err)
	}
	var mine *int
	for i := range shared {
		if shared[i].Name == name {
			mine = &i
		}
	}
	_, exists := all[name]
	switch r.req.Op {
	case OpNetworkCreate:
		if mine != nil {
			r.result(map[string]any{"network": name, "created": false})
			return events.RunFinishedData{Outcome: events.OutcomeNoop}
		}
		if exists {
			return failed(errs.Plan("network.exists", "a network %s exists on the server and is not a shared network", name).
				WithHint("choose another name"))
		}
		n := domain.Network{Name: name, Driver: "bridge", Labels: map[string]string{domain.LabelShared: "true"}}
		if err := r.Engine.CreateNetwork(ctx, n, ""); err != nil {
			return failed(err)
		}
		r.ev.Info(events.Log, "shared network "+name+" created", map[string]any{"line": "create " + name})
		r.result(map[string]any{"network": name, "created": true})
	case OpNetworkRemove:
		if mine == nil {
			if exists {
				return failed(errs.Plan("network.not_shared", "%s is not a shared network: it belongs to an app or to Docker", name))
			}
			return failed(errs.Usage("no shared network %s on the server", name))
		}
		if c := shared[*mine].Containers; len(c) > 0 {
			return failed(errs.Plan("network.in_use", "%d containers use the shared network %s: %s", len(c), name, strings.Join(c, ", ")).
				WithHint("remove it from the Compose files of the apps that join it, and deploy them, first"))
		}
		if err := r.Engine.RemoveNetwork(ctx, name); err != nil {
			return failed(err)
		}
		r.ev.Info(events.Log, "shared network "+name+" removed", map[string]any{"line": "remove " + name})
		r.result(map[string]any{"network": name, "removed": true})
	}
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// plugins installs, lists or removes Docker managed plugins, such as volume drivers (ADR-0018).
func (r *runner) plugins(ctx context.Context) events.RunFinishedData {
	if r.req.Op == OpPluginList {
		list, err := r.Engine.Plugins(ctx)
		if err != nil {
			return failed(err)
		}
		r.result(map[string]any{"plugins": list})
		return events.RunFinishedData{Outcome: events.OutcomeSuccess}
	}
	l, err := r.Store.LockServer()
	if err != nil {
		return failed(err)
	}
	defer l.Release()
	switch r.req.Op {
	case OpPluginInstall:
		alias := r.req.Alias
		if alias == "" {
			alias = r.req.Name
		}
		for _, s := range r.req.Settings {
			if k, _, ok := strings.Cut(s, "="); !ok || k == "" {
				return failed(errs.Usage("%q is not a setting: write key=value", s))
			}
		}
		installed, err := r.Engine.Plugins(ctx)
		if err != nil {
			return failed(err)
		}
		for _, p := range installed {
			if p.Name == alias || p.Name == alias+":latest" {
				return failed(errs.Plan("plugin.exists", "a plugin %s is installed already", p.Name).
					WithHint("remove it first, or install this one under another --alias"))
			}
		}
		granted, err := r.Engine.InstallPlugin(ctx, r.req.Name, alias, r.req.Settings, r.req.RegistryAuth)
		if err != nil {
			return failed(err)
		}
		msg := fmt.Sprintf("plugin %s installed as %s", r.req.Name, alias)
		if len(granted) > 0 {
			msg += ", granted " + strings.Join(granted, "; ")
		}
		r.ev.Info(events.Log, msg, map[string]any{"line": "install " + r.req.Name, "privileges": granted})
		r.result(map[string]any{"plugin": alias, "reference": r.req.Name, "privileges": granted})
	case OpPluginRemove:
		if err := r.Engine.RemovePlugin(ctx, r.req.Name); err != nil {
			return failed(err)
		}
		r.ev.Info(events.Log, "plugin "+r.req.Name+" removed", map[string]any{"line": "remove " + r.req.Name})
		r.result(map[string]any{"plugin": r.req.Name, "removed": true})
	}
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// warnLimits warns about the services without memory or CPU limits, on a server other app
// environments share: one of them can take the server's memory from the others (ADR-0018).
func (r *runner) warnLimits(desired *domain.App) {
	stacks, err := r.Store.Stacks()
	if err != nil {
		return
	}
	others := 0
	for _, s := range stacks {
		if s == r.stack {
			continue
		}
		if app, err := r.Store.App(s); err == nil {
			if env, err := app.Env(); err == nil && env != nil && env.Current > 0 {
				others++
			}
		}
	}
	if others == 0 {
		return
	}
	var unlimited []string
	for _, s := range desired.Services {
		if s.Job == "" && s.Spec.Resources.MemoryLimit == 0 && s.Spec.Resources.CPUs == 0 {
			unlimited = append(unlimited, s.Name)
		}
	}
	if len(unlimited) == 0 {
		return
	}
	r.warn("plan.no_limits", fmt.Sprintf("the server runs %d other app environments, and %s set no deploy.resources.limits: one service can take the memory of all",
		others, strings.Join(unlimited, ", ")))
}
