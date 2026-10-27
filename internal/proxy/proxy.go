// Package proxy is the port to the switch: the Dockflow-managed proxy in front of every app
// (ADR-0011). The Caddy adapter lives in proxy/caddy.
package proxy

import (
	"context"
	"encoding/json"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Route is one route the switch serves, with the containers it sends traffic to.
type Route struct {
	Stack       string   `json:"stack"`
	Service     string   `json:"service"`
	Domains     []string `json:"domains"`
	Path        string   `json:"path"`
	Port        int      `json:"port"`
	TLS         bool     `json:"tls"`
	StripPrefix bool     `json:"strip_prefix,omitempty"`
	// Network is the Docker network the switch reaches the upstreams through.
	Network string `json:"network,omitempty"`
	// Upstreams are container names, resolved by Docker's DNS in the networks the switch shares
	// with the app.
	Upstreams []string `json:"upstreams"`

	// The route's options (ADR-0011).
	Headers  map[string]string     `json:"headers,omitempty"`
	Encode   []string              `json:"encode,omitempty"`
	MaxBody  int64                 `json:"max_body,omitempty"`
	Timeouts *domain.RouteTimeouts `json:"timeouts,omitempty"`
	// AuthUser and AuthHash are basic authentication: the user, and the bcrypt hash of its
	// password. AuthPassword is the password, until the agent hashes it; it is never stored.
	AuthUser     string `json:"auth_user,omitempty"`
	AuthHash     string `json:"auth_hash,omitempty"`
	AuthPassword string `json:"-"`
	// Caddy are raw Caddyfile directives; CaddyJSON are their handlers, adapted by the switch.
	Caddy     string          `json:"caddy,omitempty"`
	CaddyJSON json.RawMessage `json:"caddy_json,omitempty"`
	// ErrorPages replace some answers; a page that shows a route names it by Name.
	ErrorPages []domain.ErrorPage `json:"error_pages,omitempty"`
	Name       string             `json:"name,omitempty"`
	// Redirect, with RedirectStatus, or ProxyURL: a route of dockflow.yml, with no upstreams.
	Redirect       string `json:"redirect,omitempty"`
	RedirectStatus int    `json:"redirect_status,omitempty"`
	ProxyURL       string `json:"proxy,omitempty"`
}

// UpstreamMarker stands for the route's first container in raw Caddy directives, written
// {upstream} by the user.
const UpstreamMarker = "DOCKFLOW_UPSTREAM"

// Unique refuses two routes of one (domain, path) on the server (ADR-0011).
func Unique(routes []Route) error {
	seen := map[string]string{}
	for _, r := range routes {
		for _, d := range r.Domains {
			k := d + r.Path
			if owner, ok := seen[k]; ok {
				return errs.Plan("plan.domain_conflict", "%s%s is routed twice: by %s and by %s/%s", d, r.Path, owner, r.Stack, r.Service).
					WithHint("routes are unique per domain and path on a server")
			}
			seen[k] = r.Stack + "/" + r.Service
		}
	}
	return nil
}

// Edge modes (ADR-0011).
const (
	EdgeBuiltin    = "builtin"
	EdgeCloudflare = "cloudflare"
	EdgeExternal   = "external"
	EdgeNone       = "none"
)

// SharedDir is where the volume shared by the switch and the agents is mounted, in both: the
// admin socket and the upstream files.
const SharedDir = "/run/dockflow-switch"

// DefaultListen is where the switch listens with the external edge, on the server.
const DefaultListen = "127.0.0.1:8080"

// ExternalPort is the port the switch listens on inside its container with the external edge.
const ExternalPort = 8080

// Config is everything the switch serves.
type Config struct {
	Edge   string
	Routes []Route
	// TrustedProxies are the CIDRs whose X-Forwarded-For is believed (external edge), or whose
	// CF-Connecting-IP is (cloudflare edge: Cloudflare's ranges).
	TrustedProxies []string
	// ACMEEmail is the address given to the certificate authority, if any.
	ACMEEmail string
	// ACMECA is the ACME directory to use instead of Let's Encrypt's, then ZeroSSL's.
	ACMECA string
	// Reload loads the configuration even when its routes did not change: the switch was just
	// (re)installed.
	Reload bool
}

// Switch applies a configuration to the running switch, without dropping connections. Moving a
// route to other containers must not reload anything that holds client connections.
type Switch interface {
	Apply(ctx context.Context, c Config) error
	// Adapt turns raw Caddyfile directives into the switch's handlers, or refuses them.
	Adapt(ctx context.Context, directives string) (json.RawMessage, error)
}
