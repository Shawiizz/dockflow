//go:build e2e

package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hostTools stands in for the server's sudo, nginx and systemctl: nginx -t is a real nginx's,
// in a container, on the server's vhosts; systemctl and nginx -s log their reloads.
func hostTools() string {
	return `mkdir -p /etc/nginx/sites-enabled
printf '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n' > /usr/local/bin/sudo
printf '#!/bin/sh\nif [ "$1" = -s ]; then echo "nginx -s $2" >> /tmp/systemctl.log; exit 0; fi\n[ "$1" = -t ] || exit 1\nexec docker run --rm -v /etc/nginx/sites-enabled:/etc/nginx/conf.d:ro --entrypoint nginx ` + nginxImage + ` -t\n' > /usr/local/bin/nginx
printf '#!/bin/sh\necho "$@" >> /tmp/systemctl.log\n' > /usr/local/bin/systemctl
chmod +x /usr/local/bin/sudo /usr/local/bin/nginx /usr/local/bin/systemctl
rm -f /tmp/systemctl.log`
}

func pluginsProject(t *testing.T, dir, app, domains, greeting string, with ...string) {
	t.Helper()
	// nginx cannot listen on IPv6 where the kernel has none, as on some servers
	ipv6 := "true"
	if _, err := inServer("test -e /proc/net/if_inet6"); err != nil {
		ipv6 = "false"
	}
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	cfg := fmt.Sprintf(`version: 1
app: %s
plugins:
  - use: nginx
    with:
      domain: [%s]
      ipv6: %s%s
  - use: ./deploy/plugins/motd
    with: { greeting: "%s" }
environments:
  production:
    deploy:
      timeout: 60s
`, app, domains, ipv6, strings.Join(append([]string{""}, with...), "\n      "), greeting)
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
	if _, err := inServer(hostTools()); err != nil {
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

	// a server that allows nginx -s reload but not systemctl: nginx is reloaded with its signal
	inServer(`printf '#!/bin/sh\nexit 1\n' > /usr/local/bin/systemctl; rm -f /tmp/systemctl.log`)
	pluginsProject(t, dir, app, "shop.test, www.shop.test", "hello")
	mustSucceed(t, dockflow(t, dir, "deploy", "--version", "signal"), "deploy without systemctl")
	if got, _ := inServer("cat /tmp/systemctl.log"); got != "nginx -s reload" {
		t.Fatalf("nginx is reloaded with its signal: %q", got)
	}

	// a vhost nginx -t refuses rolls the deploy back, and the rollback restores the vhost
	// every input matches its pattern: an upstream nginx cannot resolve makes nginx -t fail
	pluginsProject(t, dir, app, "shop.test, www.shop.test", "hello", "upstream: broken.invalid:80")
	r = dockflow(t, dir, "deploy", "--version", "broken")
	if r.code != 8 || !r.has("rollback.started") {
		t.Fatalf("a refused vhost must roll back (exit 8), got %d:\n%s", r.code, r.out)
	}
	if !strings.Contains(r.out, "host not found") {
		t.Fatalf("the hook's output shows nginx's error:\n%s", r.out)
	}
	if got, _ := inServer("cat " + vhost); strings.Contains(got, "broken.invalid") || !strings.Contains(got, "server_name shop.test www.shop.test;") {
		t.Fatalf("the rollback restores the vhost:\n%s", got)
	}

	// a domain that would add a directive is refused before anything changes
	pluginsProject(t, dir, app, `"shop.test; include /etc/shadow"`, "hello")
	if r = dockflow(t, dir, "deploy", "--version", "injected"); r.code != 3 || !strings.Contains(r.out, "config.invalid") {
		t.Fatalf("a domain that is not a host name must be refused (exit 3), got %d:\n%s", r.code, r.out)
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
