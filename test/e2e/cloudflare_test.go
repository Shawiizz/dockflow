//go:build e2e

package e2e

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Shawiizz/dockflow/internal/provision"
)

// The cloudflare edge: ports 80 and 443 open to Cloudflare's ranges only. This machine is not
// Cloudflare, so the switch, which answered before, does not answer.
func TestCloudflareEdge(t *testing.T) {
	app := "journey34"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	writeProject(t, dir, app, webApp(app, "whoami-e2e:v1", ""))
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy")
	waitServing(t, host)

	r := serverInit("--edge", "cloudflare")
	mustSucceed(t, r, "server init --edge cloudflare")
	t.Cleanup(func() {
		if r := serverInit("--edge", "builtin"); r.code != 0 {
			t.Errorf("restoring the builtin edge: exit %d\n%s", r.code, r.out)
		}
		dockflow(t, dir, "destroy", "production")
	})
	// a server without network uses Dockflow's own list of ranges, and says so; CI's
	// Docker-in-Docker has network and downloads them
	offline := strings.Contains(r.out, "cloudflare.ranges")
	if got, _ := inServer("cat /var/lib/dockflow/server.json"); !strings.Contains(got, `"edge": "cloudflare"`) || !strings.Contains(got, "173.245.48.0/20") {
		t.Fatalf("server.json records the edge and the ranges:\n%s", got)
	}

	client := &http.Client{Timeout: 3 * time.Second}
	req, _ := http.NewRequest(http.MethodGet, "http://"+serverIP+"/", nil)
	req.Host = host
	if resp, err := client.Do(req); err == nil {
		resp.Body.Close()
		t.Fatalf("the switch must not answer outside Cloudflare's ranges, got %d", resp.StatusCode)
	}

	// the weekly refresh: it keeps the ranges it has when the download fails
	if _, err := inServer("cat > /tmp/cloudflare-refresh <<'SCRIPT'\n" + provision.CloudflareRefresh + "SCRIPT\nchmod +x /tmp/cloudflare-refresh"); err != nil {
		t.Fatal(err)
	}
	out, err := inServer("/tmp/cloudflare-refresh 2>&1")
	if err != nil || (offline && !strings.Contains(out, "the previous ones stay")) {
		t.Fatalf("the refresh keeps the previous ranges: %v\n%s", err, out)
	}
}
