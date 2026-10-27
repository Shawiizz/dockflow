// Package caddy implements the switch with Caddy, configured through its admin API on a unix
// socket that only the agent mounts.
package caddy

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Shawiizz/dockflow/internal/proxy"
)

// Dir is the volume shared by the switch and the agents, at the same path in both.
const Dir = proxy.SharedDir

// AdminSocket is the path of the admin socket inside the switch and the agent.
const AdminSocket = Dir + "/admin.sock"

// upstreamDir holds one file per upstream slot, <route id>/<n>, holding host:port. Caddy reads
// it on every request through a {file.*} placeholder, so moving traffic is writing files: no
// configuration reload, which would close the connections the old server had just accepted.
const upstreamDir = Dir + "/up"

type obj = map[string]any

// Build returns Caddy's JSON configuration for c. Routes are unique per (domain, path), and the
// longest path wins.
func Build(c proxy.Config) ([]byte, error) {
	if err := proxy.Unique(c.Routes); err != nil {
		return nil, err
	}
	routes := withIDs(c.Routes)
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
	if c.Edge == proxy.EdgeExternal {
		return external(c, routes)
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
	if c.Edge == proxy.EdgeCloudflare {
		// the client is the one Cloudflare names, when Cloudflare connects; the filter lets
		// nothing else in, but a header from anyone else is never believed
		for _, s := range servers {
			srv := s.(obj)
			srv["trusted_proxies"] = obj{"source": "static", "ranges": c.TrustedProxies}
			srv["client_ip_headers"] = []string{"CF-Connecting-IP"}
		}
	}
	cfg := obj{
		"admin": obj{"listen": "unix/" + AdminSocket},
		"apps":  obj{"http": obj{"servers": servers}},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

// external serves every route on one plain HTTP address, behind the user's own proxy, which
// terminates TLS and sends X-Forwarded-For.
func external(c proxy.Config, routes []identified) ([]byte, error) {
	var rs []any
	for _, r := range routes {
		rs = append(rs, route(r))
	}
	rs = append(rs, obj{"handle": []any{obj{"handler": "static_response", "status_code": 404}}})
	trusted := c.TrustedProxies
	if len(trusted) == 0 {
		// the front proxy reaches the published port through Docker's proxy or NAT, so the
		// switch sees a bridge address, not loopback; the port listens on loopback only
		trusted = []string{"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"}
	}
	server := obj{
		"listen":            []string{fmt.Sprintf(":%d", proxy.ExternalPort)},
		"routes":            rs,
		"automatic_https":   obj{"disable": true},
		"trusted_proxies":   obj{"source": "static", "ranges": trusted},
		"client_ip_headers": []string{"X-Forwarded-For"},
	}
	cfg := obj{
		"admin": obj{"listen": "unix/" + AdminSocket},
		"apps":  obj{"http": obj{"servers": obj{"switch": server}}},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

// identified is a route with its id: <stack>.<service>.<n>, n counting the service's routes.
type identified struct {
	proxy.Route
	ID string
}

func withIDs(rs []proxy.Route) []identified {
	out := make([]identified, 0, len(rs))
	seen := map[string]int{}
	for _, r := range rs {
		key := r.Stack + "." + r.Service
		out = append(out, identified{Route: r, ID: fmt.Sprintf("%s.%d", key, seen[key])})
		seen[key]++
	}
	return out
}

// Upstreams returns the contents of the upstream files of c: path relative to the upstream
// directory, and host:port.
func Upstreams(c proxy.Config) map[string]string {
	out := map[string]string{}
	for _, r := range withIDs(c.Routes) {
		for i, u := range r.Upstreams {
			out[r.ID+"/"+strconv.Itoa(i)] = net.JoinHostPort(u, strconv.Itoa(r.Port))
		}
		if len(r.CaddyJSON) > 0 && len(r.Upstreams) > 0 {
			// the first container, without its port, for {upstream} in raw directives
			out[r.ID+"/h0"] = r.Upstreams[0]
		}
	}
	return out
}

func route(r identified) obj {
	match := obj{"host": r.Domains}
	if r.Path != "" && r.Path != "/" {
		p := strings.TrimSuffix(r.Path, "/")
		match["path"] = []string{p, p + "/*"}
	}
	var handle []any
	if r.AuthUser != "" {
		handle = append(handle, obj{"handler": "authentication", "providers": obj{"http_basic": obj{
			"hash":     obj{"algorithm": "bcrypt"},
			"accounts": []any{obj{"username": r.AuthUser, "password": base64.StdEncoding.EncodeToString([]byte(r.AuthHash))}},
		}}})
	}
	if r.MaxBody > 0 {
		handle = append(handle, obj{"handler": "request_body", "max_size": r.MaxBody})
	}
	if len(r.Headers) > 0 {
		set, del := obj{}, []string{}
		for name, value := range r.Headers {
			if strings.HasPrefix(name, "-") {
				del = append(del, strings.TrimPrefix(name, "-"))
			} else {
				set[name] = []string{value}
			}
		}
		sort.Strings(del)
		resp := obj{"deferred": true}
		if len(set) > 0 {
			resp["set"] = set
		}
		if len(del) > 0 {
			resp["delete"] = del
		}
		handle = append(handle, obj{"handler": "headers", "response": resp})
	}
	if len(r.Encode) > 0 {
		enc := obj{}
		for _, e := range r.Encode {
			enc[e] = obj{}
		}
		handle = append(handle, obj{"handler": "encode", "encodings": enc, "prefer": r.Encode})
	}
	if r.StripPrefix && r.Path != "" && r.Path != "/" {
		handle = append(handle, obj{"handler": "rewrite", "strip_path_prefix": strings.TrimSuffix(r.Path, "/")})
	}
	if len(r.CaddyJSON) > 0 {
		raw := strings.ReplaceAll(string(r.CaddyJSON), proxy.UpstreamMarker, fmt.Sprintf("{file.%s/%s/h0}", upstreamDir, r.ID))
		var routes any
		if err := json.Unmarshal([]byte(raw), &routes); err == nil {
			handle = append(handle, obj{"handler": "subroute", "routes": routes})
		}
	}
	ups := make([]any, 0, len(r.Upstreams))
	for i := range r.Upstreams {
		ups = append(ups, obj{"dial": fmt.Sprintf("{file.%s/%s/%d}", upstreamDir, r.ID, i)})
	}
	rp := obj{
		"handler":        "reverse_proxy",
		"upstreams":      ups,
		"load_balancing": obj{"selection_policy": obj{"policy": "round_robin"}, "try_duration": "2s"},
	}
	if t := r.Timeouts; t != nil {
		tr := obj{"protocol": "http"}
		for k, d := range map[string]time.Duration{"read_timeout": t.Read.D(), "write_timeout": t.Write.D(), "dial_timeout": t.Dial.D()} {
			if d > 0 {
				tr[k] = d.String()
			}
		}
		rp["transport"] = tr
	}
	handle = append(handle, rp)
	return obj{
		"@id":      "dockflow." + r.ID,
		"match":    []any{match},
		"handle":   handle,
		"terminal": true,
	}
}
