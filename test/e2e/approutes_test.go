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

func TestAppRoutes(t *testing.T) {
	app := "journey36"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	if _, err := inServer(`mkdir -p /srv/e2e-maint /srv/e2e-files && echo "under maintenance" > /srv/e2e-maint/index.html && echo hello > /srv/e2e-files/hello.txt`); err != nil {
		t.Fatal(err)
	}
	writeProject(t, dir, app, fmt.Sprintf(`services:
  web:
    image: whoami-e2e:v1
    x-dockflow:
      routes:
        - domains: ["%[1]s"]
          port: 80
          tls: false
          error_pages:
            "502,503": { route: maintenance }
      health:
        grace: 1s
  api:
    image: whoami-e2e:v1
    networks:
      default: {}
      e2e-routes: { aliases: [e2e-api] }
    x-dockflow:
      health:
        grace: 1s
networks:
  e2e-routes: { external: true }
`, host))
	writeFile(t, filepath.Join(dir, "dockflow.yml"), fmt.Sprintf(`version: 1
app: %[1]s
routes:
  - name: maintenance
    domains: ["%[2]s"]
    path: /maintenance
    tls: false
    files: { host_path: /srv/e2e-maint }
  - domains: ["%[2]s"]
    path: /files
    tls: false
    files: { host_path: /srv/e2e-files, browse: true }
  - domains: ["%[2]s"]
    path: /old
    tls: false
    redirect: "https://example.com/new{uri}"
    status: 301
  - domains: ["%[2]s"]
    path: /api
    tls: false
    strip_prefix: true
    proxy: http://e2e-api:80
    network: e2e-routes
  - domains: ["%[2]s"]
    path: /broken
    tls: false
    proxy: http://e2e-missing:80
    network: e2e-routes
    error_pages:
      "502": { body: "<h1>broken upstream</h1>" }
environments:
  production:
    deploy:
      timeout: 60s
`, app, host))
	mustSucceed(t, dockflow(t, dir, "server", "network", "create", "e2e-routes"), "server network create")
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy with app routes")
	t.Cleanup(func() {
		dockflow(t, dir, "destroy", "production")
		dockflow(t, dir, "server", "network", "remove", "e2e-routes")
	})

	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(path string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, "http://"+serverIP+path, nil)
		req.Host = host
		resp, err := noRedirect.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}
	if resp, body := get("/files/hello.txt"); resp.StatusCode != 200 || strings.TrimSpace(body) != "hello" {
		t.Fatalf("files route: %d %q", resp.StatusCode, body)
	}
	if resp, _ := get("/old/page?x=1"); resp.StatusCode != 301 || resp.Header.Get("Location") != "https://example.com/new/old/page?x=1" {
		t.Fatalf("redirect: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	if resp, body := get("/api/hello"); resp.StatusCode != 200 || !strings.Contains(body, "GET /hello") || !strings.Contains(body, "Host: e2e-api:80") {
		t.Fatalf("proxy route through the shared network: %d\n%s", resp.StatusCode, body)
	}
	if resp, body := get("/broken/"); resp.StatusCode != 502 || !strings.Contains(body, "broken upstream") {
		t.Fatalf("error page with a body: %d %q", resp.StatusCode, body)
	}
	if resp, body := get("/"); resp.StatusCode != 200 || !strings.Contains(body, "Hostname:") {
		t.Fatalf("the service: %d %q", resp.StatusCode, body)
	}
	// the service's containers stop: the maintenance route answers for them
	if _, err := inServer("docker stop $(docker ps -q --filter label=com.docker.compose.project=" + app + "-production --filter label=com.docker.compose.service=web)"); err != nil {
		t.Fatal(err)
	}
	if resp, body := get("/"); !strings.Contains(body, "under maintenance") {
		t.Fatalf("error page from a route: %d %q", resp.StatusCode, body)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
