package launcher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sync/atomic"
	"testing"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/version"
)

func release(t *testing.T, bin, sums string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v9.9.9/SHA256SUMS":
			w.Write([]byte(sums))
		case "/v9.9.9/dockflow-linux-arm64":
			w.Write([]byte(bin))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// The cached agent binary is checked again at every use, and downloaded again when it changed.
func TestCachedAgentCheckedAgain(t *testing.T) {
	arch := "arm64"
	if runtime.GOARCH == "arm64" {
		arch = "amd64"
	}
	if version.AgentSum(arch) != "" {
		t.Skip("built with the agents' checksums")
	}
	name := "dockflow-agent-linux-" + arch
	bin := "#!genuine agent"
	var downloads atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v9.9.9/SHA256SUMS":
			w.Write([]byte(sum(bin) + "  " + name + "\n"))
		case "/v9.9.9/" + name:
			downloads.Add(1)
			w.Write([]byte(bin))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("DOCKFLOW_AGENT_BINARY", "")
	t.Setenv("DOCKFLOW_RELEASES_URL", srv.URL)
	var c events.Collector
	l := &Launcher{Version: "9.9.9", Events: events.NewEmitter("r", &c, nil)}

	path, err := l.agentBinary(context.Background(), arch)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.agentBinary(context.Background(), arch); err != nil || downloads.Load() != 1 {
		t.Fatalf("an intact cache is used as it is: %v, %d downloads", err, downloads.Load())
	}
	if err := os.WriteFile(path, []byte("#!substituted"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := l.agentBinary(context.Background(), arch); err != nil || downloads.Load() != 2 {
		t.Fatalf("a changed cache is downloaded again: %v, %d downloads", err, downloads.Load())
	}
	if b, _ := os.ReadFile(path); string(b) != bin {
		t.Fatalf("the cache holds %q", b)
	}
	if !slices.Contains(c.Types(), events.Warning) {
		t.Fatalf("the mismatch must be reported: %v", c.Types())
	}
}

func TestDownload(t *testing.T) {
	bin := "#!agent"
	srv := release(t, bin, sum("other")+"  dockflow-linux-amd64\n"+sum(bin)+"  dockflow-linux-arm64\n")
	path := filepath.Join(t.TempDir(), "cache", "dockflow-linux-arm64")
	if err := Download(context.Background(), srv.Client(), srv.URL+"/v9.9.9/", "dockflow-linux-arm64", "", path); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != bin {
		t.Fatalf("cached %q, %v", got, err)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("the binary must be executable: %v", fi.Mode())
	}
}

func TestDownloadRefusesAMismatch(t *testing.T) {
	srv := release(t, "tampered", sum("genuine")+"  dockflow-linux-arm64\n")
	dir := t.TempDir()
	path := filepath.Join(dir, "dockflow-linux-arm64")
	err := Download(context.Background(), srv.Client(), srv.URL+"/v9.9.9/", "dockflow-linux-arm64", "", path)
	if errs.CodeOf(err) != "agent.checksum_mismatch" {
		t.Fatalf("got %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("nothing may stay in the cache: %v", entries)
	}
}

func TestDownloadUnlisted(t *testing.T) {
	srv := release(t, "x", sum("x")+"  dockflow-linux-amd64\n")
	err := Download(context.Background(), srv.Client(), srv.URL+"/v9.9.9/", "dockflow-linux-arm64", "", filepath.Join(t.TempDir(), "b"))
	if errs.CodeOf(err) != "agent.download_failed" {
		t.Fatalf("got %v", err)
	}
}

// A checksum built into the CLI replaces the release's: SHA256SUMS is not even read.
func TestDownloadBuiltInChecksum(t *testing.T) {
	bin := "#!agent"
	srv := release(t, bin, sum("anything")+"  dockflow-linux-arm64\n")
	path := filepath.Join(t.TempDir(), "dockflow-linux-arm64")
	if err := Download(context.Background(), srv.Client(), srv.URL+"/v9.9.9/", "dockflow-linux-arm64", sum(bin), path); err != nil {
		t.Fatal(err)
	}
	err := Download(context.Background(), srv.Client(), srv.URL+"/v9.9.9/", "dockflow-linux-arm64", sum("genuine"), filepath.Join(t.TempDir(), "b"))
	if errs.CodeOf(err) != "agent.checksum_mismatch" {
		t.Fatalf("got %v", err)
	}
}

func TestStatic(t *testing.T) {
	dir := t.TempDir()
	for name, cgo := range map[string]string{"static": "0", "dynamic": "1"} {
		out := filepath.Join(dir, name)
		cmd := exec.Command("go", "build", "-o", out, "./testdata/hello")
		cmd.Env = append(os.Environ(), "CGO_ENABLED="+cgo)
		if b, err := cmd.CombinedOutput(); err != nil {
			if cgo == "1" {
				t.Logf("no cgo build here: %s", b)
				continue
			}
			t.Fatalf("%v: %s", err, b)
		}
		if got := static(out); got != (cgo == "0") {
			t.Errorf("%s: static = %v", name, got)
		}
	}
}
