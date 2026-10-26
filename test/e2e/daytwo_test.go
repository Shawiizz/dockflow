//go:build e2e

package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDayTwoCommands(t *testing.T) {
	app := "journey10"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy")
	waitServing(t, host)

	// ps
	ps := dockflow(t, dir, "ps", "production")
	mustSucceed(t, ps, "ps")
	var rows []struct {
		Service, State string
	}
	json.Unmarshal([]byte(ps.out), &rows)
	if n := count(rows, func(r struct{ Service, State string }) bool { return r.Service == "web" && r.State == "running" }); n != 2 {
		t.Fatalf("ps shows %d running web containers, want 2:\n%s", n, ps.out)
	}

	// logs, as JSON lines
	logs := dockflow(t, dir, "logs", "production", "web", "-n", "all")
	mustSucceed(t, logs, "logs")
	if !strings.Contains(logs.out, `"service":"web"`) {
		t.Fatalf("logs:\n%s", logs.out)
	}

	// exec passes the exit code through
	ex := dockflow(t, dir, "exec", "production", "worker", "-T", "--", "sh", "-c", "echo from-exec; exit 3")
	if ex.code != 3 || !strings.Contains(ex.out, "from-exec") {
		t.Fatalf("exec: exit %d\n%s", ex.code, ex.out)
	}

	// run: a one-off container, removed afterwards
	run := dockflow(t, dir, "run", "production", "worker", "--", "sh", "-c", "echo from-run")
	mustSucceed(t, run, "run")
	if !strings.Contains(run.out, "from-run") {
		t.Fatalf("run:\n%s", run.out)
	}
	if left, _ := inServer("docker ps -aq --filter label=dockflow.kind=oneoff"); strings.TrimSpace(left) != "" {
		t.Fatalf("the one-off container must be removed")
	}

	// cp, both ways
	src := filepath.Join(workDir, "cp-src.txt")
	os.WriteFile(src, []byte("copied\n"), 0o644)
	mustSucceed(t, dockflow(t, dir, "cp", "production", src, "worker:/tmp/copied.txt"), "cp to")
	back := filepath.Join(workDir, "cp-back.txt")
	mustSucceed(t, dockflow(t, dir, "cp", "production", "worker:/tmp/copied.txt", back), "cp from")
	if b, _ := os.ReadFile(back); string(b) != "copied\n" {
		t.Fatalf("copied back %q", b)
	}

	// ssh runs a command on the server
	sshr := dockflow(t, dir, "ssh", "production", "--", "echo", "from-ssh")
	if sshr.code != 0 || !strings.Contains(sshr.out, "from-ssh") {
		t.Fatalf("ssh: exit %d\n%s", sshr.code, sshr.out)
	}

	// restart under load: no failed request
	l := startLoad(t, host, 4)
	mustSucceed(t, dockflow(t, dir, "restart", "production", "web"), "restart")
	l.stop(t)

	// scale and stop
	mustSucceed(t, dockflow(t, dir, "scale", "production", "web", "3"), "scale")
	if n := running(t, dir, "web"); n != 3 {
		t.Fatalf("after scale, web runs %d containers", n)
	}
	mustSucceed(t, dockflow(t, dir, "stop", "production", "worker"), "stop")
	if n := running(t, dir, "worker"); n != 0 {
		t.Fatalf("after stop, worker runs %d containers", n)
	}
	redeploy := dockflow(t, dir, "deploy")
	mustSucceed(t, redeploy, "deploy after stop and scale")
	if n := running(t, dir, "worker"); n != 1 {
		t.Fatalf("a deploy brings the stopped worker back, got %d", n)
	}
	if n := running(t, dir, "web"); n != 2 {
		t.Fatalf("a deploy restores Compose's replicas, got %d", n)
	}

	// details, diagnose, releases --stats
	det := dockflow(t, dir, "details", "production")
	mustSucceed(t, det, "details")
	if !strings.Contains(det.out, `"desired"`) {
		t.Fatalf("details:\n%s", det.out)
	}
	diag := dockflow(t, dir, "diagnose", "production")
	if diag.code != 0 {
		t.Fatalf("diagnose found problems on a healthy app: exit %d\n%s", diag.code, diag.out)
	}
	rels := dockflow(t, dir, "releases", "production", "--stats")
	mustSucceed(t, rels, "releases --stats")
	var st struct {
		Stats struct {
			Releases  int `json:"releases"`
			Succeeded int `json:"succeeded"`
		} `json:"stats"`
	}
	json.Unmarshal([]byte(rels.out), &st)
	if st.Stats.Releases != 5 || st.Stats.Succeeded != 5 {
		t.Fatalf("releases --stats: %+v\n%s", st.Stats, rels.out)
	}

	// cancel a deploy in progress: the agent rolls back
	writeProject(t, dir, app, strings.Replace(webApp(app, "whoami-e2e:v2", ""), "grace: 2s", "grace: 20s", 1))
	cmd := dockflowCmd(dir, "deploy")
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.Start()
	deadline := time.Now().Add(60 * time.Second)
	for {
		names, _ := inServer("docker ps --format '{{.Names}}'")
		if strings.Contains(names, app+"-production-web-6-") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the deploy never started:\n%s", out.String())
		}
		time.Sleep(200 * time.Millisecond)
	}
	mustSucceed(t, dockflow(t, dir, "cancel", "production"), "cancel")
	err := cmd.Wait()
	cancelled := parse(cmd, out.String(), err)
	if cancelled.code != 130 {
		t.Fatalf("the cancelled deploy must exit 130, got %d:\n%s", cancelled.code, cancelled.out)
	}

	// destroy one service, then everything
	mustSucceed(t, dockflow(t, dir, "destroy", "production", "--only", "worker"), "destroy --only")
	if n := running(t, dir, "worker"); n != 0 {
		t.Fatalf("worker must be gone")
	}
	mustSucceed(t, dockflow(t, dir, "destroy", "production", "--volumes"), "destroy")
	if left, _ := inServer("docker ps -aq --filter label=com.docker.compose.project=" + app + "-production --filter label=dockflow.kind=service"); strings.TrimSpace(left) != "" {
		t.Fatalf("destroy must remove every container")
	}
	if st := dockflow(t, dir, "status", "production"); !strings.Contains(st.out, `"services": []`) {
		t.Fatalf("a destroyed environment has no service:\n%s", st.out)
	}
	mustSucceed(t, dockflow(t, dir, "prune", "production"), "prune")
}

