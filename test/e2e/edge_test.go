//go:build e2e

package e2e

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const nginxConf = `server {
    listen 80 default_server;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
`

// The host's nginx in front of the switch, as on a server that already runs nginx.
func TestExternalEdgeBehindNginx(t *testing.T) {
	mustSucceed(t, serverInit("--edge", "external"), "server init --edge external")
	t.Cleanup(func() {
		if t.Failed() {
			logs, _ := inServer("docker logs e2e-nginx 2>&1 | grep -E 'error|\" 502 ' | head -20")
			t.Logf("nginx:\n%s", logs)
		}
		inServer("docker rm -f e2e-nginx")
		if r := serverInit("--edge", "builtin"); r.code != 0 {
			t.Errorf("restoring the builtin edge: exit %d\n%s", r.code, r.out)
		}
	})
	conf := filepath.Join(workDir, "nginx.conf")
	os.WriteFile(conf, []byte(nginxConf), 0o644)
	if _, err := sh("docker", "cp", conf, dind+":/nginx.conf"); err != nil {
		t.Fatal(err)
	}
	if _, err := inServer("docker run -d --name e2e-nginx --network host -v /nginx.conf:/etc/nginx/conf.d/default.conf:ro " + nginxImage); err != nil {
		t.Fatal(err)
	}

	app := "journey6"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	// tls stays true: with the external edge, TLS is the front proxy's
	compose := strings.Replace(webApp(app, "whoami-e2e:v1", ""), "tls: false", "tls: true", 1)
	writeProject(t, dir, app, compose)
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy behind nginx")
	waitServing(t, host)

	req, _ := http.NewRequest(http.MethodGet, "http://"+serverIP+"/", nil)
	req.Host = host
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), "X-Forwarded-For:") {
		t.Fatalf("the app must see X-Forwarded-For:\n%s", b)
	}

	l := startLoad(t, host, 4)
	writeProject(t, dir, app, strings.Replace(compose, "whoami-e2e:v1", "whoami-e2e:v2", 1))
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy behind nginx under load")
	l.stop(t)

	// server init again, without options: the server keeps its external edge
	mustSucceed(t, serverInit(), "server init without options")
	if got, _ := inServer("cat /var/lib/dockflow/server.json"); !strings.Contains(got, `"edge": "external"`) || !strings.Contains(got, `"switch_listen": "127.0.0.1:8080"`) {
		t.Fatalf("server init keeps the edge it is not given:\n%s", got)
	}
	waitServing(t, host)
}
