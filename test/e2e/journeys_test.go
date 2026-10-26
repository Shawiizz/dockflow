//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// webApp is a routed web service with two replicas and a worker.
func webApp(app, image string, extra string) string {
	return fmt.Sprintf(`services:
  web:
    image: %s
    deploy:
      replicas: 2
    x-dockflow:
      routes:
        - domains: ["%s.test"]
          port: 80
          tls: false
      rollout:
        drain: 2s
      health:
        grace: 2s
%s  worker:
    image: %s
    command: ["sleep", "infinity"]
    init: true
    x-dockflow:
      health:
        grace: 1s
`, image, app, extra, alpineImage)
}

type planData struct {
	Actions []struct {
		Kind   string `json:"kind"`
		Target string `json:"target"`
	} `json:"actions"`
}

func planOf(t *testing.T, r result) planData {
	t.Helper()
	e := r.find("plan.computed")
	if e == nil {
		t.Fatalf("no plan.computed event:\n%s", r.out)
	}
	var p planData
	json.Unmarshal(e.Data, &p)
	return p
}

func TestDeployTwiceThenChangeOneImage(t *testing.T) {
	app := "journey1"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))

	mustSucceed(t, dockflow(t, dir, "deploy"), "first deploy")
	waitServing(t, app+".test")

	again := dockflow(t, dir, "deploy")
	mustSucceed(t, again, "second deploy")
	if !again.has("plan.empty") || again.has("release.created") {
		t.Fatalf("the second deploy must change nothing:\n%s", again.out)
	}

	writeProject(t, dir, app, webApp(app, "whoami-e2e:v2", ""))
	changed := dockflow(t, dir, "deploy")
	mustSucceed(t, changed, "deploy with a new image")
	p := planOf(t, changed)
	var touched []string
	for _, a := range p.Actions {
		if strings.HasPrefix(a.Kind, "service.") {
			touched = append(touched, a.Kind+" "+a.Target)
		}
	}
	if len(touched) != 1 || touched[0] != "service.update web" {
		t.Fatalf("only web must be updated, got %v", touched)
	}

	st := dockflow(t, dir, "status", "production")
	mustSucceed(t, st, "status")
	var status struct {
		Current struct {
			Seq int `json:"seq"`
		} `json:"current"`
		Services []struct {
			Name    string `json:"name"`
			Running int    `json:"running"`
			Release int    `json:"release"`
		} `json:"services"`
	}
	if err := json.Unmarshal([]byte(st.out), &status); err != nil {
		t.Fatalf("status is not one JSON document: %v\n%s", err, st.out)
	}
	if status.Current.Seq != 2 {
		t.Fatalf("current release %d, want 2", status.Current.Seq)
	}
	for _, s := range status.Services {
		want := map[string]int{"web": 2, "worker": 1}[s.Name]
		if s.Running != want {
			t.Fatalf("%s runs %d containers, want %d", s.Name, s.Running, want)
		}
		if s.Name == "worker" && s.Release != 1 {
			t.Fatalf("worker must keep its release 1 containers, has %d", s.Release)
		}
	}
}

