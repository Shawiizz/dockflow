//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// backupApp is a Postgres database and a volume, both backed up.
func backupApp() string {
	return fmt.Sprintf(`services:
  db:
    image: %s
    environment: { POSTGRES_PASSWORD: pw, POSTGRES_DB: shop }
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD", "pg_isready", "-U", "postgres", "-d", "shop"], interval: 1s, retries: 60 }
    x-dockflow:
      stateful: true
      backup: { type: postgres }
  files:
    image: %s
    command: ["sh", "-c", "[ -e /data/hello.txt ] || echo hello > /data/hello.txt; exec sleep 3600"]
    init: true
    volumes: [files:/data]
    x-dockflow:
      stateful: true
      health: { grace: 1s }
      backup:
        type: volume
        quiesce: { exec: { pre: ["sh", "-c", "echo pre >> /data/quiesce.log"], post: ["sh", "-c", "echo post >> /data/quiesce.log"] } }
        keep: { last: 1 }
volumes:
  pgdata: {}
  files: {}
`, postgresImage, alpineImage)
}

type snapshotRow struct {
	ID      string `json:"id"`
	Service string `json:"service"`
	Release int    `json:"release"`
}

func backupList(t *testing.T, dir string, args ...string) []snapshotRow {
	t.Helper()
	r := dockflow(t, dir, append([]string{"backup", "list"}, args...)...)
	mustSucceed(t, r, "backup list")
	var out struct {
		Snapshots []snapshotRow `json:"snapshots"`
	}
	if err := json.Unmarshal([]byte(r.out), &out); err != nil {
		t.Fatalf("backup list: %v\n%s", err, r.out)
	}
	return out.Snapshots
}

