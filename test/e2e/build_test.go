//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
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

// The Dockerfile is a template: rendered with the environment's vars in a temporary copy, the
// project left untouched.
func TestTemplatedBuild(t *testing.T) {
	app := "journey8"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	builtApp(t, dir, app, "unused")
	cfg := fmt.Sprintf(`version: 1
app: %s
templates:
  - docker/Dockerfile
environments:
  production:
    vars:
      GREETING: hello
    deploy:
      timeout: 60s
`, app)
	os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644)
	dockerfile := fmt.Sprintf("FROM %s\nENV WHOAMI_NAME={{ GREETING }}-{{ DOCKFLOW_ENV }}\n", whoamiImage)
	os.WriteFile(filepath.Join(dir, "docker", "Dockerfile"), []byte(dockerfile), 0o644)

	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy a templated build")
	waitServing(t, host)
	if got := served(t, host); got != "hello-production" {
		t.Fatalf("served %q, want hello-production", got)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "docker", "Dockerfile")); !strings.Contains(string(b), "{{ GREETING }}") {
		t.Fatalf("the project's Dockerfile was modified:\n%s", b)
	}
}

// Images of releases that leave retention leave the server's registry too.
func TestRegistryRetention(t *testing.T) {
	app := "journey13"
	dir := filepath.Join(workDir, app)
	for _, v := range []string{"a", "b", "c"} {
		builtApp(t, dir, app, v)
		cfg := fmt.Sprintf("version: 1\napp: %s\nreleases:\n  keep: 2\nenvironments:\n  production:\n    deploy:\n      timeout: 60s\n", app)
		os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644)
		mustSucceed(t, dockflow(t, dir, "deploy", "--version", v), "deploy "+v)
	}
	tags, err := inServer("docker exec dockflow-registry wget -qO- http://127.0.0.1:5000/v2/" + app + "/web/tags/list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tags, `"b"`) || !strings.Contains(tags, `"c"`) || strings.Contains(tags, `"a"`) {
		t.Fatalf("the registry must keep the images of releases b and c only: %s", tags)
	}
	r := dockflow(t, dir, "prune", "production", "--registry")
	mustSucceed(t, r, "prune --registry")
	if !strings.Contains(r.out, `"registry_collected": true`) {
		t.Fatalf("prune --registry:\n%s", r.out)
	}
}

// build.builder: remote builds with the server's Docker: nothing is pushed, the service runs the
// image by ID, and an unchanged build changes nothing.
func TestRemoteBuild(t *testing.T) {
	app := "journey16"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	config := func() {
		cfg := fmt.Sprintf("version: 1\napp: %s\nbuild:\n  builder: remote\nenvironments:\n  production:\n    deploy:\n      timeout: 60s\n", app)
		os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644)
	}
	builtApp(t, dir, app, "remote")
	config()

	r := dockflow(t, dir, "deploy")
	mustSucceed(t, r, "deploy a remote build")
	if !r.has("build.finished") || len(pushes(r)) != 0 {
		t.Fatalf("a remote build must build and push nothing:\n%s", r.out)
	}
	waitServing(t, host)
	if got := served(t, host); got != "remote" {
		t.Fatalf("served %q, want remote", got)
	}
	images, _ := inServer("docker images --format '{{.Repository}}:{{.Tag}}' localhost/" + app + "/web")
	if !strings.Contains(images, "localhost/"+app+"/web:") {
		t.Fatalf("the image must be in the server's daemon: %q", images)
	}

	again := dockflow(t, dir, "deploy")
	mustSucceed(t, again, "deploy the same code")
	if !again.has("plan.empty") {
		t.Fatalf("an unchanged remote build must change nothing:\n%s", again.out)
	}

	builtApp(t, dir, app, "remote-two")
	config()
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy a new remote build")
	if got := served(t, host); got != "remote-two" {
		t.Fatalf("served %q, want remote-two", got)
	}
	mustSucceed(t, dockflow(t, dir, "rollback"), "rollback")
	if got := served(t, host); got != "remote" {
		t.Fatalf("served %q after the rollback, want remote", got)
	}
}

// build.engine: podman builds with Podman on this machine, and ships like a bake build.
func TestPodmanBuild(t *testing.T) {
	if err := exec.Command("podman", "version").Run(); err != nil {
		t.Skip("no podman")
	}
	app := "journey17"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	builtApp(t, dir, app, "podman")
	// Podman resolves short names only through its registries.conf
	qualified := whoamiImage
	if strings.Count(strings.Split(qualified, "/")[0], ".") == 0 {
		qualified = "docker.io/" + qualified
	}
	os.WriteFile(filepath.Join(dir, "docker", "Dockerfile"), []byte("FROM "+qualified+"\nARG MESSAGE\nENV WHOAMI_NAME=$MESSAGE\n"), 0o644)
	cfg := fmt.Sprintf("version: 1\napp: %s\nbuild:\n  engine: podman\nenvironments:\n  production:\n    deploy:\n      timeout: 60s\n", app)
	os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644)

	r := dockflow(t, dir, "deploy")
	mustSucceed(t, r, "deploy a podman build")
	if p := pushes(r); len(p) != 1 || !strings.HasPrefix(p[0]["image"].(string), "127.0.0.1:5959/"+app+"/web@sha256:") {
		t.Fatalf("the image must be pushed to the server's registry: %v\n%s", p, r.out)
	}
	waitServing(t, host)
	if got := served(t, host); got != "podman" {
		t.Fatalf("served %q, want podman", got)
	}
}
