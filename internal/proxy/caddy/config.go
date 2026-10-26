// Package caddy implements the switch with Caddy, configured through its admin API on a unix
// socket that only the agent mounts.
package caddy

import (
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/proxy"
)

// AdminSocket is the path of the admin socket inside the switch and the agent.
const AdminSocket = "/run/dockflow-switch/admin.sock"

type obj = map[string]any

// Build returns Caddy's JSON configuration for c. Routes are unique per (domain, path), and the
// longest path wins.
func Build(c proxy.Config) ([]byte, error) {
	seen := map[string]string{}
	for _, r := range c.Routes {
		for _, d := range r.Domains {
			k := d + r.Path
			if owner, ok := seen[k]; ok {
				return nil, errs.Plan("plan.domain_conflict", "%s%s is routed twice: by %s and by %s/%s", d, r.Path, owner, r.Stack, r.Service).
					WithHint("routes are unique per domain and path on a server")
			}
			seen[k] = r.Stack + "/" + r.Service
		}
	}
	routes := append([]proxy.Route(nil), c.Routes...)
	sort.SliceStable(routes, func(i, j int) bool {
		if len(routes[i].Path) != len(routes[j].Path) {
			return len(routes[i].Path) > len(routes[j].Path)
		}
		if routes[i].Stack != routes[j].Stack {
			return routes[i].Stack < routes[j].Stack
		}
		return routes[i].Service < routes[j].Service
	})

	var https, http []any
	for _, r := range routes {
		if r.TLS {
			https = append(https, route(r))
		} else {
			http = append(http, route(r))
		}
	}
	refuse := obj{"handle": []any{obj{"handler": "static_response", "abort": true}}}
	servers := obj{
		"http": obj{
			"listen": []string{":80"},
			"routes": append(http, refuse),
			// automatic HTTPS adds its redirects for the TLS domains to this server
		},
	}
	if len(https) > 0 {
		servers["https"] = obj{"listen": []string{":443"}, "routes": append(https, refuse)}
	}
	cfg := obj{
		"admin": obj{"listen": "unix/" + AdminSocket},
		"apps":  obj{"http": obj{"servers": servers}},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func route(r proxy.Route) obj {
	match := obj{"host": r.Domains}
	if r.Path != "" && r.Path != "/" {
		p := strings.TrimSuffix(r.Path, "/")
		match["path"] = []string{p, p + "/*"}
	}
	var handle []any
	if r.StripPrefix && r.Path != "" && r.Path != "/" {
		handle = append(handle, obj{"handler": "rewrite", "strip_path_prefix": strings.TrimSuffix(r.Path, "/")})
	}
	ups := make([]any, 0, len(r.Upstreams))
	for _, u := range r.Upstreams {
		ups = append(ups, obj{"dial": net.JoinHostPort(u, strconv.Itoa(r.Port))})
	}
	handle = append(handle, obj{
		"handler":        "reverse_proxy",
		"upstreams":      ups,
		"load_balancing": obj{"selection_policy": obj{"policy": "round_robin"}, "try_duration": "2s"},
	})
	return obj{
		"@id":      fmt.Sprintf("dockflow-%s-%s-%s", r.Stack, r.Service, pathID(r.Path)),
		"match":    []any{match},
		"handle":   handle,
		"terminal": true,
	}
}

func pathID(p string) string {
	p = strings.Trim(p, "/")
	if p == "" {
		return "root"
	}
	return strings.NewReplacer("/", "_", ".", "_").Replace(p)
}
