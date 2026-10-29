package domain

import (
	"strings"
	"testing"
)

func TestCanonicalHost(t *testing.T) {
	for in, want := range map[string]string{
		"Example.COM":      "example.com",
		"example.com.":     "example.com",
		"*.Example.com":    "*.example.com",
		"shop-1.test":      "shop-1.test",
		"localhost":        "localhost",
		"203.0.113.10":     "203.0.113.10",
		"[2001:DB8::1]":    "2001:db8::1",
		"xn--bcher-kva.ch": "xn--bcher-kva.ch",
	} {
		got, err := CanonicalHost(in)
		if err != nil || got != want {
			t.Errorf("%q: got %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{
		"", ".", "exa mple.com", "example..com", "-shop.test", "shop-.test", "a.*.example.com",
		"*", "*example.com", "bücher.ch", "example.com/path", "example.com:443", "evil.com\n",
		"x;return 200", strings.Repeat("a", 64) + ".com",
	} {
		if got, err := CanonicalHost(bad); err == nil {
			t.Errorf("%q must be refused, got %q", bad, got)
		}
	}
}

func TestCanonicalPath(t *testing.T) {
	for in, want := range map[string]string{"": "/", "/": "/", "/api": "/api", "/api/": "/api", "/a//b/./c/": "/a/b/c"} {
		if got := CanonicalPath(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestRouteCanonicalize(t *testing.T) {
	r := Route{Domains: []string{"Shop.Example.com.", "www.shop.example.com"}, Path: "/api/"}
	if err := r.Canonicalize(); err != nil {
		t.Fatal(err)
	}
	if r.Domains[0] != "shop.example.com" || r.Path != "/api" {
		t.Fatalf("got %+v", r)
	}
	twice := Route{Domains: []string{"shop.test", "SHOP.test."}}
	if err := twice.Canonicalize(); err == nil {
		t.Fatal("a domain given twice must be refused")
	}
}
