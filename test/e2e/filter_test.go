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

// Over IPv6, docker-proxy receives a published port on the host itself when the app's network
// has no IPv6: the connection goes through INPUT, never DOCKER-USER. The filter denies over IPv6
// what it denies over IPv4 (ADR-0014).
func TestPortFilterIPv6(t *testing.T) {
	// the server joins a dual-stack network of this machine's Docker, where a client probes it
	network := fmt.Sprintf("dftest-v6-%d", time.Now().UnixNano()%1000000)
	// an IPv4 subnet out of Docker's default pools, which the server's own Docker uses
	if _, err := sh("docker", "network", "create", "--ipv6", "--subnet", "fd00:dfe2:e2e::/64", "--subnet", "10.254.213.0/24", network); err != nil {
		t.Skipf("this machine's Docker cannot create an IPv6 network: %v", err)
	}
	t.Cleanup(func() {
		sh("docker", "network", "disconnect", "-f", network, dind)
		sh("docker", "network", "rm", network)
	})
	if _, err := sh("docker", "network", "connect", network, dind); err != nil {
		t.Fatal(err)
	}
	if _, err := inServer("sysctl -qw net.ipv6.conf.all.disable_ipv6=0 net.ipv6.conf.default.disable_ipv6=0"); err != nil {
		t.Fatal(err)
	}
	addr, err := sh("docker", "inspect", "-f", fmt.Sprintf(`{{(index .NetworkSettings.Networks %q).GlobalIPv6Address}}`, network), dind)
	if err != nil || addr == "" {
		t.Skipf("the server has no IPv6 address on %s: %v", network, err)
	}
	reachable6 := func(port int) bool {
		_, err := sh("docker", "run", "--rm", "--network", network, alpineImage,
			"wget", "-q", "-T", "3", "-O", "/dev/null", fmt.Sprintf("http://[%s]:%d/", addr, port))
		return err == nil
	}

	app := "journey29v6"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, `services:
  web:
    image: whoami-e2e:v1
    ports: ["18082:80", "80"]
`)
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy published ports")
	t.Cleanup(func() { dockflow(t, dir, "-y", "destroy", "production") })
	// the bypass this test is about: docker-proxy listens on [::] for a network without IPv6
	ports, err := inServer("docker ps --format '{{.Names}} {{.Ports}}' | grep " + app)
	if err != nil || !strings.Contains(ports, "[::]:18082->") {
		t.Fatalf("18082 must be published on [::] for this test to mean anything: %v %s", err, ports)
	}
	// a random host port is bound to IPv4 only: the filter cannot know it in advance
	if strings.Count(ports, "[::]:") != 1 {
		t.Fatalf("a random host port must not be published on [::]: %s", ports)
	}
	if reachable6(18082) {
		t.Fatal("a port no app lists must not be reachable over IPv6")
	}

	listed := func(firewall string) {
		t.Helper()
		yml := fmt.Sprintf("version: 1\napp: %s\n%s\nenvironments:\n  production: {}\n", app, firewall)
		if err := os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(yml), 0o644); err != nil {
			t.Fatal(err)
		}
		mustSucceed(t, dockflow(t, dir, "deploy"), "deploy with "+firewall)
	}
	listed("firewall:\n  public_ports: [18082]")
	if !reachable6(18082) {
		t.Fatal("a listed port must be reachable over IPv6")
	}
	listed("firewall:\n  public_ports:\n    - { port: 18082, protocol: tcp, from: [192.0.2.0/24] }")
	if reachable6(18082) {
		t.Fatal("a port open to IPv4 sources only must not be reachable over IPv6")
	}
	listed("firewall:\n  public_ports:\n    - { port: 18082, protocol: tcp, from: [\"2001:db8::/32\"] }")
	if reachable6(18082) {
		t.Fatal("a port open to other IPv6 sources must not be reachable from here")
	}
}

// A server prepared by server cloud-init has its host key in the user-data, which the metadata
// service serves: the filter keeps containers from it (ADR-0014). The server here serves
// 169.254.169.254 itself, as some clouds do.
func TestPortFilterMetadata(t *testing.T) {
	t.Cleanup(func() {
		inServer("docker rm -f dftest-metadata; ip addr del 169.254.169.254/32 dev lo; rm -f /var/lib/dockflow/user-data-host-key")
		serverInit()
	})
	if _, err := inServer("ip addr add 169.254.169.254/32 dev lo && docker run -d --name dftest-metadata --network host whoami-e2e:v1 --port 8169"); err != nil {
		t.Fatal(err)
	}
	fromContainer := func() bool {
		_, err := inServer("docker run --rm " + alpineImage + " wget -q -T 3 -O /dev/null http://169.254.169.254:8169/")
		return err == nil
	}
	deadline := time.Now().Add(10 * time.Second)
	for !fromContainer() {
		if time.Now().After(deadline) {
			t.Fatal("the metadata stand-in must be reachable from a container before the marker")
		}
		time.Sleep(500 * time.Millisecond)
	}
	// what server cloud-init's provisioning leaves
	if _, err := inServer("touch /var/lib/dockflow/user-data-host-key"); err != nil {
		t.Fatal(err)
	}
	mustSucceed(t, serverInit(), "server init applies the filter")
	if fromContainer() {
		t.Fatal("a container must not reach the metadata service when the user-data holds the host key")
	}
}
