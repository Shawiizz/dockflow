//go:build e2e

package e2e

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// The server's state is backed up, without the backups' passwords, and kept apart from the
// services' snapshots.
func TestServerBackup(t *testing.T) {
	app := "journey41"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, `services:
  web:
    image: `+alpineImage+`
    command: ["sleep", "3600"]
    init: true
    x-dockflow: { health: { grace: 1s } }
`)
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy")
	t.Cleanup(func() { dockflow(t, dir, "destroy", "production") })

	r := dockflow(t, dir, "backup", "run", "--server")
	mustSucceed(t, r, "backup run --server")
	if !strings.Contains(r.out, `"type":"backup.finished"`) {
		t.Fatalf("backup.finished:\n%s", r.out)
	}
	if r := dockflow(t, dir, "backup", "run", "--server", "web"); r.code != 2 {
		t.Fatalf("--server with a service is a usage error, got %d:\n%s", r.code, r.out)
	}

	var out struct {
		Snapshots []struct {
			ID      string `json:"id"`
			Server  string `json:"server"`
			Service string `json:"service"`
		} `json:"snapshots"`
	}
	r = dockflow(t, dir, "backup", "list", "--server")
	mustSucceed(t, r, "backup list --server")
	if err := json.Unmarshal([]byte(r.out), &out); err != nil {
		t.Fatalf("backup list --server: %v\n%s", err, r.out)
	}
	if len(out.Snapshots) != 1 || out.Snapshots[0].Server == "" || out.Snapshots[0].Service != "" {
		t.Fatalf("one snapshot of the server: %+v", out.Snapshots)
	}
	if got := backupList(t, dir); len(got) != 0 {
		t.Fatalf("the server's snapshot is not the environment's: %+v", got)
	}

	// what the snapshot holds, read with restic itself
	files, err := inServer("docker run --rm -v dockflow-backups:/repo -v /var/lib/dockflow/backups/local.password:/pw:ro " +
		"$(docker images -q restic/restic | head -1) -r /repo --password-file /pw ls " + out.Snapshots[0].ID)
	if err != nil {
		t.Fatalf("restic ls: %v\n%s", err, files)
	}
	if !strings.Contains(files, "/var/lib/dockflow/apps/"+app+"-production/env.json") || strings.Contains(files, "/var/lib/dockflow/backups") {
		t.Fatalf("the state, without the passwords:\n%s", files)
	}

	mustSucceed(t, dockflow(t, dir, "backup", "run", "--server"), "second backup run --server")
	mustSucceed(t, dockflow(t, dir, "backup", "prune", "--server", "--keep-last", "1"), "backup prune --server")
	r = dockflow(t, dir, "backup", "list", "--server")
	if err := json.Unmarshal([]byte(r.out), &out); err != nil || len(out.Snapshots) != 1 {
		t.Fatalf("prune --server keeps the last one: %v\n%s", err, r.out)
	}
}
