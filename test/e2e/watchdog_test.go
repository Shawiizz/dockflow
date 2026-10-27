//go:build e2e

package e2e

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// waitFor runs check on the server until it prints want, or fails after timeout.
func waitFor(t *testing.T, what, check, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var got string
	for time.Now().Before(deadline) {
		got, _ = inServer(check)
		if got == want {
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatalf("%s: got %q, want %q", what, got, want)
}

func TestWatchdog(t *testing.T) {
	if got, _ := inServer("docker inspect -f '{{.State.Status}}' dockflow-watchdog"); got != "running" {
		t.Fatalf("server init installs the watchdog: %q", got)
	}
	app := "journey31"
	stack := app + "-production"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, fmt.Sprintf(`services:
  app:
    image: %s
    command: ["sh", "-c", "touch /tmp/ok && exec sleep 3600"]
    init: true
    healthcheck:
      test: ["CMD", "test", "-f", "/tmp/ok"]
      interval: 1s
      retries: 1
    secrets: [token]
    x-dockflow:
      health:
        grace: 1s
        restart_after: 5s
secrets:
  token:
    environment: TOKEN
`, alpineImage))
	secret := []string{"PRODUCTION_TOKEN=w4tchdog-token"}
	mustSucceed(t, dockflowEnv(t, dir, secret, "deploy"), "deploy")
	container := "$(docker ps -aq --filter label=com.docker.compose.project=" + stack + " --filter label=com.docker.compose.service=app)"

	// the secret has a copy, root's only, in the state directory
	if got, _ := inServer("stat -c %a /var/lib/dockflow/apps/" + stack + "/secrets/token-* && cat /var/lib/dockflow/apps/" + stack + "/secrets/token-*"); got != "600\nw4tchdog-token" {
		t.Fatalf("the secret's copy: %q", got)
	}

	// a container that stays unhealthy is restarted, and healthy again
	started, _ := inServer("docker inspect -f '{{.State.StartedAt}}' " + container)
	if _, err := inServer("docker exec " + container + " rm /tmp/ok"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the unhealthy container is restarted",
		"[ \"$(docker inspect -f '{{.State.StartedAt}}' "+container+")\" != '"+started+"' ] && docker inspect -f '{{.State.Health.Status}}' "+container,
		"healthy", 60*time.Second)

	// a reboot: the tmpfs is emptied, and the container cannot start without its secret
	script := `docker stop dockflow-watchdog >/dev/null
rm -rf /run/dockflow/secrets/` + stack + `
docker stop ` + container + ` >/dev/null
docker start ` + container + ` >/dev/null 2>&1 && echo started
docker inspect -f '{{.State.Status}}' ` + container
	if got, _ := inServer(script); got == "running" || strings.Contains(got, "started") {
		t.Fatalf("the container must not start without its secret file: %q", got)
	}
	if _, err := inServer("docker start dockflow-watchdog"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the watchdog writes the secret again and starts the container",
		"docker inspect -f '{{.State.Status}}' "+container+" && docker exec "+container+" cat /run/secrets/token",
		"running\nw4tchdog-token", 60*time.Second)

	r := dockflowEnv(t, dir, secret, "status")
	mustSucceed(t, r, "status")
	compact := strings.Join(strings.Fields(r.out), "")
	if !strings.Contains(compact, `"reason":"unhealthy"`) || !strings.Contains(compact, `"reason":"boot"`) {
		t.Fatalf("status shows the watchdog's restarts:\n%s", r.out)
	}
	mustSucceed(t, dockflowEnv(t, dir, secret, "destroy", "production"), "destroy")
	if got, _ := inServer("ls /var/lib/dockflow/apps/" + stack + "/secrets 2>&1 | wc -l"); got != "1" {
		t.Fatalf("destroy removes the secrets' copies: %q", got)
	}
}
