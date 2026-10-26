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
