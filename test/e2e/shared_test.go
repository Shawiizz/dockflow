//go:build e2e

package e2e

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// sharedApp is an app of one service, alpine, that joins the shared network e2e-shared with
// alias, when given, and mounts the volume data with driver, when given.
func sharedApp(t *testing.T, dir, app, alias, driver string) {
	t.Helper()
	compose := fmt.Sprintf(`services:
  main:
    image: %s
    command: ["sleep", "3600"]
    init: true
    networks:
      default: {}
      e2e-shared: { aliases: [%s] }
    x-dockflow:
      health:
        grace: 1s
networks:
  e2e-shared: { external: true }
`, alpineImage, alias)
	if driver != "" {
		compose = strings.Replace(compose, `    init: true
`, `    init: true
    volumes: [data:/data]
`, 1) + fmt.Sprintf("volumes:\n  data: { driver: %s }\n", driver)
	}
	writeProject(t, dir, app, compose)
}

func TestSharedNetwork(t *testing.T) {
	a, b := filepath.Join(workDir, "journey32a"), filepath.Join(workDir, "journey32b")
	sharedApp(t, a, "journey32a", "shared-db", "")
	sharedApp(t, b, "journey32b", "shared-client", "")

	// a missing shared network: the plan says how to create it
	r := dockflow(t, a, "deploy")
	if r.code == 0 || !strings.Contains(r.out, "dockflow server network create e2e-shared") {
		t.Fatalf("a missing shared network must fail with the command that creates it, got %d:\n%s", r.code, r.out)
	}
	mustSucceed(t, dockflow(t, a, "server", "network", "create", "e2e-shared"), "server network create")
	mustSucceed(t, dockflow(t, a, "deploy"), "deploy a")
	r = dockflow(t, b, "deploy")
	mustSucceed(t, r, "deploy b")
	if !strings.Contains(r.out, "plan.no_limits") {
		t.Fatalf("a shared server warns about services without limits:\n%s", r.out)
	}

	// b reaches a by its alias on the shared network
	ip, _ := inServer("docker exec $(docker ps -q --filter label=com.docker.compose.project=journey32a-production --filter label=com.docker.compose.service=main) hostname -i | cut -d' ' -f1")
	got, err := inServer("docker exec $(docker ps -q --filter label=com.docker.compose.project=journey32b-production --filter label=com.docker.compose.service=main) getent hosts shared-db")
	if err != nil || !strings.Contains(got, "shared-db") {
		t.Fatalf("b resolves a's alias on the shared network: %q %v (a has %s)", got, err, ip)
	}

	r = dockflow(t, a, "server", "network", "list")
	mustSucceed(t, r, "server network list")
	if !strings.Contains(r.out, "e2e-shared") || !strings.Contains(r.out, "journey32b-production-main-1") {
		t.Fatalf("network list shows the network and its containers:\n%s", r.out)
	}
	r = dockflow(t, a, "server", "network", "remove", "e2e-shared")
	if r.code == 0 || !strings.Contains(r.out, "network.in_use") {
		t.Fatalf("a shared network in use is not removed, got %d:\n%s", r.code, r.out)
	}
	mustSucceed(t, dockflow(t, a, "destroy", "production"), "destroy a")
	mustSucceed(t, dockflow(t, b, "destroy", "production"), "destroy b")
	mustSucceed(t, dockflow(t, a, "server", "network", "remove", "e2e-shared"), "server network remove")
}

// buildVolumePlugin makes a Docker plugin of the test volume driver, and pushes it to the
// server's own registry, which the server has no network to reach otherwise.
const buildVolumePlugin = `set -e
rm -rf /tmp/vp && mkdir -p /tmp/vp/rootfs
id=$(docker create %s)
docker export $id | tar -x -C /tmp/vp/rootfs
docker rm $id >/dev/null
cp /volplugin /tmp/vp/rootfs/driver
mkdir -p /tmp/vp/rootfs/run/docker/plugins /tmp/vp/rootfs/data
cat > /tmp/vp/config.json <<'JSON'
{"description": "e2e volume driver", "documentation": "https://dockflow.shawiizz.dev",
 "entrypoint": ["/driver"], "env": [{"name": "GREETING", "settable": ["value"], "value": "hello"}],
 "interface": {"socket": "vol.sock", "types": ["docker.volumedriver/1.0"]},
 "network": {"type": "host"}, "propagatedMount": "/data", "linux": {"capabilities": []}}
JSON
docker plugin create 127.0.0.1:5959/e2e/vol:1 /tmp/vp >/dev/null
docker plugin push 127.0.0.1:5959/e2e/vol:1 >/dev/null
docker plugin rm 127.0.0.1:5959/e2e/vol:1 >/dev/null`

func TestVolumePlugin(t *testing.T) {
	if out, err := inServer(fmt.Sprintf(buildVolumePlugin, alpineImage)); err != nil {
		t.Fatalf("build the test plugin: %v\n%s", err, out)
	}
	dir := filepath.Join(workDir, "journey33")
	sharedApp(t, dir, "journey33", "vol", "e2evol")
	mustSucceed(t, dockflow(t, dir, "server", "network", "create", "e2e-shared"), "server network create")
	t.Cleanup(func() { dockflow(t, dir, "server", "network", "remove", "e2e-shared") })

	r := dockflow(t, dir, "deploy")
	if r.code == 0 || !strings.Contains(r.out, "plan.volume_driver") {
		t.Fatalf("a volume whose plugin is missing must fail with plan.volume_driver, got %d:\n%s", r.code, r.out)
	}
	r = dockflow(t, dir, "server", "plugin", "install", "127.0.0.1:5959/e2e/vol:1", "--alias", "e2evol", "GREETING=bonjour-s3cret")
	mustSucceed(t, r, "server plugin install")
	if !strings.Contains(r.out, "network: host") || strings.Contains(r.out, "bonjour-s3cret") {
		t.Fatalf("install shows the privileges it grants, and never a setting's value:\n%s", r.out)
	}
	r = dockflow(t, dir, "server", "plugin", "list")
	mustSucceed(t, r, "server plugin list")
	if !strings.Contains(r.out, "e2evol:latest") || !strings.Contains(r.out, "docker.volumedriver/1.0") || strings.Contains(r.out, "bonjour-s3cret") {
		t.Fatalf("plugin list:\n%s", r.out)
	}

	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy with a plugin volume")
	if got, _ := inServer("docker exec $(docker ps -q --filter label=com.docker.compose.project=journey33-production --filter label=com.docker.compose.service=main) cat /data/greeting"); got != "bonjour-s3cret" {
		t.Fatalf("the volume comes from the plugin, with its setting: %q", got)
	}
	r = dockflow(t, dir, "server", "plugin", "remove", "e2evol")
	if r.code == 0 || !strings.Contains(r.out, "plugin.in_use") {
		t.Fatalf("a plugin in use is not removed, got %d:\n%s", r.code, r.out)
	}
	mustSucceed(t, dockflow(t, dir, "destroy", "production", "--volumes"), "destroy")
	mustSucceed(t, dockflow(t, dir, "server", "plugin", "remove", "e2evol"), "server plugin remove")
}
