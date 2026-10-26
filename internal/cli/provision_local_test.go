package cli

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestSSHPort(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  int
	}{
		{"no configuration", nil, 22},
		{"default", map[string]string{"sshd_config": "#Port 22\nPermitRootLogin no\n"}, 22},
		{"set", map[string]string{"sshd_config": "Port 2222\nPort 2223\n"}, 2222},
		{"case and spaces", map[string]string{"sshd_config": "  port   4022\n"}, 4022},
		{"included first", map[string]string{
			"sshd_config":             "Include /etc/ssh/sshd_config.d/*.conf\nPort 2200\n",
			"sshd_config.d/port.conf": "Port 2201\n",
		}, 2201},
		{"relative include", map[string]string{
			"sshd_config":             "Include sshd_config.d/*.conf\n",
			"sshd_config.d/port.conf": "Port 2202\n",
		}, 2202},
		{"after a match block", map[string]string{"sshd_config": "Match User git\n  AllowTcpForwarding no\nPort 2203\n"}, 22},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			old := sshDir
			sshDir = dir
			defer func() { sshDir = old }()
			for name, content := range c.files {
				content = strings.ReplaceAll(content, "/etc/ssh", dir)
				os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755)
				os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644)
			}
			if got := sshPort(filepath.Join(dir, "sshd_config")); got != c.want {
				t.Fatalf("port %d, want %d", got, c.want)
			}
		})
	}
}

func TestHostKeyFingerprintPrefersEd25519(t *testing.T) {
	dir := t.TempDir()
	old := sshDir
	sshDir = dir
	defer func() { sshDir = old }()
	if _, err := hostKeyFingerprint(); err == nil {
		t.Fatal("no host key must be an error")
	}
	ecPriv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ecPub, _ := ssh.NewPublicKey(&ecPriv.PublicKey)
	edKey, _, _ := ed25519.GenerateKey(rand.Reader)
	edPub, _ := ssh.NewPublicKey(edKey)
	ecLine, edLine := ssh.MarshalAuthorizedKey(ecPub), ssh.MarshalAuthorizedKey(edPub)
	os.WriteFile(filepath.Join(dir, "ssh_host_ecdsa_key.pub"), ecLine, 0o644)
	got, err := hostKeyFingerprint()
	if err != nil || got != ssh.FingerprintSHA256(ecPub) {
		t.Fatalf("the ecdsa key when there is no ed25519 key: %q, %v", got, err)
	}
	os.WriteFile(filepath.Join(dir, "ssh_host_ed25519_key.pub"), edLine, 0o644)
	if fp, err := hostKeyFingerprint(); err != nil || fp != ssh.FingerprintSHA256(edPub) {
		t.Fatalf("the ed25519 key first: %q (ecdsa %q), %v", fp, got, err)
	}
}

func TestPublicHostFlagWins(t *testing.T) {
	if h, err := publicHost("deploy.example.com"); err != nil || h != "deploy.example.com" {
		t.Fatalf("%q, %v", h, err)
	}
}
