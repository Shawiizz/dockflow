//go:build e2e

package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func jobsApp(app, image string, migrateExit int) string {
	return fmt.Sprintf(`services:
  migrate:
    image: %[3]s
    command: ["sh", "-c", "echo migrating %[2]s; exit %[4]d"]
  warm:
    image: %[3]s
    command: ["sh", "-c", "echo warming caches"]
    x-dockflow:
      run: after
  web:
    image: %[2]s
    depends_on:
      migrate:
        condition: service_completed_successfully
    x-dockflow:
      routes:
        - domains: ["%[1]s.test"]
          port: 80
          tls: false
      rollout:
        drain: 1s
      health:
        grace: 1s
`, app, image, alpineImage, migrateExit)
}

func TestJobs(t *testing.T) {
	app := "journey9"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, jobsApp(app, "whoami-e2e:v1", 0))
	r := dockflow(t, dir, "deploy")
	mustSucceed(t, r, "deploy with jobs")
	if !strings.Contains(r.out, "migrating whoami-e2e:v1") || !strings.Contains(r.out, "warming caches") {
		t.Fatalf("the jobs' output must be streamed:\n%s", r.out)
	}
	p := planOf(t, r)
	var order []string
	for _, a := range p.Actions {
		if a.Kind != "network.create" {
			order = append(order, a.Kind+" "+a.Target)
		}
	}
	if strings.Join(order, ", ") != "job.run migrate, service.create web, routes.apply "+app+"-production, job.run warm" {
		t.Fatalf("unexpected order: %v", order)
	}
	waitServing(t, app+".test")

	// a deploy that changes nothing runs no job
	again := dockflow(t, dir, "deploy")
	mustSucceed(t, again, "deploy again")
	if strings.Contains(again.out, "migrating") {
		t.Fatalf("no job may run when nothing changes:\n%s", again.out)
	}

	// a failing before job stops the deploy before anything is switched
	l := startLoad(t, app+".test", 2)
	writeProject(t, dir, app, jobsApp(app, "whoami-e2e:v2", 3))
	failed := dockflow(t, dir, "deploy")
	l.stop(t)
	if failed.code != 8 || failed.has("switch.changed") || !strings.Contains(failed.out, "job.failed") {
		t.Fatalf("a failing migration must stop the deploy (exit 8) before the switch, got %d:\n%s", failed.code, failed.out)
	}
	left, _ := inServer("docker ps -a --format '{{.Names}}' --filter label=dockflow.kind=job")
	if strings.TrimSpace(left) != "" {
		t.Fatalf("job containers must be removed: %s", left)
	}
}

// A first deploy of an app with a database: the migration runs once the database is up and
// before the web service, and a before_deploy exec hook of a service with no container yet is
// skipped instead of failing the deploy.
func TestFirstDeployWithDatabaseAndMigration(t *testing.T) {
	app := "journey19"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, fmt.Sprintf(`services:
  db:
    image: %[2]s
    command: ["sleep", "infinity"]
    init: true
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      start_interval: 1s
  migrate:
    image: %[2]s
    command: ["sh", "-c", "nslookup db >/dev/null && echo migrated against db"]
    depends_on:
      db:
        condition: service_healthy
  web:
    image: whoami-e2e:v1
    depends_on:
      migrate:
        condition: service_completed_successfully
    x-dockflow:
      routes:
        - domains: ["%[1]s.test"]
          port: 80
          tls: false
      health:
        grace: 1s
`, app, alpineImage))
	cfg := fmt.Sprintf(`version: 1
app: %s
hooks:
  before_deploy:
    - name: drain-web
      service: web
      exec: ["sh", "-c", "echo draining"]
environments:
  production:
    deploy:
      timeout: 60s
`, app)
	if err := os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	r := dockflow(t, dir, "deploy")
	mustSucceed(t, r, "first deploy with a database and a migration")
	if !strings.Contains(r.out, "migrated against db") || !strings.Contains(r.out, "drain-web skipped") {
		t.Fatalf("the migration must reach the database, and the exec hook be skipped:\n%s", r.out)
	}
	var order []string
	for _, a := range planOf(t, r).Actions {
		if strings.HasPrefix(a.Kind, "service.") || a.Kind == "job.run" {
			order = append(order, a.Kind+" "+a.Target)
		}
	}
	if got := strings.Join(order, ", "); got != "service.create db, job.run migrate, service.create web" {
		t.Fatalf("unexpected order: %s", got)
	}
	waitServing(t, app+".test")
}
