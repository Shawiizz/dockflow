//go:build e2e

package e2e

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// MariaDB, Redis and MongoDB, each dumped in its own container, restored with the dump.
func TestBackupDumpTypes(t *testing.T) {
	app := "journey40"
	stack := app + "-production"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, fmt.Sprintf(`services:
  maria:
    image: %s
    environment: { MARIADB_ROOT_PASSWORD: "r00t'pw", MARIADB_DATABASE: shop }
    volumes: [maria:/var/lib/mysql]
    healthcheck: { test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"], interval: 1s, retries: 90 }
    x-dockflow: { stateful: true, backup: { type: mysql } }
  cache:
    image: %s
    volumes: [cache:/data]
    x-dockflow: { stateful: true, health: { grace: 1s }, backup: { type: redis } }
  mongo:
    image: %s
    # GLIBC_TUNABLES: MongoDB 8 refuses to start on Linux 6.19 and newer, as on some CI runners, unless glibc
    # owns rseq (SERVER-121912)
    environment: { MONGO_INITDB_ROOT_USERNAME: root, MONGO_INITDB_ROOT_PASSWORD: pw, GLIBC_TUNABLES: glibc.pthread.rseq=1 }
    volumes: [mongo:/data/db]
    healthcheck: { test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"], interval: 2s, retries: 60 }
    x-dockflow: { stateful: true, backup: { type: mongo } }
volumes: { maria: {}, cache: {}, mongo: {} }
`, mariadbImage, redisImage, mongoImage))
	writeFile(t, filepath.Join(dir, "dockflow.yml"), "version: 1\napp: "+app+"\nenvironments:\n  production:\n    deploy: { timeout: 3m }\n")
	t.Cleanup(func() { dockflow(t, dir, "destroy", "production", "--volumes") })
	// a failed rollout is rolled back, its containers removed: their logs are copied while the deploy runs,
	// to say why a database did not start
	go inServer("rm -rf /tmp/" + app + "; mkdir /tmp/" + app + "; for i in $(seq 300); do " +
		"for c in $(docker ps -aq --filter label=com.docker.compose.project=" + stack + "); do " +
		"docker inspect -f '{{.Name}} {{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}} {{range .State.Health.Log}}{{.Output}}{{end}}{{end}}' $c > /tmp/" + app + "/$c.new 2>&1 && " +
		"docker logs --tail 30 $c >> /tmp/" + app + "/$c.new 2>&1 && mv /tmp/" + app + "/$c.new /tmp/" + app + "/$c; done; sleep 0.2; done")
	if r := dockflow(t, dir, "deploy"); r.code != 0 {
		logs, _ := inServer("cat /tmp/" + app + "/*")
		t.Fatalf("deploy: exit %d\n%s\n%s", r.code, r.out, logs)
	}
	in := func(service, cmd string) string {
		t.Helper()
		out, err := inServer("docker exec $(docker ps -q --filter label=com.docker.compose.project=" + stack + " --filter label=com.docker.compose.service=" + service + ") " + cmd)
		if err != nil {
			t.Fatalf("%s: %v", cmd, err)
		}
		return out
	}
	maria := func(sql string) string {
		return in("maria", `sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" shop -N -e "`+sql+`"'`)
	}
	mongo := func(js string) string {
		return in("mongo", `mongosh -u root -p pw --quiet --eval '`+js+`'`)
	}
	maria("create table t (x int); insert into t values (1)")
	in("cache", "redis-cli set k v1")
	mongo(`db.getSiblingDB("shop").c.insertOne({x: 1})`)

	r := dockflow(t, dir, "backup", "run")
	mustSucceed(t, r, "backup run")
	if n := strings.Count(r.out, `"type":"backup.finished"`); n != 3 {
		t.Fatalf("three services backed up, got %d:\n%s", n, r.out)
	}
	if strings.Contains(r.out, "r00t") {
		t.Fatalf("a credential reached the output:\n%s", r.out)
	}

	maria("insert into t values (2)")
	in("cache", "redis-cli set k v2")
	mongo(`db.getSiblingDB("shop").c.insertOne({x: 2})`)
	for _, s := range []string{"maria", "cache", "mongo"} {
		mustSucceed(t, dockflow(t, dir, "--yes", "backup", "restore", s), "restore "+s)
	}
	if got := maria("select count(*) from t"); got != "1" {
		t.Fatalf("mariadb restored: %q", got)
	}
	if got := in("cache", "redis-cli get k"); got != "v1" {
		t.Fatalf("redis restored: %q", got)
	}
	if got := mongo(`db.getSiblingDB("shop").c.countDocuments()`); got != "1" {
		t.Fatalf("mongodb restored: %q", got)
	}
}
