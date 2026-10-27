package agent

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/Shawiizz/dockflow/internal/cloudflare"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// cloudflareRanges downloads Cloudflare's ranges, or keeps previous when the download fails, or
// falls back on the ranges this version knows (ADR-0014).
func (r *runner) cloudflareRanges(ctx context.Context, previous []string) []string {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ranges, err := cloudflare.Fetch(ctx, nil)
	if err == nil {
		return ranges
	}
	if len(previous) > 0 {
		r.warn("cloudflare.ranges", "cannot download Cloudflare's ranges, the previous ones stay: "+err.Error())
		return previous
	}
	r.warn("cloudflare.ranges", "cannot download Cloudflare's ranges, this version's own list is used: "+err.Error())
	return cloudflare.Default
}

// refreshCloudflare downloads Cloudflare's ranges again, and applies them to the switch and the
// filter when they changed: the weekly timer of provisioning runs it (ADR-0014).
func (r *runner) refreshCloudflare(ctx context.Context) events.RunFinishedData {
	l, err := r.Store.LockServer()
	if err != nil {
		return failed(err)
	}
	defer l.Release()
	srv, err := r.Store.Server()
	if err != nil {
		return failed(err)
	}
	if srv == nil || srv.Edge != proxy.EdgeCloudflare {
		r.result(map[string]any{"changed": false})
		return events.RunFinishedData{Outcome: events.OutcomeNoop}
	}
	ranges := r.cloudflareRanges(ctx, srv.CloudflareRanges)
	if slices.Equal(ranges, srv.CloudflareRanges) {
		r.result(map[string]any{"changed": false, "ranges": len(ranges)})
		return events.RunFinishedData{Outcome: events.OutcomeNoop}
	}
	srv.CloudflareRanges = ranges
	if err := r.Store.WriteServer(*srv); err != nil {
		return failed(err)
	}
	table, err := r.Store.SwitchRoutes()
	if err != nil {
		return failed(err)
	}
	if r.Switch == nil {
		return failed(errs.Internal("the agent has no switch client"))
	}
	cfg := switchConfig(srv, state.AllRoutes(table))
	cfg.Reload = true
	if err := r.Switch.Apply(ctx, cfg); err != nil {
		return failed(err)
	}
	if err := r.syncFilter(ctx); err != nil {
		return failed(err)
	}
	r.ev.Info(events.Log, fmt.Sprintf("Cloudflare's %d ranges applied", len(ranges)), map[string]any{"line": "cloudflare ranges"})
	r.result(map[string]any{"changed": true, "ranges": len(ranges)})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}
