//go:build e2e

package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// healthApp is a routed whoami with an internal HTTP check, and dockflow.yml's public checks on
// the switch, reached from the agent through the server's bridge gateway.
func healthApp(t *testing.T, dir, app, gateway, image, internalPort, onFailure string, expected int) {
	t.Helper()
	compose := fmt.Sprintf(`services:
  web:
    image: %s
    deploy:
      replicas: 2
    x-dockflow:
      routes:
        - domains: ["%s"]
          port: 80
          tls: false
      rollout:
        drain: 1s
      health:
        grace: 1s
        http:
          path: /health
          port: %s
          retries: 3
          interval: 500ms
`, image, gateway, internalPort)
	cfg := fmt.Sprintf(`version: 1
app: %s
on_failure: %s
health:
  endpoints:
    - name: site
      url: http://%s/
      expected_status: %d
      retries: 2
      retry_delay: 500ms
      timeout: 5s
environments:
  production:
    deploy:
      timeout: 60s
`, app, onFailure, gateway, expected)
	os.MkdirAll(dir, 0o755)
	if err := os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHealthChecksAndOnFailure(t *testing.T) {
	gateway, err := inServer(`docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'`)
	if err != nil || gateway == "" {
		t.Fatalf("the server's bridge gateway: %v", err)
	}
	app := "journey7"
	dir := filepath.Join(workDir, app)

	healthApp(t, dir, app, gateway, "whoami-e2e:v1", "80", "rollback", 200)
	first := dockflow(t, dir, "deploy")
	mustSucceed(t, first, "deploy with passing checks")
	checks := 0
	for _, e := range first.events {
		if e.Type == "health.check" && strings.Contains(string(e.Data), `"ok":true`) {
			checks++
		}
	}
	if checks != 3 {
		t.Fatalf("want 2 internal checks and 1 public check, got %d:\n%s", checks, first.out)
	}
	waitServing(t, gateway)

	l := startLoad(t, gateway, 4)

	// a failing internal check stops the rollout before the switch
	healthApp(t, dir, app, gateway, "whoami-e2e:v2", "81", "rollback", 200)
	r := dockflow(t, dir, "deploy")
	if r.code != 8 || r.has("switch.changed") {
		t.Fatalf("a failing internal check must roll back before the switch (exit 8), got %d:\n%s", r.code, r.out)
	}

	// a failing public check switches back
	healthApp(t, dir, app, gateway, "whoami-e2e:v2", "80", "rollback", 418)
	r = dockflow(t, dir, "deploy")
	if r.code != 8 || !r.has("switch.changed") || !r.has("rollback.started") {
		t.Fatalf("a failing public check must roll back after the switch (exit 8), got %d:\n%s", r.code, r.out)
	}
	l.stop(t)

	// on_failure: ignore keeps the release, with a warning
	healthApp(t, dir, app, gateway, "whoami-e2e:v2", "80", "ignore", 418)
	r = dockflow(t, dir, "deploy")
	mustSucceed(t, r, "deploy with on_failure: ignore")
	if !strings.Contains(r.out, "health.check_failed") {
		t.Fatalf("the failed check must be a warning:\n%s", r.out)
	}

	// on_failure: fail leaves the failed release in place, and the environment degraded
	healthApp(t, dir, app, gateway, "whoami-e2e:v1", "80", "fail", 418)
	r = dockflow(t, dir, "deploy")
	if r.code != 9 || r.has("rollback.started") {
		t.Fatalf("on_failure: fail must leave the release in place (exit 9), got %d:\n%s", r.code, r.out)
	}
	st := dockflow(t, dir, "status", "production")
	if !strings.Contains(st.out, `"degraded": true`) {
		t.Fatalf("the environment must be degraded:\n%s", st.out)
	}
}
