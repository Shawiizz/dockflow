//go:build e2e

// Package e2e runs the compiled dockflow binary against a Docker-in-Docker server reached over
// SSH, one test per user journey (ADR-0019). Run with: go test -tags e2e ./test/e2e/
package e2e

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/agent"
)

var (
	dind       string // the server's container
	serverIP   string
	connString string
	binary     string
	workDir    string
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var (
	dindImage     = env("DOCKFLOW_E2E_DIND_IMAGE", "mirror.gcr.io/library/docker:dind")
	whoamiImage   = env("DOCKFLOW_E2E_WHOAMI_IMAGE", "traefik/whoami:latest")
	caddyImage    = env("DOCKFLOW_E2E_CADDY_IMAGE", "mirror.gcr.io/library/caddy:2")
	alpineImage   = env("DOCKFLOW_E2E_ALPINE_IMAGE", "mirror.gcr.io/library/alpine:3")
	registryImage = env("DOCKFLOW_E2E_REGISTRY_IMAGE", "mirror.gcr.io/library/registry:3")
	nginxImage    = env("DOCKFLOW_E2E_NGINX_IMAGE", "mirror.gcr.io/library/nginx:alpine")
	postgresImage = env("DOCKFLOW_E2E_POSTGRES_IMAGE", "mirror.gcr.io/library/postgres:17-alpine")
	mariadbImage  = env("DOCKFLOW_E2E_MARIADB_IMAGE", "mirror.gcr.io/library/mariadb:11")
	redisImage    = env("DOCKFLOW_E2E_REDIS_IMAGE", "mirror.gcr.io/library/redis:7-alpine")
	mongoImage    = env("DOCKFLOW_E2E_MONGO_IMAGE", "mirror.gcr.io/library/mongo:8")
	// the agent runs restic by this name: the server loads it from here
	resticImage = agent.DefaultResticImage
)

func TestMain(m *testing.M) {
	code, err := setup()
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e setup:", err)
		teardown()
		os.Exit(1)
	}
	if code == 0 {
		code = m.Run()
	}
	teardown()
	os.Exit(code)
}

