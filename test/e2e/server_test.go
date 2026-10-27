//go:build e2e

package e2e

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestServerCommands(t *testing.T) {
	app := "journey37"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy")
	t.Cleanup(func() { dockflow(t, dir, "destroy", "production") })

	// the commands that act on what the server runs need none of the app's variables: here the
	// Compose file uses one that is not given
	elsewhere := filepath.Join(workDir, app+"-nosecrets")
	writeProject(t, elsewhere, app, webApp(app, "whoami-e2e:${UNGIVEN_TAG}", ""))
	for _, args := range [][]string{{"status", "production"}, {"ps", "production"}, {"logs", "production", "web", "--lines", "1"}, {"server", "status"}} {
		mustSucceed(t, dockflow(t, elsewhere, args...), strings.Join(args, " ")+" without the app's variables")
	}
	if r := dockflow(t, elsewhere, "logs", "production", "nosuchservice"); r.code == 0 || !strings.Contains(r.out, "no container of a service nosuchservice") {
		t.Fatalf("logs of a service the server does not run: exit %d\n%s", r.code, r.out)
	}
	if r := dockflow(t, elsewhere, "deploy"); r.code == 0 || !strings.Contains(r.out, "UNGIVEN_TAG") {
		t.Fatalf("a deploy still needs them: exit %d\n%s", r.code, r.out)
	}

	r := dockflow(t, dir, "server", "status")
	mustSucceed(t, r, "server status")
	compact := strings.Join(strings.Fields(r.out), "")
	for _, want := range []string{`"name":"dockflow-switch","state":"running"`, `"name":"dockflow-watchdog","state":"running"`, `"stack":"journey37-production"`, `"edge":"builtin"`} {
		if !strings.Contains(compact, want) {
			t.Fatalf("server status lacks %s:\n%s", want, r.out)
		}
	}

	r = dockflow(t, dir, "server", "check")
	mustSucceed(t, r, "server check")
	compact = strings.Join(strings.Fields(r.out), "")
	for _, want := range []string{`"name":"docker","level":"ok"`, `"name":"secrets","level":"ok"`, `"name":"state","level":"ok"`, `"name":"switch","level":"ok"`} {
		if !strings.Contains(compact, want) {
			t.Fatalf("server check lacks %s:\n%s", want, r.out)
		}
	}

	mustSucceed(t, dockflow(t, dir, "server", "edge", "external"), "server edge external")
	if got, _ := inServer("cat /var/lib/dockflow/server.json"); !strings.Contains(got, `"edge": "external"`) {
		t.Fatalf("server edge changes the edge:\n%s", got)
	}
	mustSucceed(t, dockflow(t, dir, "server", "edge", "builtin"), "server edge builtin")
	waitServing(t, app+".test")

	mustSucceed(t, dockflow(t, dir, "server", "init", "--acme-email", "ops@example.com"), "server init --acme-email")
	t.Cleanup(func() { dockflow(t, dir, "server", "init", "--acme-email", "") })

	// the watchdog runs this version's agent
	// without network, the images stay and the upgrade says so (upgrade.pull); with network
	// (CI's Docker-in-Docker), they are pulled again
	r = dockflow(t, dir, "server", "upgrade")
	mustSucceed(t, r, "server upgrade")
	if got, _ := inServer("cat /var/lib/dockflow/server.json"); !strings.Contains(got, `"acme_email": "ops@example.com"`) {
		t.Fatalf("server upgrade keeps the ACME email:\n%s", got)
	}
	waitServing(t, app+".test")
}
