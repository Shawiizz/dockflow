package proxy

import (
	"testing"

	"github.com/Shawiizz/dockflow/internal/errs"
)

func TestUnique(t *testing.T) {
	route := func(stack, service, path string, domains ...string) Route {
		return Route{Stack: stack, Service: service, Path: path, Domains: domains}
	}
	for name, c := range map[string]struct {
		routes []Route
		ok     bool
	}{
		"one app, two paths":             {[]Route{route("shop-production", "web", "/", "shop.test"), route("shop-production", "api", "/api", "shop.test")}, true},
		"two apps, two domains":          {[]Route{route("shop-production", "web", "/", "shop.test"), route("blog-production", "web", "/", "blog.test")}, true},
		"one path twice":                 {[]Route{route("shop-production", "web", "/", "shop.test"), route("shop-production", "api", "/", "shop.test")}, false},
		"a trailing slash":               {[]Route{route("shop-production", "web", "/api", "shop.test"), route("shop-production", "api", "/api/", "shop.test")}, false},
		"case and a trailing dot":        {[]Route{route("shop-production", "web", "/", "shop.test"), route("evil-production", "web", "/", "SHOP.test.")}, false},
		"another app on another path":    {[]Route{route("shop-production", "web", "/", "shop.test"), route("evil-production", "web", "/login", "shop.test")}, false},
		"another environment, same app":  {[]Route{route("shop-production", "web", "/", "shop.test"), route("shop-staging", "web", "/x", "shop.test")}, false},
		"not a host name":                {[]Route{route("shop-production", "web", "/", "shop.test;")}, false},
		"a wildcard and a specific name": {[]Route{route("shop-production", "web", "/", "*.shop.test"), route("blog-production", "web", "/", "blog.shop.test")}, true},
	} {
		err := Unique(c.routes)
		if c.ok != (err == nil) {
			t.Errorf("%s: %v", name, err)
		}
		if err != nil && errs.CodeOf(err) != "plan.domain_conflict" && errs.CodeOf(err) != "plan.domain_invalid" {
			t.Errorf("%s: code %s", name, errs.CodeOf(err))
		}
	}
}