func sh(args ...string) (string, error) {
	cmd := exec.Command(args[0], args[1:]...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	if err != nil {
		return out.String(), fmt.Errorf("%s: %v: %s", strings.Join(args, " "), err, out.String())
	}
	return strings.TrimSpace(out.String()), nil
}

// inServer runs a shell command on the server, through docker exec: for setting up and
// observing only, never to deploy.
func inServer(script string) (string, error) {
	return sh("docker", "exec", dind, "sh", "-c", script)
}

func setup() (int, error) {
	var err error
	if workDir, err = os.MkdirTemp("", "dockflow-e2e-"); err != nil {
		return 1, err
	}
	root, _ := filepath.Abs("../..")
	binary = filepath.Join(workDir, "dockflow")
	sshd := filepath.Join(workDir, "sshd")
	volplugin := filepath.Join(workDir, "volplugin")
	for out, pkg := range map[string]string{binary: "./cmd/dockflow", sshd: "./test/e2e/sshd", volplugin: "./test/e2e/volplugin"} {
		cmd := exec.Command("go", "build", "-o", out, pkg)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			return 1, fmt.Errorf("build %s: %v: %s", pkg, err, b)
		}
	}

	dind = fmt.Sprintf("dockflow-e2e-%d", time.Now().UnixNano()%1000000)
	if _, err := sh("docker", "run", "-d", "--privileged", "--name", dind, "-e", "DOCKER_TLS_CERTDIR=",
		// as systemd mounts a tmpfs on /run: Compose secrets live there (ADR-0012)
		"--tmpfs", "/run/dockflow", dindImage); err != nil {
		return 1, err
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		if _, err := inServer("docker info"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			return 1, fmt.Errorf("the server's dockerd does not start")
		}
		time.Sleep(500 * time.Millisecond)
	}

	// the server has no network: it gets its images from here
	for _, img := range []string{whoamiImage, caddyImage, alpineImage, registryImage, nginxImage, postgresImage, mariadbImage, redisImage, mongoImage, resticImage} {
		if _, err := sh("docker", "image", "inspect", img); err != nil {
			if _, err := sh("docker", "pull", img); err != nil {
				return 1, err
			}
		}
		save := exec.Command("docker", "save", img)
		load := exec.Command("docker", "exec", "-i", dind, "docker", "load")
		pipe, _ := save.StdoutPipe()
		load.Stdin = pipe
		if err := save.Start(); err != nil {
			return 1, err
		}
		if b, err := load.CombinedOutput(); err != nil {
			return 1, fmt.Errorf("load %s: %v: %s", img, err, b)
		}
		save.Wait()
	}
	// two versions of the web app, with different image IDs
	if _, err := inServer(fmt.Sprintf(`docker tag %s whoami-e2e:v1 &&
		id=$(docker create %s) && docker commit --change "LABEL e2e=v2" $id whoami-e2e:v2 >/dev/null && docker rm $id >/dev/null`, whoamiImage, whoamiImage)); err != nil {
		return 1, err
	}

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	sshPub, _ := ssh.NewPublicKey(pub)
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		return 1, err
	}
	authorized := filepath.Join(workDir, "authorized_key")
	os.WriteFile(authorized, ssh.MarshalAuthorizedKey(sshPub), 0o600)
	if _, err := sh("docker", "cp", authorized, dind+":/authorized_key"); err != nil {
		return 1, err
	}
	if _, err := sh("docker", "cp", sshd, dind+":/sshd"); err != nil {
		return 1, err
	}
	if _, err := sh("docker", "cp", volplugin, dind+":/volplugin"); err != nil {
		return 1, err
	}
	if _, err := sh("docker", "exec", "-d", dind, "/sshd"); err != nil {
		return 1, err
	}
	var fp string
	for i := 0; i < 50; i++ {
		if fp, err = inServer("cat /host_key_fingerprint"); err == nil && fp != "" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if fp == "" {
		return 1, fmt.Errorf("the server's sshd does not start")
	}
	if serverIP, err = sh("docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", dind); err != nil {
		return 1, err
	}
	cs, _ := json.Marshal(map[string]any{
		"v":           2,
		"servers":     []any{map[string]any{"host": serverIP, "port": 2222, "user": "root", "host_key": fp}},
		"private_key": string(pem.EncodeToMemory(block)),
	})
	connString = base64.StdEncoding.EncodeToString(cs)

	// the switch, as a user would install it
	if r := serverInit(); r.code != 0 {
		return 1, fmt.Errorf("server init: exit %d: %s", r.code, r.out)
	}
	return 0, nil
}

// serverInit runs `dockflow server init` with the images the server has, and extra options.
func serverInit(extra ...string) result {
	dir := filepath.Join(workDir, "init")
	writeProject(nil, dir, "init", "services: {}\n")
	args := append([]string{"server", "init", "--switch-image", caddyImage, "--registry-image", registryImage}, extra...)
	return dockflow(nil, dir, args...)
}

func teardown() {
	if os.Getenv("DOCKFLOW_E2E_KEEP") != "" {
		os.WriteFile(filepath.Join(workDir, "connection"), []byte(connString), 0o600)
		fmt.Fprintf(os.Stderr, "kept the server %s (%s) and %s\n", dind, serverIP, workDir)
		return
	}
	if dind != "" {
		sh("docker", "rm", "-f", "-v", dind)
	}
	if workDir != "" {
		os.RemoveAll(workDir)
	}
}

// writeProject writes dockflow.yml and compose.yml for app in dir.
func writeProject(t *testing.T, dir, app, compose string) {
	os.MkdirAll(dir, 0o755)
	cfg := fmt.Sprintf("version: 1\napp: %s\nenvironments:\n  production:\n    deploy:\n      timeout: 60s\n", app)
	if err := os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte(cfg), 0o644); err != nil && t != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(compose), 0o644); err != nil && t != nil {
		t.Fatal(err)
	}
}

