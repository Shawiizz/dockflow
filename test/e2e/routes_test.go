//go:build e2e

package e2e

import (
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// optionsApp is the whoami app with one route carrying options; caddy is its raw directives.
func optionsApp(app, caddy string) string {
	return fmt.Sprintf(`services:
  web:
    image: whoami-e2e:v1
    x-dockflow:
      routes:
        - domains: ["%s.test"]
          port: 80
          tls: false
          headers: { X-Frame-Options: DENY, -Server: "" }
          max_body: 1k
          timeouts: { read: 30s, dial: 5s }
          auth: { user: admin, password: "${PANEL_PASSWORD}" }
          caddy: |
%s
      rollout:
        drain: 1s
      health:
        grace: 1s
`, app, indent(caddy, "            "))
}

func indent(s, prefix string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := range lines {
		lines[i] = prefix + lines[i]
	}
	return strings.Join(lines, "\n")
}

func TestRouteOptions(t *testing.T) {
	app := "journey35"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	secret := []string{"PRODUCTION_PANEL_PASSWORD=s3cret-panel"}

	// raw directives that do not parse are refused before anything changes
	writeProject(t, dir, app, optionsApp(app, "respond /raw {"))
	r := dockflowEnv(t, dir, secret, "deploy")
	if r.code == 0 || !strings.Contains(r.out, "plan.caddy") || r.has("release.created") {
		t.Fatalf("broken caddy directives must fail at plan time with plan.caddy, got %d:\n%s", r.code, r.out)
	}

	writeProject(t, dir, app, optionsApp(app, `respond /raw "raw ok" 200
reverse_proxy /via-upstream {upstream}:80`))
	mustSucceed(t, dockflowEnv(t, dir, secret, "deploy"), "deploy with route options")
	defer dockflowEnv(t, dir, secret, "destroy", "production")

	do := func(method, path, user, pass string, body string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest(method, "http://"+serverIP+path, strings.NewReader(body))
		req.Host = host
		if user != "" {
			req.SetBasicAuth(user, pass)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}
	if resp, _ := do("GET", "/", "", "", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("without credentials: %d, want 401", resp.StatusCode)
	}
	if resp, _ := do("GET", "/", "admin", "wrong", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("with a wrong password: %d, want 401", resp.StatusCode)
	}
	resp, body := do("GET", "/", "admin", "s3cret-panel", "")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, "Hostname:") {
		t.Fatalf("with the password: %d\n%s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Frame-Options") != "DENY" || resp.Header.Get("Server") != "" {
		t.Fatalf("headers set and removed: %v", resp.Header)
	}
	if resp, _ := do("POST", "/", "admin", "s3cret-panel", strings.Repeat("x", 4096)); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("a body over max_body: %d, want 413", resp.StatusCode)
	}
	if resp, body := do("GET", "/raw", "admin", "s3cret-panel", ""); resp.StatusCode != 200 || body != "raw ok" {
		t.Fatalf("raw directives: %d %q", resp.StatusCode, body)
	}
	if resp, body := do("GET", "/via-upstream", "admin", "s3cret-panel", ""); resp.StatusCode != 200 || !strings.Contains(body, "GET /via-upstream") {
		t.Fatalf("{upstream} in raw directives: %d %q", resp.StatusCode, body)
	}

	// a new version moves traffic: the password keeps its hash and the directives their
	// handlers, so the switch's configuration does not change and nothing is reloaded
	before, _ := inServer("docker exec dockflow-switch cat /run/dockflow-switch/config.sha256")
	writeProject(t, dir, app, strings.Replace(optionsApp(app, `respond /raw "raw ok" 200
reverse_proxy /via-upstream {upstream}:80`), "whoami-e2e:v1", "whoami-e2e:v2", 1))
	r = dockflowEnv(t, dir, secret, "deploy")
	mustSucceed(t, r, "deploy v2")
	if !r.has("switch.changed") {
		t.Fatalf("v2 must move traffic:\n%s", r.out)
	}
	if after, _ := inServer("docker exec dockflow-switch cat /run/dockflow-switch/config.sha256"); after != before {
		t.Fatalf("the switch's configuration must not change: %s then %s", before, after)
	}

	// a route another app holds is refused before anything changes
	other := filepath.Join(workDir, "journey35b")
	writeProject(t, other, "journey35b", strings.Replace(webApp("journey35b", "whoami-e2e:v1", ""), "journey35b.test", host, 1))
	r = dockflow(t, other, "deploy")
	if r.code == 0 || !strings.Contains(r.out, "plan.domain_conflict") || r.has("release.created") {
		t.Fatalf("a domain another app routes must fail at plan time, got %d:\n%s", r.code, r.out)
	}
	// at another path, written in capitals with a trailing dot: the domain is still the other app's
	sneaky := strings.Replace(webApp("journey35b", "whoami-e2e:v1", ""), `["journey35b.test"]`, `["`+strings.ToUpper(host)+`."]`+"\n          path: /login/", 1)
	writeProject(t, other, "journey35b", sneaky)
	r = dockflow(t, other, "deploy")
	if r.code == 0 || !strings.Contains(r.out, "plan.domain_conflict") || r.has("release.created") {
		t.Fatalf("a path of a domain another app routes must fail at plan time, got %d:\n%s", r.code, r.out)
	}
}
