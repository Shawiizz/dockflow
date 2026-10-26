//go:build e2e

package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func hooksProject(t *testing.T, dir, app, hooks, image string) {
	t.Helper()
	writeProject(t, dir, app, webApp(app, image, ""))
	cfg := fmt.Sprintf("version: 1\napp: %s\nhooks:\n%s\nenvironments:\n  production:\n    deploy:\n      timeout: 60s\n", app, hooks)
	if err := os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHooks(t *testing.T) {
	app := "journey11"
	dir := filepath.Join(workDir, app)
	secret := []string{"PRODUCTION_TOKEN=s3cret-token"}
	hooksProject(t, dir, app, `  before_build:
    - run: echo "env=$DOCKFLOW_ENV token=$TOKEN" > hook-local.txt && echo "token is $TOKEN"
      secrets: [TOKEN]
  before_deploy:
    - host: echo "app=$DOCKFLOW_APP" > /tmp/hook-host.txt
  after_deploy:
    - exec: ["sh", "-c", "echo stack=$DOCKFLOW_STACK > /tmp/hook-exec.txt"]
      service: worker`, "whoami-e2e:v1")

	r := dockflowEnv(t, dir, secret, "deploy")
	mustSucceed(t, r, "deploy with hooks")
	if b, _ := os.ReadFile(filepath.Join(dir, "hook-local.txt")); strings.TrimSpace(string(b)) != "env=production token=s3cret-token" {
		t.Fatalf("the local hook got %q", b)
	}
	if strings.Contains(r.out, "s3cret-token") || !strings.Contains(r.out, "token is ***") {
		t.Fatalf("the secret must be masked in the hook's output:\n%s", r.out)
	}
	if got, _ := inServer("cat /tmp/hook-host.txt"); got != "app="+app {
		t.Fatalf("the host hook wrote %q", got)
	}
	if got, _ := inServer("docker exec $(docker ps -q --filter label=com.docker.compose.project=" + app + "-production --filter label=com.docker.compose.service=worker) cat /tmp/hook-exec.txt"); got != "stack="+app+"-production" {
		t.Fatalf("the exec hook wrote %q", got)
	}

	// a fatal before_deploy hook stops the deploy with nothing changed
	hooksProject(t, dir, app, `  before_deploy:
    - run: exit 4`, "whoami-e2e:v2")
	r = dockflowEnv(t, dir, secret, "deploy")
	if r.code != 11 || r.has("release.created") {
		t.Fatalf("a failing before_deploy hook must exit 11 before any release, got %d:\n%s", r.code, r.out)
	}

	// a fatal after_deploy exec hook rolls the deploy back
	hooksProject(t, dir, app, `  after_deploy:
    - exec: ["sh", "-c", "exit 5"]
      service: worker
      fatal: true`, "whoami-e2e:v2")
	r = dockflowEnv(t, dir, secret, "deploy")
	if r.code != 8 || !r.has("rollback.started") {
		t.Fatalf("a failing after_deploy hook must roll back (exit 8), got %d:\n%s", r.code, r.out)
	}
}