type result struct {
	code   int
	out    string
	events []event
}

type event struct {
	Type  string          `json:"type"`
	Level string          `json:"level"`
	Msg   string          `json:"msg"`
	Data  json.RawMessage `json:"data"`
}

func (r result) has(typ string) bool {
	for _, e := range r.events {
		if e.Type == typ {
			return true
		}
	}
	return false
}

func (r result) find(typ string) *event {
	for i := range r.events {
		if r.events[i].Type == typ {
			return &r.events[i]
		}
	}
	return nil
}

// dockflow runs the binary in dir with --json and the server's connection string.
func dockflow(t *testing.T, dir string, args ...string) result {
	return dockflowEnv(t, dir, nil, args...)
}

// dockflowEnv runs the binary with extra environment variables, as CI secrets.
func dockflowEnv(t *testing.T, dir string, env []string, args ...string) result {
	cmd := dockflowCmd(dir, args...)
	cmd.Env = append(cmd.Env, env...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return parse(cmd, out.String(), err)
}

func dockflowCmd(dir string, args ...string) *exec.Cmd {
	full := append([]string{"--json", "-y", "-C", dir, "--connection", connString}, args...)
	cmd := exec.Command(binary, full...)
	cmd.Env = append(os.Environ(), "HOME="+workDir)
	return cmd
}

func parse(cmd *exec.Cmd, out string, err error) result {
	r := result{out: out}
	if cmd.ProcessState != nil {
		r.code = cmd.ProcessState.ExitCode()
	} else if err != nil {
		r.code = -1
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for sc.Scan() {
		var e event
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Type != "" {
			r.events = append(r.events, e)
		}
	}
	return r
}

func mustSucceed(t *testing.T, r result, what string) {
	t.Helper()
	if r.code != 0 {
		t.Fatalf("%s: exit %d\n%s", what, r.code, r.out)
	}
}

// load sends requests in a loop to the switch, for a host, and counts failures.
type load struct {
	ok, failed atomic.Int64
	mu         sync.Mutex
	failures   []string
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

func startLoad(t *testing.T, host string, workers int) *load {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	l := &load{cancel: cancel}
	// a new connection per request, as a front proxy opens them: Go's client would otherwise
	// retry a request on a reused connection the server closed, hiding a dropped connection
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	for i := 0; i < workers; i++ {
		l.wg.Add(1)
		go func() {
			defer l.wg.Done()
			for ctx.Err() == nil {
				req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+serverIP+"/", nil)
				req.Host = host
				resp, err := client.Do(req)
				if ctx.Err() != nil {
					return
				}
				if err != nil {
					l.fail(err.Error())
					continue
				}
				b, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					l.fail(fmt.Sprintf("status %d from %q: %q", resp.StatusCode, resp.Header.Get("Server"), b))
					continue
				}
				l.ok.Add(1)
			}
		}()
	}
	return l
}

func (l *load) fail(msg string) {
	l.failed.Add(1)
	l.mu.Lock()
	if len(l.failures) < 20 {
		l.failures = append(l.failures, time.Now().Format("15:04:05.000")+" "+msg)
	}
	l.mu.Unlock()
}

// stop stops the load and fails the test if any request failed.
func (l *load) stop(t *testing.T) {
	t.Helper()
	l.cancel()
	l.wg.Wait()
	t.Logf("load: %d requests served, %d failed", l.ok.Load(), l.failed.Load())
	if l.ok.Load() == 0 {
		t.Fatal("load: no request was served")
	}
	if n := l.failed.Load(); n > 0 {
		t.Fatalf("load: %d requests failed: %s", n, strings.Join(l.failures, "; "))
	}
}

// waitServing waits until the switch serves host.
func waitServing(t *testing.T, host string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, "http://"+serverIP+"/", nil)
		req.Host = host
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("%s is not served", host)
}
