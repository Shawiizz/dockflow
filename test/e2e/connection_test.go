//go:build e2e

package e2e

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// server connection prints a connection string a deploy can use, holding the host key SSH
// verified, and refuses a server whose host key it cannot verify.
func TestServerConnection(t *testing.T) {
	raw, _ := base64.StdEncoding.DecodeString(connString)
	var want struct {
		Servers []struct {
			HostKey string `json:"host_key"`
		} `json:"servers"`
		PrivateKey string `json:"private_key"`
	}
	json.Unmarshal(raw, &want)
	key := filepath.Join(workDir, "deploy_key")
	os.WriteFile(key, []byte(want.PrivateKey), 0o600)
	fp := want.Servers[0].HostKey

	run := func(args ...string) (string, int) {
		cmd := exec.Command(binary, args...)
		cmd.Env = append(os.Environ(), "HOME="+workDir)
		out, _ := cmd.CombinedOutput()
		return strings.TrimSpace(string(out)), cmd.ProcessState.ExitCode()
	}
	out, code := run("server", "connection", "root@"+serverIP+":2222", "-k", key, "--host-key", fp)
	if code != 0 {
		t.Fatalf("server connection: exit %d: %s", code, out)
	}
	got, err := base64.StdEncoding.DecodeString(out)
	if err != nil {
		t.Fatalf("not a connection string: %q", out)
	}
	if !strings.Contains(string(got), fp) || !strings.Contains(string(got), `"user":"root"`) {
		t.Fatalf("the connection string must hold the verified host key and the user: %s", got)
	}

	app := "journey18"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	if out, code := run("--json", "-y", "-C", dir, "--connection", out, "deploy"); code != 0 {
		t.Fatalf("deploy with the printed connection string: exit %d: %s", code, out)
	}

	out, code = run("server", "connection", "root@"+serverIP+":2222", "-k", key)
	if code != 4 || !strings.Contains(out, "ssh.host_key_unknown") && !strings.Contains(out, "not pinned") {
		t.Fatalf("an unverifiable host key must be refused with exit 4, got %d: %s", code, out)
	}
}

// server init <admin>@<host> prepares a server from the administrator's account: the deploy
// user, its key generated here, the switch and the registry, and prints a connection string a
// deploy can use. Run again, it keeps the user and adds the new key.
func TestServerInitProvisions(t *testing.T) {
	raw, _ := base64.StdEncoding.DecodeString(connString)
	var admin struct {
		Servers []struct {
			HostKey string `json:"host_key"`
		} `json:"servers"`
		PrivateKey string `json:"private_key"`
	}
	json.Unmarshal(raw, &admin)
	key := filepath.Join(workDir, "admin_key")
	os.WriteFile(key, []byte(admin.PrivateKey), 0o600)
	fp := admin.Servers[0].HostKey

	initServer := func() (string, int) {
		cmd := exec.Command(binary, "server", "init", "root@"+serverIP+":2222", "-k", key, "--host-key", fp,
			"--switch-image", caddyImage, "--registry-image", registryImage)
		cmd.Env = append(os.Environ(), "HOME="+workDir)
		out, _ := cmd.CombinedOutput()
		return string(out), cmd.ProcessState.ExitCode()
	}
	out, code := initServer()
	if code != 0 {
		t.Fatalf("server init: exit %d:\n%s", code, out)
	}
	for _, want := range []string{"creating the user dockflow", "installing the deploy key", "is ready"} {
		if !strings.Contains(out, want) {
			t.Fatalf("server init must report %q:\n%s", want, out)
		}
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	cs := lines[len(lines)-1]
	decoded, err := base64.StdEncoding.DecodeString(cs)
	if err != nil || !strings.Contains(string(decoded), `"user":"dockflow"`) || !strings.Contains(string(decoded), fp) {
		t.Fatalf("the last line must be the connection string of the deploy user: %q (%s)", cs, decoded)
	}
	keys, _ := inServer("cat /home/dockflow/.ssh/authorized_keys")
	if !strings.HasPrefix(strings.TrimSpace(keys), "restrict,port-forwarding,pty ssh-ed25519 ") {
		t.Fatalf("the deploy key must be restricted: %q", keys)
	}

	// the printed string deploys, through the deploy user's key
	app := "journey20"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	cmd := exec.Command(binary, "--json", "-y", "-C", dir, "deploy")
	cmd.Env = append(os.Environ(), "HOME="+workDir, "PRODUCTION_CONNECTION="+cs)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("deploy with the printed connection string: %v\n%s", err, out)
	}

	again, code := initServer()
	// a new key each time: the user stays, its new key is added
	if code != 0 || strings.Contains(again, "creating the user") || !strings.Contains(again, "installing the deploy key") {
		t.Fatalf("a second server init must keep the user and add its new key, got exit %d:\n%s", code, again)
	}
}

func TestServerInitOnTheServer(t *testing.T) {
	// as an OpenSSH configuration would give it
	if _, err := inServer("mkdir -p /etc/ssh/sshd_config.d && echo 'Include /etc/ssh/sshd_config.d/*.conf' >/etc/ssh/sshd_config && echo 'Port 2222' >/etc/ssh/sshd_config.d/port.conf"); err != nil {
		t.Fatal(err)
	}
	if _, err := sh("docker", "cp", binary, dind+":/usr/local/bin/dockflow"); err != nil {
		t.Fatal(err)
	}
	out, err := sh("docker", "exec", "-w", "/", dind, "dockflow", "server", "init", "--host", serverIP, "--user", "deployer",
		"--switch-image", caddyImage, "--registry-image", registryImage)
	if err != nil {
		t.Fatalf("server init on the server: %v", err)
	}
	if !strings.Contains(out, "creating the user deployer") || !strings.Contains(out, "is ready") {
		t.Fatalf("server init must create the user and finish:\n%s", out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	cs := lines[len(lines)-1]
	decoded, _ := base64.StdEncoding.DecodeString(cs)
	fp, _ := inServer("cat /host_key_fingerprint")
	for _, want := range []string{`"host":"` + serverIP + `"`, `"port":2222`, `"user":"deployer"`, fp} {
		if !strings.Contains(string(decoded), want) {
			t.Fatalf("the connection string must hold %s: %s", want, decoded)
		}
	}

	// the printed string deploys from another machine
	app := "journey21"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	cmd := exec.Command(binary, "--json", "-y", "-C", dir, "deploy")
	cmd.Env = append(os.Environ(), "HOME="+workDir, "PRODUCTION_CONNECTION="+cs)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("deploy with the printed connection string: %v\n%s", err, out)
	}
}
