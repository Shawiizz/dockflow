package connection

import (
	"os"
	"path/filepath"
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
