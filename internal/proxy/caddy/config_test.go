package caddy

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/testutil"
)

func TestBuild(t *testing.T) {
	b, err := Build(proxy.Config{Edge: proxy.EdgeBuiltin, Routes: []proxy.Route{
		{Stack: "shop-production", Service: "web", Domains: []string{"shop.example.com", "www.shop.example.com"}, Path: "/", Port: 3000, TLS: true,
			Upstreams: []string{"shop-production-web-4-1", "shop-production-web-4-2"}},
		{Stack: "shop-production", Service: "api", Domains: []string{"shop.example.com"}, Path: "/api", Port: 8080, TLS: true, StripPrefix: true,
			Upstreams: []string{"shop-production-api-3-1"}},
		{Stack: "blog-staging", Service: "web", Domains: []string{"blog.test"}, Path: "/", Port: 80,
			Upstreams: []string{"blog-staging-web-1-1"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var v any
	json.Unmarshal(b, &v)
	testutil.Golden(t, "builtin", v)
}

func TestBuildOptions(t *testing.T) {
	b, err := Build(proxy.Config{Edge: proxy.EdgeBuiltin, Routes: []proxy.Route{
		{Stack: "panel-production", Service: "panel", Domains: []string{"panel.example.com"}, Path: "/", Port: 8080, TLS: true,
			Upstreams: []string{"panel-production-panel-2-1"},
			Headers:   map[string]string{"X-Frame-Options": "DENY", "-Server": ""},
			Encode:    []string{"zstd", "gzip"}, MaxBody: 25 << 20,
			Timeouts: &domain.RouteTimeouts{Read: domain.Duration(90 * time.Second), Dial: domain.Duration(10 * time.Second)},
			AuthUser: "admin", AuthHash: "$2a$10$hash",
			CaddyJSON: json.RawMessage(`[{"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"DOCKFLOW_UPSTREAM:4327"}]}]}]`)},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var v any
	json.Unmarshal(b, &v)
	testutil.Golden(t, "options", v)
	if up := Upstreams(proxy.Config{Routes: []proxy.Route{{Stack: "s", Service: "w", Port: 80, Upstreams: []string{"c1"}, CaddyJSON: json.RawMessage("[]")}}}); up["s.w.0/h0"] != "c1" {
		t.Fatalf("raw directives get the first container's name: %v", up)
	}
}

func TestBuildAppRoutesAndErrorPages(t *testing.T) {
	b, err := Build(proxy.Config{Edge: proxy.EdgeBuiltin, Routes: []proxy.Route{
		{Stack: "mohist-production", Service: "web", Domains: []string{"mohist.example.com"}, Path: "/", Port: 3000, TLS: true,
			Upstreams:  []string{"mohist-production-web-3-1"},
			ErrorPages: []domain.ErrorPage{{Statuses: []int{502, 503}, Route: "maintenance"}, {Statuses: []int{404}, Body: "<h1>Not here</h1>"}}},
		{Stack: "mohist-production", Service: "files-maintenance", Name: "maintenance", Domains: []string{"mohist.example.com"}, Path: "/maintenance",
			Port: 80, TLS: true, StripPrefix: true, Upstreams: []string{"mohist-production-files-maintenance-3-1"}},
		{Stack: "mohist-production", Service: "routes.maven", Name: "maven", Domains: []string{"mohist.example.com"}, Path: "/maven", TLS: true,
			Redirect: "https://maven.example.com{uri}", RedirectStatus: 308, Upstreams: []string{}},
		{Stack: "mohist-production", Service: "routes.1", Domains: []string{"api.mohist.example.com"}, Path: "/", TLS: true,
			ProxyURL: "https://api.upstream.example", Upstreams: []string{}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var v any
	json.Unmarshal(b, &v)
	testutil.Golden(t, "app-routes", v)
}

func TestBuildCloudflare(t *testing.T) {
	b, err := Build(proxy.Config{Edge: proxy.EdgeCloudflare, ACMEEmail: "ops@example.com", TrustedProxies: []string{"173.245.48.0/20", "2400:cb00::/32"}, Routes: []proxy.Route{
		{Stack: "web-production", Service: "web", Domains: []string{"example.com"}, Path: "/", Port: 80, TLS: true,
			Upstreams: []string{"web-production-web-2-1"}},
		{Stack: "flex-production", Service: "web", Domains: []string{"flexible.example.com"}, Path: "/", Port: 80,
			Upstreams: []string{"flex-production-web-1-1"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var v any
	json.Unmarshal(b, &v)
	testutil.Golden(t, "cloudflare", v)
}

func TestBuildExternal(t *testing.T) {
	b, err := Build(proxy.Config{Edge: proxy.EdgeExternal, Routes: []proxy.Route{
		{Stack: "docs-production", Service: "docs", Domains: []string{"docs.example.com"}, Path: "/", Port: 3000, TLS: true,
			Upstreams: []string{"docs-production-docs-7-1"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var v any
	json.Unmarshal(b, &v)
	testutil.Golden(t, "external", v)
}

func TestBuildRefusesDuplicates(t *testing.T) {
	_, err := Build(proxy.Config{Routes: []proxy.Route{
		{Stack: "a", Service: "web", Domains: []string{"x.test"}, Path: "/"},
		{Stack: "b", Service: "web", Domains: []string{"x.test"}, Path: "/"},
	}})
	if err == nil {
		t.Fatal("want a conflict")
	}
}

func TestBuildACMECA(t *testing.T) {
	b, err := Build(proxy.Config{Edge: proxy.EdgeBuiltin, ACMECA: "https://acme-staging-v02.api.letsencrypt.org/directory", Routes: []proxy.Route{
		{Stack: "web-production", Service: "web", Domains: []string{"example.com"}, Path: "/", Port: 80, TLS: true, Upstreams: []string{"web-1"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Apps struct {
			TLS struct {
				Automation struct {
					Policies []struct {
						Issuers []map[string]string `json:"issuers"`
					} `json:"policies"`
				} `json:"automation"`
			} `json:"tls"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatal(err)
	}
	if p := cfg.Apps.TLS.Automation.Policies; len(p) != 1 || len(p[0].Issuers) != 1 || p[0].Issuers[0]["ca"] != "https://acme-staging-v02.api.letsencrypt.org/directory" {
		t.Fatalf("one issuer, the directory given:\n%s", b)
	}
}
