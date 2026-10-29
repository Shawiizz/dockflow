package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/connection"
)

func TestCloudInit(t *testing.T) {
	var out, errOut bytes.Buffer
	a := &app{stdout: &out, stderr: &errOut, stdin: os.Stdin, interrupts: make(chan struct{}, 2)}
	root := a.root()
	root.SetArgs([]string{"--json", "server", "cloud-init", "--host", "203.0.113.9", "--from", "198.51.100.0/24", "--nginx", "--harden-ssh"})
	if err := root.Execute(); err != nil {
		t.Fatalf("%v\n%s", err, errOut.String())
	}
	var doc struct {
		Connection string `json:"connection"`
		HostKey    string `json:"host_key"`
		UserData   string `json:"user_data"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(doc.UserData, "#cloud-config\n") {
		t.Fatalf("user-data starts with #cloud-config:\n%s", doc.UserData)
	}
	var cfg cloudConfig
	if err := yaml.Unmarshal([]byte(doc.UserData), &cfg); err != nil {
		t.Fatal(err)
	}
	// the connection string pins the host key the user-data installs
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(cfg.SSHKeys["ed25519_public"]))
	if err != nil {
		t.Fatal(err)
	}
	cs, err := connection.ParseConnString(doc.Connection)
	if err != nil {
		t.Fatal(err)
	}
	if fp := ssh.FingerprintSHA256(pub); cs.Servers[0].HostKey != fp || doc.HostKey != fp {
		t.Fatalf("host key %s, connection string %s", fp, cs.Servers[0].HostKey)
	}
	// the deploy key: its public part, restricted, in the script; its private part only in the
	// connection string
	signer, err := ssh.ParsePrivateKey([]byte(cs.PrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	script := cfg.WriteFiles[0].Content
	blob := strings.Fields(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))[1]
	if !strings.Contains(script, `from="198.51.100.0/24",restrict,port-forwarding,pty ssh-ed25519 `+blob) {
		t.Fatalf("the script installs the restricted deploy key:\n%s", script)
	}
	if strings.Contains(doc.UserData, "PRIVATE KEY-----\n"+strings.Split(cs.PrivateKey, "\n")[1]) {
		t.Fatal("the deploy key's private part must not be in the user-data")
	}
	if !strings.Contains(script, "DF_NGINX='1'") || !strings.Contains(script, "DF_HARDEN='1'") {
		t.Fatal("with --harden-ssh and --nginx, the script hardens SSH and installs nginx")
	}
	if len(cfg.RunCmd) != 2 || cfg.RunCmd[0][1] != cfg.WriteFiles[0].Path {
		t.Fatalf("runcmd: %v", cfg.RunCmd)
	}
}

// SSH's settings are the administrator's: hardening is opt-in (ADR-0024)
func TestCloudInitLeavesSSHAlone(t *testing.T) {
	var out, errOut bytes.Buffer
	a := &app{stdout: &out, stderr: &errOut, stdin: os.Stdin, interrupts: make(chan struct{}, 2)}
	root := a.root()
	root.SetArgs([]string{"--json", "server", "cloud-init", "--host", "203.0.113.9"})
	if err := root.Execute(); err != nil {
		t.Fatalf("%v\n%s", err, errOut.String())
	}
	if !strings.Contains(out.String(), `DF_HARDEN='0'`) {
		t.Fatalf("without --harden-ssh, the script leaves SSH alone:\n%s", out.String())
	}
}
