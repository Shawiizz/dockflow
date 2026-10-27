//go:build real

// Package real runs the compiled dockflow binary against fresh DigitalOcean droplets (ADR-0019):
// provisioning, cloud-init, certificates from Let's Encrypt's staging, the cloudflare edge, nginx
// in front of the switch and the port filter, on real interfaces. Each journey creates its own
// droplet and deletes it at the end. It needs DIGITALOCEAN_TOKEN, and costs a few cents a run:
//
//	DIGITALOCEAN_TOKEN=… go test -tags real -v -timeout 60m ./test/real/
//
// Without the token, it skips.
package real

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
	"golang.org/x/crypto/ssh"
)

const (
	tag        = "dockflow-real"
	stagingCA  = "https://acme-staging-v02.api.letsencrypt.org/directory"
	whoami     = "traefik/whoami:v1.10.3"
	doEndpoint = "https://api.digitalocean.com/v2"
)

var (
	token   = os.Getenv("DIGITALOCEAN_TOKEN")
	region  = env("DOCKFLOW_REAL_REGION", "fra1")
	size    = env("DOCKFLOW_REAL_SIZE", "s-1vcpu-1gb")
	image   = env("DOCKFLOW_REAL_IMAGE", "ubuntu-24-04-x64")
	binary  string
	workDir string
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func TestMain(m *testing.M) {
	if token == "" {
		fmt.Println("skipped: DIGITALOCEAN_TOKEN is not set")
		os.Exit(0)
	}
	var err error
	if workDir, err = os.MkdirTemp("", "dockflow-real-"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	binary = filepath.Join(workDir, "dockflow")
	root, _ := filepath.Abs("../..")
	build := exec.Command("go", "build", "-o", binary, "./cmd/dockflow")
	build.Dir = root
	// the agent's image holds the binary alone
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build: %v\n%s", err, out)
		os.Exit(1)
	}
	// droplets an interrupted run left behind
	deleteStale()
	code := m.Run()
	os.RemoveAll(workDir)
	os.Exit(code)
}

// api calls DigitalOcean's API.
func api(method, path string, body, out any) error {
	var in io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		in = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, doEndpoint+path, in)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %s: %s", method, path, res.Status, b)
	}
	if out != nil {
		return json.Unmarshal(b, out)
	}
	return nil
}

type apiDroplet struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	Networks  struct {
		V4 []struct {
			IP   string `json:"ip_address"`
			Type string `json:"type"`
		} `json:"v4"`
	} `json:"networks"`
}

func deleteStale() {
	var list struct {
		Droplets []apiDroplet `json:"droplets"`
	}
	if err := api("GET", "/droplets?per_page=200&tag_name="+tag, nil, &list); err != nil {
		fmt.Fprintln(os.Stderr, "listing old droplets:", err)
		return
	}
	for _, d := range list.Droplets {
		if time.Since(d.CreatedAt) > 3*time.Hour {
			fmt.Printf("deleting the droplet %s, left by an earlier run\n", d.Name)
			_ = api("DELETE", fmt.Sprintf("/droplets/%d", d.ID), nil, nil)
		}
	}
}

// createDroplet creates a droplet with userData, root reachable with rootKey when given, deleted
// when the test ends, and returns its public address once it has one.
func createDroplet(t *testing.T, name, userData string, rootKey *key) string {
	t.Helper()
	var created struct {
		Droplet apiDroplet `json:"droplet"`
	}
	name = fmt.Sprintf("%s-%s-%d", tag, name, time.Now().Unix())
	body := map[string]any{
		"name": name, "region": region, "size": size, "image": image, "tags": []string{tag},
		"user_data": userData, "ipv6": false,
	}
	if rootKey != nil {
		// a droplet created without a key has an expired root password, which SSH makes
		// root change before running anything
		var k struct {
			SSHKey struct {
				ID int `json:"id"`
			} `json:"ssh_key"`
		}
		if err := api("POST", "/account/keys", map[string]string{"name": name, "public_key": rootKey.authorized()}, &k); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = api("DELETE", fmt.Sprintf("/account/keys/%d", k.SSHKey.ID), nil, nil) })
		body["ssh_keys"] = []int{k.SSHKey.ID}
	}
	err := api("POST", "/droplets", body, &created)
	if err != nil {
		t.Fatal(err)
	}
	id := created.Droplet.ID
	t.Cleanup(func() {
		if err := api("DELETE", fmt.Sprintf("/droplets/%d", id), nil, nil); err != nil {
			t.Errorf("delete the droplet %s: %v", name, err)
		}
	})
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		var got struct {
			Droplet apiDroplet `json:"droplet"`
		}
		if err := api("GET", fmt.Sprintf("/droplets/%d", id), nil, &got); err == nil && got.Droplet.Status == "active" {
			for _, n := range got.Droplet.Networks.V4 {
				if n.Type == "public" {
					t.Logf("droplet %s: %s", name, n.IP)
					return n.IP
				}
			}
		}
		time.Sleep(5 * time.Second)
	}
	t.Fatalf("the droplet %s is not active after 5 minutes", name)
	return ""
}

