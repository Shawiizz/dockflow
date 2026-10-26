//go:build e2e

package e2e

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func uploadsProject(t *testing.T, dir, app, command string) {
	t.Helper()
	compose := fmt.Sprintf(`services:
  site:
    image: %s
    command: %s
    volumes:
      - site:/srv
    x-dockflow:
      routes:
        - domains: ["%s.test"]
          port: 80
          tls: false
      rollout:
        drain: 1s
      health:
        grace: 1s
volumes:
  site: {}
`, caddyImage, command, app)
	cfg := fmt.Sprintf(`version: 1
app: %s
uploads:
  - src: public
    dest: volume:site
    mirror: true
    exclude: ["*.secret"]
  - src: deploy/app.conf
    dest: /etc/dockflow-e2e/%s.conf
    mode: "640"
environments:
  production:
    deploy:
      timeout: 60s
`, app, app)
	os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(compose), 0o644)
	os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644)
}

func get(t *testing.T, host, path string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, "http://"+serverIP+path, nil)
	req.Host = host
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, strings.TrimSpace(string(b))
}

func TestUploads(t *testing.T) {
	app := "journey12"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	serve := `["caddy", "file-server", "--root", "/srv", "--listen", ":80"]`
	os.MkdirAll(filepath.Join(dir, "public", "docs"), 0o755)
	os.MkdirAll(filepath.Join(dir, "deploy"), 0o755)
	write := func(rel, content string) { os.WriteFile(filepath.Join(dir, rel), []byte(content), 0o644) }
	write("public/index.html", "v1")
	write("public/docs/page.html", "page")
	write("public/key.secret", "do not upload")
	write("deploy/app.conf", "setting=1")
	uploadsProject(t, dir, app, serve)

	mustSucceed(t, dockflow(t, dir, "deploy"), "first deploy with uploads")
	waitServing(t, host)
	if code, body := get(t, host, "/"); code != 200 || body != "v1" {
		t.Fatalf("served %d %q", code, body)
	}
	if code, _ := get(t, host, "/key.secret"); code != 404 {
		t.Fatalf("an excluded file must not be uploaded, got %d", code)
	}
	if got, _ := inServer("cat /etc/dockflow-e2e/" + app + ".conf; echo; stat -c %a /etc/dockflow-e2e/" + app + ".conf"); got != "setting=1\n640" {
		t.Fatalf("the host file: %q", got)
	}

	// files only: the plan uploads, and no container changes
	write("public/index.html", "v2")
	os.RemoveAll(filepath.Join(dir, "public", "docs"))
	r := dockflow(t, dir, "deploy")
	mustSucceed(t, r, "deploy new files")
	for _, a := range planOf(t, r).Actions {
		if a.Kind != "upload.apply" {
			t.Fatalf("only uploads may change, got %s %s", a.Kind, a.Target)
		}
	}
	if _, body := get(t, host, "/"); body != "v2" {
		t.Fatalf("served %q, want v2", body)
	}
	if code, _ := get(t, host, "/docs/page.html"); code != 404 {
		t.Fatalf("mirror must delete removed files, got %d", code)
	}
	if again := dockflow(t, dir, "deploy"); !again.has("plan.empty") {
		t.Fatalf("unchanged files plan nothing:\n%s", again.out)
	}

	// a rollback puts the previous files back
	mustSucceed(t, dockflow(t, dir, "rollback"), "rollback")
	if _, body := get(t, host, "/"); body != "v1" {
		t.Fatalf("served %q after the rollback, want v1", body)
	}
	if code, body := get(t, host, "/docs/page.html"); code != 200 || body != "page" {
		t.Fatalf("the rollback must restore deleted files, got %d %q", code, body)
	}

	// a failed deploy restores the files it changed
	write("public/index.html", "v3")
	uploadsProject(t, dir, app, `["sh", "-c", "exit 1"]`)
	failed := dockflow(t, dir, "deploy")
	if failed.code != 8 {
		t.Fatalf("a failing service must roll back (exit 8), got %d:\n%s", failed.code, failed.out)
	}
	if _, body := get(t, host, "/"); body != "v1" {
		t.Fatalf("served %q after a failed deploy, want v1", body)
	}
}
