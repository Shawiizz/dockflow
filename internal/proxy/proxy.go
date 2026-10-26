// Package proxy is the port to the switch: the Dockflow-managed proxy in front of every app
// (ADR-0011). The Caddy adapter lives in proxy/caddy.
package proxy

import "context"

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
}

// Edge modes (ADR-0011).
const (
	EdgeBuiltin  = "builtin"
	EdgeExternal = "external"
	EdgeNone     = "none"
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
	// TrustedProxies are the CIDRs whose X-Forwarded-For is believed (external edge).
	TrustedProxies []string
	// Reload loads the configuration even when its routes did not change: the switch was just
	// (re)installed.
	Reload bool
}

// Switch applies a configuration to the running switch, without dropping connections. Moving a
// route to other containers must not reload anything that holds client connections.
type Switch interface {
	Apply(ctx context.Context, c Config) error
}
