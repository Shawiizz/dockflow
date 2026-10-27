//go:build real

package real

import (
	"encoding/json"
	"fmt"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/connection"
)

// A blank droplet serves an app over HTTPS with server init and deploy only; the port filter
// opens a published port only once it is in public_ports; the cloudflare edge closes ports 80
// and 443 to everyone else.
func TestProvisionAndDeploy(t *testing.T) {
	t.Parallel()
	rootKey, hostKey := newKey(t), newKey(t)
	ip := createDroplet(t, "provision", hostKeyUserData(t, hostKey), &rootKey)
	fp := ssh.FingerprintSHA256(hostKey.signer.PublicKey())
	if out, err := sshRun(t, ip, "root", rootKey.signer, fp, "cloud-init status --wait >/dev/null; echo ready", 10*time.Minute); err != nil || out != "ready" {
		t.Fatalf("the droplet boots: %v %s", err, out)
	}

	dir := filepath.Join(workDir, "provision")
	keyFile := filepath.Join(workDir, "root-key")
	writeFile(t, keyFile, string(rootKey.pem))
	writeFile(t, filepath.Join(dir, "README"), "")
	r := dockflow(t, dir, "", "--json", "server", "init", "root@"+ip, "-k", keyFile, "--host-key", fp, "--acme-ca", stagingCA)
	mustSucceed(t, r, "server init")
	var init struct {
		Connection string `json:"connection"`
	}
	lines := strings.Split(strings.TrimSpace(r.out), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &init); err != nil || init.Connection == "" {
		t.Fatalf("server init prints the connection string: %v\n%s", err, r.out)
	}
	conn := init.Connection

	// hardening: root has a key, so SSH takes keys only
	if out, _ := sshRun(t, ip, "root", rootKey.signer, fp, "sshd -T | grep -i '^passwordauthentication'; systemctl is-active fail2ban", time.Minute); !strings.Contains(out, "passwordauthentication no") || !strings.Contains(out, "active") {
		t.Fatalf("SSH refuses passwords and fail2ban runs:\n%s", out)
	}

	domain := strings.ReplaceAll(ip, ".", "-") + ".sslip.io"
	project := func(publicPorts string) {
		writeFile(t, filepath.Join(dir, "dockflow.yml"), fmt.Sprintf("version: 1\napp: real\n%senvironments:\n  production:\n    vars:\n      DOMAIN: %s\n", publicPorts, domain))
		writeFile(t, filepath.Join(dir, "compose.yml"), `services:
  web:
    image: `+whoami+`
    x-dockflow:
      routes:
        - domains: ["${DOMAIN}"]
          port: 80
  api:
    image: `+whoami+`
    ports: ["9000:80"]
`)
	}
	project("")
	mustSucceed(t, dockflow(t, dir, conn, "deploy"), "deploy")

	eventually(t, 5*time.Minute, "the app is served over HTTPS with a staging certificate", func() error {
		status, body, issuer, err := get("https://"+domain+"/", ip)
		if err != nil {
			return err
		}
		if status != 200 || !strings.Contains(body, "Hostname") || !strings.Contains(issuer, "STAGING") {
			return fmt.Errorf("status %d, issuer %q", status, issuer)
		}
		return nil
	})
	status, _, _, err := get("http://"+domain+"/", ip)
	if err != nil || status != 308 && status != 301 && status != 302 {
		t.Fatalf("http redirects to https: %d %v", status, err)
	}

	// the filter: a published port is closed until public_ports lists it
	if reachable(net.JoinHostPort(ip, "9000")) {
		t.Fatal("port 9000 is published but not in public_ports: it is closed")
	}
	project("firewall:\n  public_ports: [9000]\n")
	mustSucceed(t, dockflow(t, dir, conn, "deploy"), "deploy with public_ports")
	eventually(t, time.Minute, "port 9000 opens", func() error {
		if !reachable(net.JoinHostPort(ip, "9000")) {
			return fmt.Errorf("closed")
		}
		return nil
	})

	mustSucceed(t, dockflow(t, dir, conn, "server", "check"), "server check")

	// the cloudflare edge: only Cloudflare's ranges reach ports 80 and 443
	mustSucceed(t, dockflow(t, dir, conn, "server", "edge", "cloudflare"), "server edge cloudflare")
	if reachable(net.JoinHostPort(ip, "443")) {
		t.Fatal("with the cloudflare edge, port 443 is closed to this machine")
	}
	mustSucceed(t, dockflow(t, dir, conn, "server", "edge", "builtin"), "server edge builtin")
	eventually(t, time.Minute, "the app is served again", func() error {
		status, _, _, err := get("https://"+domain+"/", ip)
		if err == nil && status != 200 {
			err = fmt.Errorf("status %d", status)
		}
		return err
	})

	r = dockflow(t, dir, conn, "--yes", "server", "uninstall", "--volumes")
	mustSucceed(t, r, "server uninstall")
	if reachable(net.JoinHostPort(ip, "443")) {
		t.Fatal("after server uninstall, nothing listens on 443")
	}
}

