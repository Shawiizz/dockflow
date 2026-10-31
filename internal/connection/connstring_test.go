package connection

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/config"
)

func TestRoundTrip(t *testing.T) {
	c := ConnString{
		Servers:    []Server{{Name: "main", Host: "203.0.113.10", Port: 2222, User: "deploy", HostKey: "SHA256:abc"}},
		PrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n",
	}
	got, err := ParseConnString(c.Encode())
	if err != nil {
		t.Fatal(err)
	}
	if got.Servers[0] != c.Servers[0] || got.PrivateKey != c.PrivateKey {
		t.Fatalf("round trip changed it: %+v", got)
	}
}

func TestDefaultsAndRefusals(t *testing.T) {
	c := ConnString{Servers: []Server{{Host: "h"}}, Password: "pw"}
	got, err := ParseConnString(c.Encode())
	if err != nil {
		t.Fatal(err)
	}
	if s := got.Servers[0]; s.Name != "main" || s.Port != 22 || s.User != "dockflow" {
		t.Fatalf("defaults not applied: %+v", s)
	}
	two := ConnString{Servers: []Server{{Host: "a"}, {Host: "b"}}, Password: "pw"}
	if _, err := ParseConnString(two.Encode()); err == nil || !strings.Contains(err.Error(), "one server") {
		t.Fatalf("two servers must be refused in v1, got %v", err)
	}
	if _, err := ParseConnString("not base64 !!"); err == nil {
		t.Fatal("garbage must be refused")
	}
	if _, err := ParseConnString(ConnString{Servers: []Server{{Host: "a"}}}.Encode()); err == nil {
		t.Fatal("no credentials must be refused")
	}
}

func TestResolvePrecedence(t *testing.T) {
	fromSecret := ConnString{Servers: []Server{{Host: "secret-host"}}, Password: "pw"}.Encode()
	fromFlag := ConnString{Servers: []Server{{Host: "flag-host"}}, Password: "pw"}.Encode()
	secret := func(k string) (string, bool) {
		if k == "CONNECTION" {
			return fromSecret, true
		}
		return "", false
	}
	none := func(string) string { return "" }
	cfg := &config.Resolved{Server: &config.Server{Name: "main", Host: "yaml-host", Port: 22, User: "dockflow"}}

	tgt, err := Resolve("production", cfg, secret, fromFlag, none)
	if err != nil || tgt.Server.Host != "flag-host" {
		t.Fatalf("flag must win: %v %v", tgt, err)
	}
	tgt, err = Resolve("production", cfg, secret, "", none)
	if err != nil || tgt.Server.Host != "secret-host" {
		t.Fatalf("secret must win over yaml: %v %v", tgt, err)
	}
	noSecret := func(string) (string, bool) { return "", false }
	env := func(k string) string {
		if k == "DOCKFLOW_SSH_KEY_PRODUCTION" {
			return "KEY"
		}
		return ""
	}
	tgt, err = Resolve("production", cfg, noSecret, "", env)
	if err != nil || tgt.Server.Host != "yaml-host" || tgt.PrivateKey != "KEY" {
		t.Fatalf("yaml server with the scoped key: %v %v", tgt, err)
	}
	if _, err := Resolve("production", &config.Resolved{}, noSecret, "", none); err == nil {
		t.Fatal("no server must be an error")
	}
}

// A string printed by a newer CLI, with a field this one does not know, still works.
func TestConnStringIgnoresUnknownFields(t *testing.T) {
	raw := `{"v":2,"servers":[{"host":"203.0.113.7","host_key":"SHA256:x","added_later":1}],"private_key":"k","added_later":{"a":1}}`
	c, err := ParseConnString(base64.StdEncoding.EncodeToString([]byte(raw)))
	if err != nil || c.Servers[0].Host != "203.0.113.7" || c.Servers[0].Port != 22 {
		t.Fatalf("got %+v, %v", c, err)
	}
}

// A server behind a bastion is version 3, which a CLI that does not know jump refuses instead of
// connecting directly; without a bastion, the string stays version 2.
func TestJumpRoundTrip(t *testing.T) {
	c := ConnString{
		Servers:    []Server{{Name: "main", Host: "10.0.0.5", Port: 22, User: "deploy", Jump: &Jump{Host: "bastion.example.com", HostKey: "SHA256:b"}}},
		PrivateKey: "k",
	}
	enc := c.Encode()
	raw, _ := base64.StdEncoding.DecodeString(enc)
	if !strings.Contains(string(raw), `"v":3`) {
		t.Fatalf("a bastion makes version 3: %s", raw)
	}
	got, err := ParseConnString(enc)
	if err != nil {
		t.Fatal(err)
	}
	if j := got.Servers[0].Jump; j == nil || j.Host != "bastion.example.com" || j.Port != 22 || j.User != "deploy" || j.HostKey != "SHA256:b" {
		t.Fatalf("the bastion, with its defaults: %+v", j)
	}
	c.Servers[0].Jump = nil
	raw, _ = base64.StdEncoding.DecodeString(c.Encode())
	if !strings.Contains(string(raw), `"v":2`) {
		t.Fatalf("without a bastion, version 2: %s", raw)
	}
}

func TestParseJump(t *testing.T) {
	cases := map[string]Jump{
		"bastion.example.com":          {Host: "bastion.example.com"},
		"admin@bastion.example.com":    {Host: "bastion.example.com", User: "admin"},
		"admin@203.0.113.7:2222":       {Host: "203.0.113.7", User: "admin", Port: 2222},
		"ssh://admin@[2001:db8::1]:22": {Host: "2001:db8::1", User: "admin", Port: 22},
	}
	for in, want := range cases {
		got, err := ParseJump(in)
		if err != nil || *got != want {
			t.Fatalf("%s: %+v, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "a@b,c@d", "@host", "host:x", "host:70000"} {
		if _, err := ParseJump(bad); err == nil {
			t.Fatalf("%q must be refused", bad)
		}
	}
}