func count[T any](list []T, ok func(T) bool) int {
	n := 0
	for _, x := range list {
		if ok(x) {
			n++
		}
	}
	return n
}

// running is how many containers of service run, according to status.
func running(t *testing.T, dir, service string) int {
	t.Helper()
	r := dockflow(t, dir, "status", "production")
	var st struct {
		Services []struct {
			Name    string `json:"name"`
			Running int    `json:"running"`
		} `json:"services"`
	}
	if err := json.Unmarshal([]byte(r.out), &st); err != nil {
		t.Fatalf("status: %v\n%s", err, r.out)
	}
	for _, s := range st.Services {
		if s.Name == service {
			return s.Running
		}
	}
	return 0
}

// A manual lock is its holder's: someone else releases it only with --force.
func TestManualLockBelongsToItsHolder(t *testing.T) {
	app := "journey25"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	alice := []string{"GITHUB_ACTIONS=true", "GITHUB_ACTOR=alice"}
	mustSucceed(t, dockflowEnv(t, dir, alice, "lock", "acquire", "production", "-m", "maintenance"), "lock acquire")
	if r := dockflow(t, dir, "deploy"); r.code != 5 {
		t.Fatalf("a manual lock must refuse a deploy with exit code 5, got %d:\n%s", r.code, r.out)
	}
	if r := dockflow(t, dir, "lock", "release", "production"); r.code != 5 || !strings.Contains(r.out, "alice") {
		t.Fatalf("releasing alice's lock without --force must be refused, got %d:\n%s\n%+v", r.code, r.out, r.events)
	}
	mustSucceed(t, dockflow(t, dir, "lock", "release", "production", "--force"), "lock release --force")
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy after the release")
}
