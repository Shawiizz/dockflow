package caddy

import (
	"encoding/json"
	"testing"

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
