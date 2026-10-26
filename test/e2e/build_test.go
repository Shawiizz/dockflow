//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// builtApp builds its web service from a Dockerfile: whoami, named MESSAGE at build time.
func builtApp(t *testing.T, dir, app, message string) {
	t.Helper()
	writeProject(t, dir, app, fmt.Sprintf(`services:
  web:
    build:
      context: .
      dockerfile: docker/Dockerfile
      args:
        MESSAGE: %s
    x-dockflow:
      routes:
        - domains: ["%s.test"]
          port: 80
          tls: false
      rollout:
        drain: 1s
      health:
        grace: 1s
`, message, app))
	os.MkdirAll(filepath.Join(dir, "docker"), 0o755)
	dockerfile := fmt.Sprintf(`FROM %s
ARG MESSAGE
ENV WHOAMI_NAME=$MESSAGE
`, whoamiImage)
	if err := os.WriteFile(filepath.Join(dir, "docker", "Dockerfile"), []byte(dockerfile), 0o644); err != nil {
		t.Fatal(err)
	}
}

// served returns the name whoami answers with.
func served(t *testing.T, host string) string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, "http://"+serverIP+"/", nil)
	req.Host = host
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	for _, line := range strings.Split(string(b), "\n") {
		if name, ok := strings.CutPrefix(line, "Name: "); ok {
			return strings.TrimSpace(name)
		}
	}
	return ""
}

func pushes(r result) []map[string]any {
	var out []map[string]any
	for _, e := range r.events {
		if e.Type == "push.finished" {
			var d map[string]any
			json.Unmarshal(e.Data, &d)
			out = append(out, d)
		}
	}
	return out
}

func TestBuildPushAndDeploy(t *testing.T) {
	app := "journey5"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	builtApp(t, dir, app, "first")

	r := dockflow(t, dir, "deploy")
	mustSucceed(t, r, "deploy a built image")
	p := pushes(r)
	if len(p) != 1 || !strings.HasPrefix(p[0]["image"].(string), "127.0.0.1:5959/journey5/web@sha256:") {
		t.Fatalf("the image must be pushed to the server's registry: %v\n%s", p, r.out)
	}
	waitServing(t, host)
	if got := served(t, host); got != "first" {
		t.Fatalf("served %q, want first", got)
	}

	again := dockflow(t, dir, "deploy")
	mustSucceed(t, again, "deploy the same code")
	if p := pushes(again); len(p) != 1 || p[0]["blobs_sent"].(float64) != 0 {
		t.Fatalf("an unchanged image must send nothing: %v", p)
	}
	if !again.has("plan.empty") {
		t.Fatalf("an unchanged build must change nothing:\n%s", again.out)
	}

	builtApp(t, dir, app, "second")
	l := startLoad(t, host, 4)
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy a new build")
	l.stop(t)
	if got := served(t, host); got != "second" {
		t.Fatalf("served %q, want second", got)
	}

	// a rollback uses the image the server kept: nothing is built or pushed
	back := dockflow(t, dir, "rollback")
	mustSucceed(t, back, "rollback")
	if len(pushes(back)) != 0 || back.has("build.started") {
		t.Fatalf("a rollback must not build:\n%s", back.out)
	}
	if got := served(t, host); got != "first" {
		t.Fatalf("served %q after the rollback, want first", got)
	}
}
