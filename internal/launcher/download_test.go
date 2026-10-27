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
	"testing"

	"github.com/Shawiizz/dockflow/internal/errs"
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

func TestDownload(t *testing.T) {
	bin := "#!agent"
	srv := release(t, bin, sum("other")+"  dockflow-linux-amd64\n"+sum(bin)+"  dockflow-linux-arm64\n")
	path := filepath.Join(t.TempDir(), "cache", "dockflow-linux-arm64")
	if err := Download(context.Background(), srv.Client(), srv.URL+"/v9.9.9/", "dockflow-linux-arm64", path); err != nil {
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
	err := Download(context.Background(), srv.Client(), srv.URL+"/v9.9.9/", "dockflow-linux-arm64", path)
	if errs.CodeOf(err) != "agent.checksum_mismatch" {
		t.Fatalf("got %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("nothing may stay in the cache: %v", entries)
	}
}

func TestDownloadUnlisted(t *testing.T) {
	srv := release(t, "x", sum("x")+"  dockflow-linux-amd64\n")
	err := Download(context.Background(), srv.Client(), srv.URL+"/v9.9.9/", "dockflow-linux-arm64", filepath.Join(t.TempDir(), "b"))
	if errs.CodeOf(err) != "agent.download_failed" {
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
