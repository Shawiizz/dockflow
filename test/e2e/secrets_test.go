//go:build e2e

package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"
)

func secretsApp(app string) string {
	return fmt.Sprintf(`services:
  worker:
    image: %s
    command: ["sleep", "infinity"]
    init: true
    secrets:
      - token
      - source: token
        target: /etc/app/token
        uid: "1000"
        mode: 0400
    configs:
      - source: settings
        target: /etc/app/settings.ini
secrets:
  token:
    environment: TOKEN
configs:
  settings:
    content: |
      [app]
      name = %s
`, alpineImage, app)
}

// Compose secrets reach the container as files on the server's tmpfs, never in its
// environment or the output; a new value redeploys the service that mounts it.
func TestComposeSecretsAndConfigs(t *testing.T) {
	app := "journey26"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, secretsApp(app))
	env := func(v string) []string { return []string{"PRODUCTION_TOKEN=" + v} }

	first := dockflowEnv(t, dir, env("first-s3cret-value"), "deploy")
	mustSucceed(t, first, "deploy with a secret")
	if strings.Contains(first.out, "first-s3cret-value") {
		t.Fatalf("the secret's value must be masked in the output:\n%s", first.out)
	}
	read := func(path string) string {
		r := dockflowEnv(t, dir, env("first-s3cret-value"), "exec", "production", "worker", "-T", "--", "cat", path)
		mustSucceed(t, r, "cat "+path)
		return r.out
	}
	if got := read("/run/secrets/token"); !strings.Contains(got, "first-s3cret-value") {
		t.Fatalf("the secret must be at /run/secrets/token: %q", got)
	}
	if got := read("/etc/app/settings.ini"); !strings.Contains(got, "name = "+app) {
		t.Fatalf("the config must be at its target: %q", got)
	}
	inspect, _ := inServer("docker inspect " + app + "-production-worker-1-1")
	if strings.Contains(inspect, "first-s3cret-value") {
		t.Fatal("the secret must not be in the container's configuration")
	}
	files, _ := inServer("ls -ln /run/dockflow/secrets/" + app + "-production/")
	modes := map[string]string{}
	for _, line := range strings.Split(files, "\n") {
		if f := strings.Fields(line); len(f) > 3 {
			modes[f[0]] = f[2] // mode → owner
		}
	}
	if modes["-r--------"] != "1000" || modes["-r--r--r--"] != "0" {
		t.Fatalf("each mount gets its own file, with its owner and mode:\n%s", files)
	}
	releases, _ := inServer("zcat /var/lib/dockflow/apps/" + app + "-production/releases/*.json.gz")
	if strings.Contains(releases, "first-s3cret-value") {
		t.Fatal("the release record must not hold the secret's value")
	}

	again := dockflowEnv(t, dir, env("first-s3cret-value"), "deploy")
	mustSucceed(t, again, "deploy the same value")
	if !again.has("plan.empty") {
		t.Fatalf("an unchanged secret must change nothing:\n%s", again.out)
	}

	rotated := dockflowEnv(t, dir, env("second-s3cret-value"), "deploy")
	mustSucceed(t, rotated, "deploy a new value")
	kinds := map[string]int{}
	for _, a := range planOf(t, rotated).Actions {
		kinds[a.Kind]++
	}
	if kinds["secret.create"] != 2 || kinds["service.update"] != 1 {
		t.Fatalf("a new value writes new files and updates the service: %v", kinds)
	}
	r := dockflowEnv(t, dir, env("second-s3cret-value"), "exec", "production", "worker", "-T", "--", "cat", "/run/secrets/token")
	if !strings.Contains(r.out, "second-s3cret-value") {
		t.Fatalf("the service must see the new value: %q", r.out)
	}

	mustSucceed(t, dockflowEnv(t, dir, env("second-s3cret-value"), "-y", "destroy", "production"), "destroy")
	if left, _ := inServer("ls /run/dockflow/secrets/ 2>&1"); strings.Contains(left, app) {
		t.Fatalf("destroy must remove the secret files: %s", left)
	}
}

// A SOPS file in the project holds the secrets: `secrets set` writes it, deploys read it with
// the age key, and `secrets revoke` removes a secret's old files from the server.
func TestSOPSFileAndRevoke(t *testing.T) {
	app := "journey28"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, secretsApp(app))
	key, _ := filepath.Abs("../../internal/sopsfile/testdata/test-key.txt")
	b, _ := os.ReadFile(key)
	ids, err := age.ParseIdentities(strings.NewReader(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	recipient := ids[0].(*age.X25519Identity).Recipient().String()
	withKey := []string{"SOPS_AGE_KEY_FILE=" + key}
	set := func(value string) {
		t.Helper()
		cmd := dockflowCmd(dir, "secrets", "set", "production", "TOKEN", "--age", recipient)
		cmd.Env = append(cmd.Env, withKey...)
		cmd.Stdin = strings.NewReader(value + "\n")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("secrets set: %v\n%s", err, out)
		}
	}
	set("sops-one")
	if enc, _ := os.ReadFile(filepath.Join(dir, "secrets", "production.sops.yaml")); strings.Contains(string(enc), "sops-one") {
		t.Fatal("the SOPS file must be encrypted")
	}
	list := dockflowEnv(t, dir, withKey, "secrets", "list", "production")
	if !strings.Contains(list.out, `"source":"secrets/production.sops.yaml"`) {
		t.Fatalf("secrets list must name the SOPS file:\n%s", list.out)
	}
	read := func() string {
		r := dockflowEnv(t, dir, withKey, "exec", "production", "worker", "-T", "--", "cat", "/run/secrets/token")
		return r.out
	}
	mustSucceed(t, dockflowEnv(t, dir, withKey, "deploy"), "deploy from the SOPS file")
	if got := read(); !strings.Contains(got, "sops-one") {
		t.Fatalf("the value of the SOPS file must reach the service: %q", got)
	}
	if r := dockflow(t, dir, "deploy"); r.code != 3 || !strings.Contains(r.out, "secrets.file") {
		t.Fatalf("without the age key, the deploy must fail with secrets.file, got %d:\n%s", r.code, r.out)
	}

	set("sops-two")
	mustSucceed(t, dockflowEnv(t, dir, withKey, "deploy"), "deploy a new value")
	if got := read(); !strings.Contains(got, "sops-two") {
		t.Fatalf("the new value must reach the service: %q", got)
	}
	count := func() int {
		out, _ := inServer("ls /run/dockflow/secrets/" + app + "-production/ | grep -c ^token-")
		n := 0
		fmt.Sscan(out, &n)
		return n
	}
	if n := count(); n != 4 {
		t.Fatalf("the previous release keeps its files: %d token files, want 4", n)
	}
	mustSucceed(t, dockflowEnv(t, dir, withKey, "secrets", "revoke", "production", "token"), "secrets revoke")
	if n := count(); n != 2 {
		t.Fatalf("revoke must leave only the current release's files: %d", n)
	}
	if r := dockflowEnv(t, dir, withKey, "rollback"); r.code == 0 || !strings.Contains(r.out, "secret.missing") {
		t.Fatalf("a rollback to a revoked value must fail with secret.missing, got %d:\n%s", r.code, r.out)
	}
}