// key is an ed25519 key pair.
type key struct {
	signer ssh.Signer
	pem    []byte
}

func newKey(t *testing.T) key {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return key{signer: signer, pem: pem.EncodeToMemory(block)}
}

func (k key) authorized() string {
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k.signer.PublicKey())))
}

// hostKeyUserData gives the server hostKey as its host key, so that the test knows it before
// the server exists.
func hostKeyUserData(t *testing.T, hostKey key) string {
	t.Helper()
	cfg := map[string]any{
		"ssh_deletekeys":  true,
		"ssh_genkeytypes": []string{},
		"ssh_keys": map[string]string{
			"ed25519_private": string(hostKey.pem),
			"ed25519_public":  hostKey.authorized(),
		},
	}
	b, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return "#cloud-config\n" + string(b)
}

// sshRun runs a command on the server as user, once SSH answers with the host key fingerprint
// hostKey, retrying for up to wait.
func sshRun(t *testing.T, ip, user string, signer ssh.Signer, hostKey string, command string, wait time.Duration) (string, error) {
	t.Helper()
	cfg := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
			if fp := ssh.FingerprintSHA256(k); fp != hostKey {
				return fmt.Errorf("host key %s, want %s", fp, hostKey)
			}
			return nil
		},
		Timeout: 10 * time.Second,
	}
	deadline := time.Now().Add(wait)
	for {
		c, err := ssh.Dial("tcp", net.JoinHostPort(ip, "22"), cfg)
		if err == nil {
			s, err := c.NewSession()
			if err == nil {
				out, err := s.CombinedOutput(command)
				c.Close()
				return strings.TrimSpace(string(out)), err
			}
			c.Close()
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("ssh %s@%s: %v", user, ip, err)
		}
		time.Sleep(5 * time.Second)
	}
}

type result struct {
	out  string
	code int
}

// dockflow runs the CLI in dir, with the connection string of production.
func dockflow(t *testing.T, dir, conn string, args ...string) result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PRODUCTION_CONNECTION="+conn, "NO_COLOR=1")
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	code := 0
	if err != nil {
		code = -1
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
	}
	t.Logf("dockflow %s: exit %d", strings.Join(args, " "), code)
	return result{out.String(), code}
}

func mustSucceed(t *testing.T, r result, what string) {
	t.Helper()
	if r.code != 0 {
		t.Fatalf("%s: exit %d\n%s", what, r.code, r.out)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// eventually retries check until it returns nil, for up to wait.
func eventually(t *testing.T, wait time.Duration, what string, check func() error) {
	t.Helper()
	deadline := time.Now().Add(wait)
	for {
		err := check()
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s, after %s: %v", what, wait, err)
		}
		time.Sleep(5 * time.Second)
	}
}

// get fetches url, with addr as the address of every host name, and tells the status, the body
// and the certificate's issuer.
func get(url, addr string) (int, string, string, error) {
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // staging certificates: checked by issuer
		DialContext: func(ctx context.Context, network, a string) (net.Conn, error) {
			_, port, _ := net.SplitHostPort(a)
			return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(addr, port))
		},
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(url)
	if err != nil {
		return 0, "", "", err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	issuer := ""
	if res.TLS != nil && len(res.TLS.PeerCertificates) > 0 {
		issuer = strings.Join(res.TLS.PeerCertificates[0].Issuer.Organization, ",") + " " + res.TLS.PeerCertificates[0].Issuer.CommonName
	}
	return res.StatusCode, string(b), issuer, nil
}

// reachable tells whether a TCP connection to addr opens within a few seconds.
func reachable(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}
