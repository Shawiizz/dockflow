//go:build e2e

package e2e

import (
	"path/filepath"
	"strings"
	"testing"
)

// A Postgres app is backed up to S3-compatible storage, restored into staging from production,
// and a failing restore stops at the first error (M4's exit criterion).
func TestOffsiteBackup(t *testing.T) {
	app := "journey42"
	dir := filepath.Join(workDir, app)
	s3 := "dockflow-e2e-s3"
	if _, err := inServer("docker run -d --name " + s3 + " " + rcloneImage + " serve s3 --auth-key e2ekey,e2e-s3-secret --addr :9000 /data"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inServer("docker rm -f -v " + s3) })
	ip, err := inServer("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' " + s3)
	if err != nil || ip == "" {
		t.Fatalf("the storage's address: %q %v", ip, err)
	}

	writeProject(t, dir, app, `services:
  db:
    image: `+postgresImage+`
    environment: { POSTGRES_PASSWORD: pw, POSTGRES_DB: shop }
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD", "pg_isready", "-U", "postgres", "-d", "shop"], interval: 1s, retries: 60 }
    x-dockflow: { stateful: true, backup: { type: postgres } }
volumes: { pgdata: {} }
`)
	writeFile(t, filepath.Join(dir, "dockflow.yml"), `version: 1
app: `+app+`
backups:
  repository: s3:http://`+ip+`:9000/backups
  password: ${RESTIC_PASSWORD}
  env:
    AWS_ACCESS_KEY_ID: ${S3_KEY}
    AWS_SECRET_ACCESS_KEY: ${S3_SECRET}
environments:
  production:
    deploy: { timeout: 60s }
  staging:
    deploy: { timeout: 60s }
`)
	var secrets []string
	for _, env := range []string{"PRODUCTION", "STAGING"} {
		secrets = append(secrets, env+"_RESTIC_PASSWORD=e2e-repo-password", env+"_S3_KEY=e2ekey", env+"_S3_SECRET=e2e-s3-secret")
	}
	run := func(args ...string) result { return dockflowEnv(t, dir, secrets, args...) }
	mustSucceed(t, run("deploy", "production"), "deploy production")
	t.Cleanup(func() {
		run("destroy", "production", "--volumes")
		run("destroy", "staging", "--volumes")
	})
	psql := func(env, sql string) string {
		t.Helper()
		out, err := inServer("docker exec $(docker ps -q --filter label=com.docker.compose.project=" + app + "-" + env +
			" --filter label=com.docker.compose.service=db) psql -U postgres -d shop -tAc '" + sql + "'")
		if err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return out
	}
	psql("production", "create table t (x int); insert into t values (42)")

	passwords := "ls /var/lib/dockflow/backups/*.password 2>/dev/null; true"
	before, _ := inServer(passwords)
	r := run("backup", "run", "production")
	mustSucceed(t, r, "backup run to S3")
	if strings.Contains(r.out, "e2e-repo-password") || strings.Contains(r.out, "e2e-s3-secret") {
		t.Fatalf("a secret reached the output:\n%s", r.out)
	}
	// the snapshot is in the bucket, and no password was generated on the server
	if out, err := inServer("docker exec " + s3 + " ls /data/backups"); err != nil || !strings.Contains(out, "config") {
		t.Fatalf("the repository is in the bucket: %v\n%s", err, out)
	}
	if after, _ := inServer(passwords); after != before {
		t.Fatalf("the given password is not stored: %q, then %q", before, after)
	}
	if out, _ := inServer("ls /run/dockflow"); strings.Contains(out, "backup-") {
		t.Fatalf("restic's environment is removed after the run: %s", out)
	}

	mustSucceed(t, run("deploy", "staging"), "deploy staging")
	mustSucceed(t, run("--yes", "backup", "restore", "staging", "db", "--from", "production"), "restore staging from production's S3 snapshot")
	if got := psql("staging", "select max(x) from t"); got != "42" {
		t.Fatalf("staging has production's data: %q", got)
	}
	// a restore that fails stops at the first error, and says so
	if _, err := inServer("docker exec $(docker ps -q --filter label=com.docker.compose.project=" + app +
		"-staging --filter label=com.docker.compose.service=db) psql -U postgres -c 'drop database shop'"); err != nil {
		t.Fatal(err)
	}
	r = run("--yes", "backup", "restore", "staging", "db", "--from", "production")
	if r.code != 12 || !strings.Contains(r.out, "pg_restore exited with code") {
		t.Fatalf("a failed restore: exit %d\n%s", r.code, r.out)
	}
}
