package oci_test

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Shawiizz/dockflow/internal/image"
	"github.com/Shawiizz/dockflow/internal/image/buildx"
	"github.com/Shawiizz/dockflow/internal/image/oci"
)

// Contract test: a real buildx bake and a real distribution registry. Skipped without Docker.

func docker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestBuildAndPush(t *testing.T) {
	if err := exec.Command("docker", "buildx", "version").Run(); err != nil {
		if os.Getenv("DOCKFLOW_CONTRACT") != "" {
			t.Fatal("docker buildx is required")
		}
		t.Skip("no docker buildx")
	}
	name := fmt.Sprintf("dockflow-registry-test-%d", time.Now().UnixNano()%100000)
	docker(t, "run", "-d", "--name", name, "-p", "127.0.0.1::5000", "mirror.gcr.io/library/registry:3")
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", "-v", name).Run() })
	port := docker(t, "port", name, "5000/tcp")
	addr := strings.TrimSpace(strings.Split(port, "\n")[0])

	ctx := context.Background()
	ctxDir, _ := filepath.Abs("testdata/app")
	dir := t.TempDir()
	var lines []string
	built, err := (&buildx.Builder{}).Build(ctx, []image.Build{{
		Service: "web", Context: ctxDir, Dockerfile: "Dockerfile", Args: map[string]string{"MSG": "hello"},
	}}, "linux/amd64", dir, func(svc, line string) {
		if svc == "web" {
			lines = append(lines, line)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) == 0 {
		t.Fatal("no build output was attributed to the service")
	}

	// the registry is reached through a dialer, as through the SSH tunnel
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}
	p := &oci.Pusher{Dial: dial}
	dest := image.Destination{Repository: "127.0.0.1:5959/shop/web", Tags: []string{"v1", "production-latest"}, Insecure: true}
	first, err := p.Push(ctx, built[0], dest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(first.Ref, "127.0.0.1:5959/shop/web@sha256:") || first.BlobsSent == 0 {
		t.Fatalf("first push: %+v", first)
	}
	again, err := p.Push(ctx, built[0], dest)
	if err != nil {
		t.Fatal(err)
	}
	if again.Digest != first.Digest || again.BlobsSent != 0 || again.BlobsSkipped == 0 {
		t.Fatalf("a second push must send nothing: %+v", again)
	}
}
