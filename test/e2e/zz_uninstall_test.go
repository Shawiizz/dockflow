//go:build e2e

package e2e

import (
	"path/filepath"
	"strings"
	"testing"
)

// Last of the suite: it removes Dockflow from the server, then installs it again.
func TestUninstall(t *testing.T) {
	app := "journey38"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", "")+"volumes:\n  data: {}\n")
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy")
	mustSucceed(t, dockflow(t, dir, "server", "network", "create", "e2e-uninstall"), "server network create")

	r := dockflow(t, dir, "--yes", "server", "uninstall", "--volumes")
	mustSucceed(t, r, "server uninstall")
	t.Cleanup(func() {
		if r := serverInit(); r.code != 0 {
			t.Errorf("installing Dockflow again: exit %d\n%s", r.code, r.out)
		}
	})
	if got, _ := inServer("docker ps -a --filter label=dockflow.managed=true --format '{{.Label \"dockflow.kind\"}}' | grep -v -e run -e helper | wc -l"); got != "0" {
		t.Fatalf("no container of Dockflow's stays: %s", got)
	}
	if got, _ := inServer("docker network ls --format '{{.Name}}' | grep -e journey38 -e e2e-uninstall | wc -l"); got != "0" {
		t.Fatalf("the networks are removed: %s", got)
	}
	if got, _ := inServer("docker volume ls --format '{{.Name}}' | grep -e journey38 -e dockflow-switch -e dockflow-registry || true"); got != "" {
		t.Fatalf("the volumes are removed: %s\n%s", got, r.out)
	}
	if got, _ := inServer("ls -A /var/lib/dockflow"); strings.TrimSpace(got) != "server.lock" {
		t.Fatalf("the state is removed: %q", got)
	}
	if _, err := inServer("iptables -n -L DOCKFLOW-FILTER"); err == nil {
		t.Fatal("the filter's chain is removed")
	}
	if _, err := inServer("iptables -n -L DOCKFLOW-INPUT || ip6tables -n -L DOCKFLOW-INPUT"); err == nil {
		t.Fatal("the filter's INPUT chain is removed")
	}
}