func TestBackups(t *testing.T) {
	app := "journey39"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, backupApp())
	writeFile(t, filepath.Join(dir, "dockflow.yml"), "version: 1\napp: "+app+"\nenvironments:\n  production:\n    deploy: { timeout: 60s }\n  staging:\n    deploy: { timeout: 60s }\n")
	mustSucceed(t, dockflow(t, dir, "deploy", "production"), "deploy")
	t.Cleanup(func() {
		dockflow(t, dir, "destroy", "production", "--volumes")
		dockflow(t, dir, "destroy", "staging", "--volumes")
	})
	container := func(env, service string) string {
		return "$(docker ps -q --filter label=com.docker.compose.project=" + app + "-" + env + " --filter label=com.docker.compose.service=" + service + ")"
	}
	db, files := container("production", "db"), container("production", "files")
	psql := func(c, sql string) string {
		t.Helper()
		out, err := inServer("docker exec " + c + " psql -U postgres -d shop -tAc '" + sql + "'")
		if err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return out
	}
	psql(db, "create table t (x int); insert into t values (42)")

	if got := backupList(t, dir, "production"); len(got) != 0 {
		t.Fatalf("no snapshot before the first backup: %+v", got)
	}
	r := dockflow(t, dir, "backup", "run", "production")
	mustSucceed(t, r, "backup run")
	if n := strings.Count(r.out, `"type":"backup.finished"`); n != 2 {
		t.Fatalf("two services backed up, got %d:\n%s", n, r.out)
	}
	// the generated password is root's only, and never shown
	if got, _ := inServer("stat -c %a /var/lib/dockflow/backups/local.password"); got != "600" {
		t.Fatalf("the repository's password: %q", got)
	}
	pw, _ := inServer("cat /var/lib/dockflow/backups/local.password")
	if strings.Contains(r.out, pw) || !strings.Contains(r.out, "backup.password_generated") {
		t.Fatalf("the password is generated, said, and masked:\n%s", r.out)
	}
	// the writes stopped during the copy, and resumed
	if got, _ := inServer("docker exec " + files + " cat /data/quiesce.log"); got != "pre\npost" {
		t.Fatalf("quiesce: %q", got)
	}
	// nothing of the run stays: no restic container, no secrets file
	if got, _ := inServer("docker ps -aq --filter name=dockflow-restic- | wc -l; ls /run/dockflow | grep -c backup- || true"); got != "0\n0" {
		t.Fatalf("leftovers: %q", got)
	}

	// a second backup: files keeps its last one only
	mustSucceed(t, dockflow(t, dir, "backup", "run", "production"), "backup run again")
	snaps := backupList(t, dir, "production")
	count := map[string]int{}
	for _, s := range snaps {
		count[s.Service]++
		if s.Release != 1 {
			t.Fatalf("snapshots are tagged with the release: %+v", s)
		}
	}
	if count["db"] != 2 || count["files"] != 1 {
		t.Fatalf("retention: %+v", snaps)
	}
	mustSucceed(t, dockflow(t, dir, "backup", "run", "production", "db"), "backup run db")
	if got := backupList(t, dir, "production", "files"); len(got) != 1 {
		t.Fatalf("backup run db backs up db only: %+v", got)
	}

	// restores: the dump, with the service running; the volume, with it stopped, which loses the
	// files the snapshot does not have
	psql(db, "insert into t values (43)")
	if _, err := inServer("docker exec " + files + " sh -c 'rm /data/hello.txt && echo x > /data/extra'"); err != nil {
		t.Fatal(err)
	}
	mustSucceed(t, dockflow(t, dir, "--yes", "backup", "restore", "production", "db"), "backup restore db")
	if got := psql(db, "select count(*), max(x) from t"); got != "1|42" {
		t.Fatalf("the restored table: %q", got)
	}
	mustSucceed(t, dockflow(t, dir, "--yes", "backup", "restore", "production", "files"), "backup restore files")
	files = container("production", "files")
	if got, _ := inServer("docker exec " + files + " sh -c 'cat /data/hello.txt /data/quiesce.log; ls /data'"); got != "hello\npre\npost\npre\nhello.txt\nquiesce.log" {
		t.Fatalf("the restored volume: %q", got)
	}
	first := backupList(t, dir, "production", "db")[0].ID
	mustSucceed(t, dockflow(t, dir, "--yes", "backup", "restore", "production", "db", "--snapshot", first[:5]), "restore by id")
	if r := dockflow(t, dir, "--yes", "backup", "restore", "production", "db", "--snapshot", "2001-01-01"); r.code != 2 {
		t.Fatalf("no snapshot by that date: exit %d\n%s", r.code, r.out)
	}

	// production's data into staging
	mustSucceed(t, dockflow(t, dir, "deploy", "staging"), "deploy staging")
	stagingDB := container("staging", "db")
	mustSucceed(t, dockflow(t, dir, "--yes", "backup", "restore", "staging", "db", "--from", "production"), "restore staging from production")
	if got := psql(stagingDB, "select count(*) from t"); got != "1" {
		t.Fatalf("staging has production's table: %q", got)
	}
	// a restore that fails stops at the first error, and says so
	if _, err := inServer("docker exec " + stagingDB + " psql -U postgres -c 'drop database shop'"); err != nil {
		t.Fatal(err)
	}
	r = dockflow(t, dir, "--yes", "backup", "restore", "staging", "db", "--from", "production")
	if r.code != 12 || !strings.Contains(r.out, "pg_restore exited with code") {
		t.Fatalf("a failed restore: exit %d\n%s", r.code, r.out)
	}

	// prune applies a retention now
	mustSucceed(t, dockflow(t, dir, "backup", "prune", "production", "db", "--keep-last", "1"), "backup prune")
	if got := backupList(t, dir, "production", "db"); len(got) != 1 {
		t.Fatalf("prune keeps the last one: %+v", got)
	}

	// a service without a backup, or a dump that fails, is an error
	if r := dockflow(t, dir, "backup", "run", "production", "nosuch"); r.code != 2 {
		t.Fatalf("backup run nosuch: exit %d\n%s", r.code, r.out)
	}
	psql(db, "select 1")
	if _, err := inServer("docker exec " + db + " psql -U postgres -c 'alter database shop rename to gone'"); err != nil {
		t.Fatal(err)
	}
	r = dockflow(t, dir, "backup", "run", "production", "db")
	if r.code != 12 || !strings.Contains(r.out, "pg_dump exited with code") {
		t.Fatalf("a failed dump: exit %d\n%s", r.code, r.out)
	}
	if got := backupList(t, dir, "production", "db"); len(got) != 1 {
		t.Fatalf("a failed dump leaves no snapshot: %+v", got)
	}
}