func TestZeroDowntimeDeployRollbackAndFailure(t *testing.T) {
	app := "journey2"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	mustSucceed(t, dockflow(t, dir, "deploy"), "first deploy")
	waitServing(t, host)

	l := startLoad(t, host, 8)
	time.Sleep(500 * time.Millisecond)

	writeProject(t, dir, app, webApp(app, "whoami-e2e:v2", ""))
	r := dockflow(t, dir, "deploy")
	mustSucceed(t, r, "deploy under load")
	if !r.has("switch.changed") || !r.has("drain.started") {
		t.Fatalf("web must switch and drain:\n%s", r.out)
	}

	mustSucceed(t, dockflow(t, dir, "rollback"), "rollback under load")

	// a deploy whose containers exit is rolled back, and nobody notices
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v2", "    command: [\"--port\", \"not-a-port\"]\n"))
	failed := dockflow(t, dir, "deploy")
	if failed.code != 8 {
		t.Fatalf("a failing deploy must exit 8 (rolled back), got %d:\n%s", failed.code, failed.out)
	}
	if !failed.has("rollback.started") || !failed.has("service.failed") {
		t.Fatalf("the failure and the rollback must be reported:\n%s", failed.out)
	}
	time.Sleep(500 * time.Millisecond)
	l.stop(t)

	rels := dockflow(t, dir, "releases")
	mustSucceed(t, rels, "releases")
	var list struct {
		State struct {
			Current int `json:"current"`
		} `json:"state"`
		Releases []struct {
			Seq        int    `json:"seq"`
			Status     string `json:"status"`
			RollbackOf int    `json:"rollback_of"`
		} `json:"releases"`
	}
	json.Unmarshal([]byte(rels.out), &list)
	got := map[int]string{}
	for _, r := range list.Releases {
		got[r.Seq] = r.Status
	}
	want := map[int]string{1: "superseded", 2: "superseded", 3: "active", 4: "rolled-back"}
	for seq, st := range want {
		if got[seq] != st {
			t.Fatalf("release %d is %q, want %q (all: %v)", seq, got[seq], st, got)
		}
	}
	if list.State.Current != 3 {
		t.Fatalf("current is %d, want 3 (the rollback to release 1)", list.State.Current)
	}
}

func TestConcurrentDeploysOneIsLocked(t *testing.T) {
	app := "journey3"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	mustSucceed(t, dockflow(t, dir, "deploy"), "first deploy")

	writeProject(t, dir, app, webApp(app, "whoami-e2e:v2", ""))
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() { results <- dockflow(t, dir, "deploy") }()
	}
	a, b := <-results, <-results
	codes := []int{a.code, b.code}
	if (a.code != 0 || b.code != 5) && (a.code != 5 || b.code != 0) {
		t.Fatalf("want one success and one exit 5, got %v:\n--- A\n%s\n--- B\n%s", codes, a.out, b.out)
	}
}

func TestKilledAgentKeepsServingAndNextRunConverges(t *testing.T) {
	app := "journey4"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	mustSucceed(t, dockflow(t, dir, "deploy"), "first deploy")
	waitServing(t, host)
	l := startLoad(t, host, 4)

	writeProject(t, dir, app, webApp(app, "whoami-e2e:v2", ""))
	cmd := dockflowCmd(dir, "deploy")
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	// kill the agent once it has started release 2's containers
	deadline := time.Now().Add(60 * time.Second)
	for {
		names, _ := inServer("docker ps --format '{{.Names}}'")
		if strings.Contains(names, app+"-production-web-2-") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("release 2 never started:\n%s", out.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, err := inServer("docker kill $(docker ps -q --filter label=dockflow.kind=run --filter label=com.docker.compose.project=" + app + "-production)"); err != nil {
		t.Fatal(err)
	}
	err := cmd.Wait()
	killed := parse(cmd, out.String(), err)
	if killed.code == 0 {
		t.Fatalf("the killed run must fail:\n%s", killed.out)
	}
	time.Sleep(time.Second)

	next := dockflow(t, dir, "deploy")
	mustSucceed(t, next, "the next deploy")
	l.stop(t)

	abandoned := false
	for _, e := range next.events {
		if e.Type == "warning" && strings.Contains(e.Msg, "abandoned") {
			abandoned = true
		}
	}
	if !abandoned {
		t.Fatalf("the next run must report the abandoned release:\n%s", next.out)
	}
	names, _ := inServer("docker ps -a --format '{{.Names}}' --filter label=com.docker.compose.project=" + app + "-production --filter label=dockflow.kind=service")
	for _, n := range strings.Fields(names) {
		if strings.Contains(n, "-web-2-") {
			t.Fatalf("the abandoned release's container %s must be gone (all: %s)", n, names)
		}
	}
	if !strings.Contains(names, "-web-3-") {
		t.Fatalf("release 3 must serve web: %s", names)
	}
}
