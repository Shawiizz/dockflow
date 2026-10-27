package agent

import (
	"context"
	"slices"

	"golang.org/x/crypto/bcrypt"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/proxy"
)

// prepareRoutes completes routes for the switch: the bcrypt hash of each basic authentication
// password, and the handlers of raw Caddy directives. Both are taken from the app's previous
// routes when unchanged, so an ordinary deploy changes nothing in the switch's configuration and
// reloads nothing.
func (r *runner) prepareRoutes(ctx context.Context, routes, previous []proxy.Route) error {
	same := func(a, b proxy.Route) bool {
		return a.Service == b.Service && a.Path == b.Path && slices.Equal(a.Domains, b.Domains)
	}
	for i := range routes {
		rt := &routes[i]
		var prev *proxy.Route
		for j := range previous {
			if same(*rt, previous[j]) {
				prev = &previous[j]
			}
		}
		if rt.AuthPassword != "" {
			if prev != nil && prev.AuthUser == rt.AuthUser && prev.AuthHash != "" &&
				bcrypt.CompareHashAndPassword([]byte(prev.AuthHash), []byte(rt.AuthPassword)) == nil {
				rt.AuthHash = prev.AuthHash
			} else {
				h, err := bcrypt.GenerateFromPassword([]byte(rt.AuthPassword), bcrypt.DefaultCost)
				if err != nil {
					return errs.Internal("hash the route's password: %v", err)
				}
				rt.AuthHash = string(h)
			}
			rt.AuthPassword = ""
		}
		if rt.Caddy != "" && len(rt.CaddyJSON) == 0 {
			if prev != nil && prev.Caddy == rt.Caddy && len(prev.CaddyJSON) > 0 {
				rt.CaddyJSON = prev.CaddyJSON
				continue
			}
			if r.Switch == nil {
				return errs.Internal("the agent has no switch client")
			}
			h, err := r.Switch.Adapt(ctx, rt.Caddy)
			if err != nil {
				return err
			}
			rt.CaddyJSON = h
		}
	}
	return nil
}
