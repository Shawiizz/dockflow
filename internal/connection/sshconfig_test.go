package connection

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadSSHConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.MkdirAll(filepath.Join(home, ".ssh", "conf.d"), 0o700)
	os.WriteFile(filepath.Join(home, ".ssh", "config"), []byte(`
# the first value of each keyword wins
Include conf.d/*.conf

Host vps prod-*
  HostName=203.0.113.10
  Port 2222
  User deploy
  IdentityFile ~/.ssh/vps_ed25519

Host prod-* !prod-old
  Port 2200
  IdentityFile ~/.ssh/%h.key

Match host *.internal
  User nobody

Host *
  User fallback
`), 0o600)
	os.WriteFile(filepath.Join(home, ".ssh", "conf.d", "lab.conf"), []byte("Host lab\n  HostName 10.0.0.9\n"), 0o600)

	vps := ReadSSHConfig("vps")
	if vps.HostName != "203.0.113.10" || vps.Port != 2222 || vps.User != "deploy" ||
		len(vps.IdentityFiles) != 1 || vps.IdentityFiles[0] != filepath.Join(home, ".ssh", "vps_ed25519") {
		t.Fatalf("vps: %+v", vps)
	}
	web := ReadSSHConfig("prod-web")
	if web.Port != 2222 || len(web.IdentityFiles) != 2 || web.IdentityFiles[1] != filepath.Join(home, ".ssh", "203.0.113.10.key") {
		t.Fatalf("prod-web: the first Port wins, every IdentityFile adds: %+v", web)
	}
	if old := ReadSSHConfig("prod-old"); len(old.IdentityFiles) != 1 {
		t.Fatalf("prod-old is negated in the second block: %+v", old)
	}
	if lab := ReadSSHConfig("lab"); lab.HostName != "10.0.0.9" || lab.User != "fallback" {
		t.Fatalf("lab comes from the included file: %+v", lab)
	}
	if other := ReadSSHConfig("db.internal"); other.User != "fallback" {
		t.Fatalf("a Match block is skipped: %+v", other)
	}

	tg := &Target{Server: Server{Host: "vps", User: "root"}}
	tg.UseSSHConfig(false, true)
	if tg.Server.Host != "203.0.113.10" || tg.Server.Port != 2222 || tg.Server.User != "root" {
		t.Fatalf("the target's own user wins over the file's: %+v", tg.Server)
	}
}

// ProxyJump of ~/.ssh/config is the bastion, completed from its own Host block; a chain, or
// ProxyJump none, is not one.
func TestProxyJumpFromSSHConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	os.WriteFile(filepath.Join(home, ".ssh", "config"), []byte(`
Host prod
  HostName 10.0.0.5
  ProxyJump bastion

Host direct
  HostName 10.0.0.6
  ProxyJump none

Host chained
  ProxyJump a@one,b@two

Host ssm
  ProxyCommand aws ssm start-session --target %h

Host bastion
  HostName 203.0.113.7
  Port 2222
  User admin
  IdentityFile ~/.ssh/bastion_key
`), 0o600)

	tgt := &Target{Server: Server{Host: "prod"}}
	if err := tgt.UseSSHConfig(false, false); err != nil {
		t.Fatal(err)
	}
	tgt.Defaults("dockflow")
	j := tgt.Server.Jump
	if tgt.Server.Host != "10.0.0.5" || j == nil || j.Host != "203.0.113.7" || j.Port != 2222 || j.User != "admin" {
		t.Fatalf("prod goes through bastion: %+v %+v", tgt.Server, j)
	}
	if len(tgt.JumpIdentityFiles) != 1 || tgt.JumpIdentityFiles[0] != filepath.Join(home, ".ssh", "bastion_key") {
		t.Fatalf("the bastion's keys: %v", tgt.JumpIdentityFiles)
	}

	// a bastion given by the caller wins, and is completed from ~/.ssh/config too
	tgt = &Target{Server: Server{Host: "prod", Jump: &Jump{Host: "bastion", User: "me"}}}
	tgt.UseSSHConfig(false, false)
	if j := tgt.Server.Jump; j.Host != "203.0.113.7" || j.User != "me" || j.Port != 2222 {
		t.Fatalf("the caller's bastion: %+v", j)
	}

	tgt = &Target{Server: Server{Host: "direct"}}
	if tgt.UseSSHConfig(false, false); tgt.Server.Jump != nil {
		t.Fatalf("ProxyJump none is no bastion")
	}
	if err := (&Target{Server: Server{Host: "chained"}}).UseSSHConfig(false, false); err == nil {
		t.Fatal("a chain of bastions must be refused")
	}
	if err := (&Target{Server: Server{Host: "ssm"}}).UseSSHConfig(false, false); err == nil || !strings.Contains(err.Error(), "ProxyCommand") {
		t.Fatalf("a ProxyCommand must be refused, not ignored: %v", err)
	}
}
