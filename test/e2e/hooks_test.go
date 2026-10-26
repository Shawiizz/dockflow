//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func hooksProject(t *testing.T, dir, app, hooks, image string) {
	t.Helper()
	writeProject(t, dir, app, webApp(app, image, ""))
	cfg := fmt.Sprintf("version: 1\napp: %s\nhooks:\n%s\nnotify:\n  - url: %s\n    secret: hook-secret\nenvironments:\n  production:\n    deploy:\n      timeout: 60s\n", app, hooks, webhookURL)
	if err := os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
}

// webhookURL receives the runs' webhooks, on this machine, where the CLI runs.
var webhookURL string

func TestHooks(t *testing.T) {
	var mu sync.Mutex
	var received []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var p map[string]any
		json.Unmarshal(body, &p)
		if r.Header.Get("X-Dockflow-Signature") == "" {
			p["unsigned"] = true
		}
		mu.Lock()
		received = append(received, p)
		mu.Unlock()
	}))
	defer srv.Close()
	webhookURL = srv.URL
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

	mu.Lock()
	if len(received) != 1 || received[0]["status"] != "success" || received[0]["release"] != float64(1) || received[0]["unsigned"] != nil {
		t.Fatalf("the deploy must send one signed success webhook: %v", received)
	}
	mu.Unlock()

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
	mu.Lock()
	defer mu.Unlock()
	last := received[len(received)-1]
	if last["status"] != "failure" || last["outcome"] != "rolled_back" {
		t.Fatalf("the rolled back deploy must send a failure webhook: %v", last)
	}
}
