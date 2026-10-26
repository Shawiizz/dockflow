//go:build e2e

package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeHostTools stands in for the server's sudo, nginx and systemctl: nginx -t refuses a vhost
// that names broken.test, and systemctl logs its arguments.
const fakeHostTools = `mkdir -p /etc/nginx/sites-enabled
printf '#!/bin/sh\nexec "$@"\n' > /usr/local/bin/sudo
printf '#!/bin/sh\nif grep -q broken.test /etc/nginx/sites-enabled/*.conf; then echo "nginx: [emerg] broken" >&2; exit 1; fi\necho "nginx: the configuration file syntax is ok"\n' > /usr/local/bin/nginx
printf '#!/bin/sh\necho "$@" >> /tmp/systemctl.log\n' > /usr/local/bin/systemctl
chmod +x /usr/local/bin/sudo /usr/local/bin/nginx /usr/local/bin/systemctl
rm -f /tmp/systemctl.log`

func pluginsProject(t *testing.T, dir, app, domains, greeting string) {
	t.Helper()
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	cfg := fmt.Sprintf(`version: 1
app: %s
plugins:
  - use: nginx
    with:
      domain: [%s]
  - use: ./deploy/plugins/motd
    with: { greeting: "%s" }
environments:
  production:
    deploy:
      timeout: 60s
`, app, domains, greeting)
	files := map[string]string{
		"dockflow.yml": cfg,
		"deploy/plugins/motd/plugin.yml": `description: A message of the day
inputs:
  - name: greeting
    required: true
templates:
  - motd.txt
uploads:
  - src: motd.txt
    dest: "/srv/{{ DOCKFLOW_STACK }}/motd.txt"
hooks:
  after_deploy:
    - name: count
      host: echo changed >> /tmp/{{ DOCKFLOW_STACK }}-motd.log
      if_changed: "/srv/{{ DOCKFLOW_STACK }}/motd.txt"
`,
		"deploy/plugins/motd/motd.txt": "{{ greeting }} from {{ DOCKFLOW_ENV }}\n",
	}
	for name, content := range files {
		path := filepath.Join(dir, name)
		os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPlugins(t *testing.T) {
	if _, err := inServer(fakeHostTools); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		inServer("rm -f /usr/local/bin/sudo /usr/local/bin/nginx /usr/local/bin/systemctl /tmp/systemctl.log")
	})
	app := "journey30"
	stack := app + "-production"
	dir := filepath.Join(workDir, app)
	vhost := "/etc/nginx/sites-enabled/" + stack + ".conf"
	pluginsProject(t, dir, app, "shop.test", "hello")

	r := dockflow(t, dir, "deploy")
	mustSucceed(t, r, "deploy with plugins")
	if !strings.Contains(r.out, "plugin nginx") || !strings.Contains(r.out, "plugin motd") {
		t.Fatalf("the plan names the plugins of the uploads:\n%s", r.out)
	}
	if got, _ := inServer("cat " + vhost); !strings.Contains(got, "server_name shop.test;") || !strings.Contains(got, "proxy_pass http://127.0.0.1:8080;") {
		t.Fatalf("the vhost:\n%s", got)
	}
	if got, _ := inServer("cat /srv/" + stack + "/motd.txt"); got != "hello from production" {
		t.Fatalf("the plugin's template is rendered with its input: %q", got)
	}
	if got, _ := inServer("cat /tmp/systemctl.log"); got != "reload nginx" {
		t.Fatalf("nginx is reloaded once: %q", got)
	}

	// nothing changed: the hooks that wait for a change do not run
	r = dockflow(t, dir, "deploy", "--version", "again")
	mustSucceed(t, r, "deploy again")
	if got, _ := inServer("cat /tmp/systemctl.log"); got != "reload nginx" {
		t.Fatalf("an unchanged vhost is not reloaded: %q", got)
	}
	if got, _ := inServer("cat /tmp/" + stack + "-motd.log"); got != "changed" {
		t.Fatalf("an unchanged upload's hook does not run: %q", got)
	}

	// a vhost nginx -t refuses rolls the deploy back, and the rollback restores the vhost
	pluginsProject(t, dir, app, "shop.test, broken.test", "hello")
	r = dockflow(t, dir, "deploy", "--version", "broken")
	if r.code != 8 || !r.has("rollback.started") {
		t.Fatalf("a refused vhost must roll back (exit 8), got %d:\n%s", r.code, r.out)
	}
	if got, _ := inServer("cat " + vhost); strings.Contains(got, "broken.test") || !strings.Contains(got, "server_name shop.test;") {
		t.Fatalf("the rollback restores the vhost:\n%s", got)
	}

	r = dockflow(t, dir, "plugins", "list")
	mustSucceed(t, r, "plugins list")
	for _, want := range []string{`"name":"nginx"`, `"name":"systemd"`, `"name":"motd"`, `"source":"deploy/plugins/motd"`} {
		if !strings.Contains(r.out, want) {
			t.Fatalf("plugins list lacks %s:\n%s", want, r.out)
		}
	}
	mustSucceed(t, dockflow(t, dir, "destroy", "production"), "destroy")
}
