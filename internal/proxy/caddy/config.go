// Package caddy implements the switch with Caddy, configured through its admin API on a unix
// socket that only the agent mounts.
package caddy

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
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

	b := builder{byName: map[string]identified{}}
	for _, r := range routes {
		if r.Name != "" {
			b.byName[r.Stack+"/"+r.Name] = r
		}
	}
	if c.Edge == proxy.EdgeExternal {
		return external(c, routes, b)
	}
	var https, http, httpsErrors, httpErrors []any
	for _, r := range routes {
		if r.TLS {
			https = append(https, b.route(r))
			httpsErrors = append(httpsErrors, b.errorRoutes(r)...)
		} else {
			http = append(http, b.route(r))
			httpErrors = append(httpErrors, b.errorRoutes(r)...)
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
	if len(httpErrors) > 0 {
		servers["http"].(obj)["errors"] = obj{"routes": httpErrors}
	}
	if len(https) > 0 {
		servers["https"] = obj{"listen": []string{":443"}, "routes": append(https, refuse)}
		if len(httpsErrors) > 0 {
			servers["https"].(obj)["errors"] = obj{"routes": httpsErrors}
		}
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
	apps := obj{"http": obj{"servers": servers}}
	var issuers []any
	switch {
	case c.ACMECA != "":
		issuer := obj{"module": "acme", "ca": c.ACMECA}
		if c.ACMEEmail != "" {
			issuer["email"] = c.ACMEEmail
		}
		issuers = []any{issuer}
	case c.ACMEEmail != "":
		// Let's Encrypt, then ZeroSSL, as without an address, both told the address
		issuers = []any{
			obj{"module": "acme", "email": c.ACMEEmail},
			obj{"module": "acme", "ca": "https://acme.zerossl.com/v2/DV90", "email": c.ACMEEmail},
		}
	}
	if issuers != nil {
		apps["tls"] = obj{"automation": obj{"policies": []any{obj{"issuers": issuers}}}}
	}
	cfg := obj{
		"admin": obj{"listen": "unix/" + AdminSocket},
		"apps":  apps,
	}
	return json.MarshalIndent(cfg, "", "  ")
}

// external serves every route on one plain HTTP address, behind the user's own proxy, which
// terminates TLS and sends X-Forwarded-For.
func external(c proxy.Config, routes []identified, b builder) ([]byte, error) {
	var rs, errs []any
	for _, r := range routes {
		rs = append(rs, b.route(r))
		errs = append(errs, b.errorRoutes(r)...)
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
	if len(errs) > 0 {
		server["errors"] = obj{"routes": errs}
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

// shorthands are the Caddyfile's short placeholders, which the JSON configuration spells out.
var shorthands = strings.NewReplacer(
	"{uri}", "{http.request.uri}", "{path}", "{http.request.uri.path}", "{query}", "{http.request.uri.query}",
	"{host}", "{http.request.host}", "{scheme}", "{http.request.scheme}",
)

// builder builds routes, knowing every route by stack and name, for error pages that show one.
type builder struct {
	byName map[string]identified
}

func match(r identified) obj {
	m := obj{"host": r.Domains}
	if r.Path != "" && r.Path != "/" {
		p := strings.TrimSuffix(r.Path, "/")
		m["path"] = []string{p, p + "/*"}
	}
	return m
}

func (b builder) route(r identified) obj {
	return obj{
		"@id":      "dockflow." + r.ID,
		"match":    []any{match(r)},
		"handle":   b.handlers(r, true),
		"terminal": true,
	}
}

// handlers are what a route does: its options, then its redirect, its proxy to a URL, or its
// proxy to its containers. pages adds its error pages to the proxy's answers.
func (b builder) handlers(r identified, pages bool) []any {
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
	if r.Redirect != "" {
		return append(handle, obj{"handler": "static_response", "status_code": r.RedirectStatus,
			"headers": obj{"Location": []string{shorthands.Replace(r.Redirect)}}})
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
	rp := obj{"handler": "reverse_proxy"}
	tr := obj{"protocol": "http"}
	if r.ProxyURL != "" {
		u, _ := url.Parse(r.ProxyURL)
		host := u.Host
		if u.Port() == "" {
			port := "80"
			if u.Scheme == "https" {
				port = "443"
			}
			host = net.JoinHostPort(u.Hostname(), port)
		}
		rp["upstreams"] = []any{obj{"dial": host}}
		// as nginx's proxy_pass: the upstream's own host name
		rp["headers"] = obj{"request": obj{"set": obj{"Host": []string{u.Host}}}}
		if u.Scheme == "https" {
			tr["tls"] = obj{"server_name": u.Hostname()}
		}
	} else {
		ups := make([]any, 0, len(r.Upstreams))
		for i := range r.Upstreams {
			ups = append(ups, obj{"dial": fmt.Sprintf("{file.%s/%s/%d}", upstreamDir, r.ID, i)})
		}
		rp["upstreams"] = ups
		rp["load_balancing"] = obj{"selection_policy": obj{"policy": "round_robin"}, "try_duration": "2s"}
	}
	if t := r.Timeouts; t != nil {
		for k, d := range map[string]time.Duration{"read_timeout": t.Read.D(), "write_timeout": t.Write.D(), "dial_timeout": t.Dial.D()} {
			if d > 0 {
				tr[k] = d.String()
			}
		}
	}
	if len(tr) > 1 {
		rp["transport"] = tr
	}
	if pages {
		var hr []any
		for _, p := range r.ErrorPages {
			hr = append(hr, obj{
				"match":  obj{"status_code": p.Statuses},
				"routes": []any{obj{"handle": b.page(r, p, "{http.reverse_proxy.status_code}")}},
			})
		}
		if len(hr) > 0 {
			rp["handle_response"] = hr
		}
	}
	return append(handle, rp)
}

// errorRoutes answer for r when its containers cannot be reached: Caddy's errors of the server.
func (b builder) errorRoutes(r identified) []any {
	var out []any
	for _, p := range r.ErrorPages {
		codes := make([]string, len(p.Statuses))
		for i, s := range p.Statuses {
			codes[i] = strconv.Itoa(s)
		}
		m := match(r)
		m["expression"] = "{http.error.status_code} in [" + strings.Join(codes, ", ") + "]"
		out = append(out, obj{"match": []any{m}, "handle": b.page(r, p, "{http.error.status_code}"), "terminal": true})
	}
	return out
}

// page is an error page: an inline body with the error's status, or the page of a route of the
// same app, its root.
func (b builder) page(r identified, p domain.ErrorPage, status string) []any {
	if p.Body != "" {
		return []any{obj{"handler": "static_response", "status_code": status, "body": p.Body,
			"headers": obj{"Content-Type": []string{"text/html; charset=utf-8"}}}}
	}
	target, ok := b.byName[r.Stack+"/"+p.Route]
	if !ok {
		return []any{obj{"handler": "static_response", "status_code": status}}
	}
	return append([]any{obj{"handler": "rewrite", "uri": "/"}}, b.handlers(target, false)...)
}
