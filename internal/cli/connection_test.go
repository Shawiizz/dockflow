package cli

import "testing"

func TestParseTarget(t *testing.T) {
	cases := map[string]struct {
		user, host string
		port       int
	}{
		"deploy@203.0.113.10":      {"deploy", "203.0.113.10", 22},
		"203.0.113.10:2222":        {"dockflow", "203.0.113.10", 2222},
		"root@[2001:db8::1]:22022": {"root", "2001:db8::1", 22022},
		"root@shop.example.com":    {"root", "shop.example.com", 22},
	}
	for in, want := range cases {
		got, err := parseTarget(in)
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if got.User != want.user || got.Host != want.host || got.Port != want.port {
			t.Fatalf("%s: got %+v", in, got)
		}
	}
	for _, bad := range []string{"root@", "root@host:x", "host:70000"} {
		if _, err := parseTarget(bad); err == nil {
			t.Fatalf("%s must be refused", bad)
		}
	}
}