// A droplet provisioned by server cloud-init on its first boot, with nginx in front of the
// switch, serves an app through the nginx plugin's vhost.
func TestCloudInitBehindNginx(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(workDir, "cloudinit")
	writeFile(t, filepath.Join(dir, "README"), "")
	r := dockflow(t, dir, "", "--json", "server", "cloud-init", "--host", "pending.invalid", "--nginx")
	mustSucceed(t, r, "server cloud-init")
	var doc struct {
		Connection string `json:"connection"`
		UserData   string `json:"user_data"`
	}
	if err := json.Unmarshal([]byte(r.out), &doc); err != nil {
		t.Fatalf("%v\n%s", err, r.out)
	}
	// root waits for the first boot: a deploy user tried before it exists fails, and fail2ban,
	// installed by that boot, bans the address after five failures
	rootKey := newKey(t)
	ip := createDroplet(t, "cloudinit", doc.UserData, &rootKey)

	// the connection string names the address, now known
	cs, err := connection.ParseConnString(doc.Connection)
	if err != nil {
		t.Fatal(err)
	}
	cs.Servers[0].Host = ip
	conn := cs.Encode()
	signer, err := ssh.ParsePrivateKey([]byte(cs.PrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	if out, err := sshRun(t, ip, "root", rootKey.signer, cs.Servers[0].HostKey, "cloud-init status --wait >/dev/null; echo ready", 15*time.Minute); err != nil || out != "ready" {
		t.Fatalf("the first boot finishes: %v %s", err, out)
	}
	if out, err := sshRun(t, ip, cs.Servers[0].User, signer, cs.Servers[0].HostKey, "id -nG", time.Minute); err != nil || !strings.Contains(out, "docker") {
		t.Fatalf("the deploy user gets in, in the docker group: %v %s", err, out)
	}

	domain := strings.ReplaceAll(ip, ".", "-") + ".sslip.io"
	writeFile(t, filepath.Join(dir, "dockflow.yml"), fmt.Sprintf(`version: 1
app: nginxed
plugins:
  - use: nginx
    with:
      domain: [%s]
      ipv6: false
environments:
  production: {}
`, domain))
	writeFile(t, filepath.Join(dir, "compose.yml"), `services:
  web:
    image: `+whoami+`
    x-dockflow:
      routes:
        - domains: [`+domain+`]
          port: 80
`)
	mustSucceed(t, dockflow(t, dir, conn, "server", "init", "production", "--edge", "external"), "server init")
	mustSucceed(t, dockflow(t, dir, conn, "deploy"), "deploy")
	eventually(t, time.Minute, "nginx serves the app", func() error {
		status, body, _, err := get("http://"+domain+"/", ip)
		if err == nil && (status != 200 || !strings.Contains(body, "Hostname")) {
			err = fmt.Errorf("status %d", status)
		}
		return err
	})
	// nginx refuses the host names no vhost serves
	if status, _, _, err := get("http://unknown.example/", ip); err == nil {
		t.Fatalf("nginx answers an unknown host name: %d", status)
	}
}
