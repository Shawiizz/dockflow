//go:build e2e

package e2e

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// reachable tells whether a TCP connection from outside the server reaches host:port.
func reachable(host string, port int) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, fmt.Sprint(port)), 2*time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// The port filter drops connections from outside to ports Docker publishes, unless an app lists
// them under firewall.public_ports, from everywhere or from its CIDRs (ADR-0014).
func TestPortFilter(t *testing.T) {
	app := "journey29"
	dir := filepath.Join(workDir, app)
	compose := `services:
  web:
    image: whoami-e2e:v1
    ports: ["18081:80"]
`
	writeProject(t, dir, app, compose)
	first := dockflow(t, dir, "deploy")
	mustSucceed(t, first, "deploy a published port")
	if !strings.Contains(first.out, "18081/tcp is published on every interface") {
		t.Fatalf("an unlisted public port must be warned about:\n%s", first.out)
	}
	if reachable(serverIP, 18081) {
		t.Fatal("a port no app lists must not be reachable from outside")
	}
	if !reachable(serverIP, 80) {
		t.Fatal("the switch's port 80 stays open")
	}

	listed := func(firewall string) {
		t.Helper()
		yml := fmt.Sprintf("version: 1\napp: %s\n%s\nenvironments:\n  production: {}\n", app, firewall)
		if err := os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(yml), 0o644); err != nil {
			t.Fatal(err)
		}
		r := dockflow(t, dir, "deploy")
		mustSucceed(t, r, "deploy with "+firewall)
		if !r.has("filter.applied") {
			t.Fatalf("a change of public ports must apply the filter:\n%s", r.out)
		}
	}
	listed("firewall:\n  public_ports: [18081]")
	if !reachable(serverIP, 18081) {
		t.Fatal("a listed port must be reachable")
	}
	listed("firewall:\n  public_ports:\n    - { port: 18081, protocol: tcp, from: [192.0.2.0/24] }")
	if reachable(serverIP, 18081) {
		t.Fatal("a port open to other sources must not be reachable from here")
	}

	mustSucceed(t, dockflow(t, dir, "-y", "destroy", "production"), "destroy")
}
