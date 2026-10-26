package buildx_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Shawiizz/dockflow/internal/image"
	"github.com/Shawiizz/dockflow/internal/image/buildx"
)

// Contract test: bake loads the image into the daemon DOCKER_HOST names, as remote builds do.
// Skipped without Docker.
func TestLoad(t *testing.T) {
	if err := exec.Command("docker", "buildx", "version").Run(); err != nil {
		if os.Getenv("DOCKFLOW_CONTRACT") != "" {
			t.Fatal("docker buildx is required")
		}
		t.Skip("no docker buildx")
	}
	host := os.Getenv("DOCKER_HOST")
	if host == "" {
		host = "unix:///var/run/docker.sock"
	}
	name := fmt.Sprintf("dockflow-load-test/web:%d", time.Now().UnixNano()%100000)
	extra := name + "-extra"
	t.Cleanup(func() { exec.Command("docker", "rmi", "-f", name, extra).Run() })
	ctxDir, _ := filepath.Abs("../oci/testdata/app")
	bx := &buildx.Builder{
		Env:  []string{"DOCKER_HOST=" + host},
		Load: func(string) []string { return []string{name, extra} },
	}
	built, err := bx.Build(context.Background(), []image.Build{{
		Service: "web", Context: ctxDir, Dockerfile: "Dockerfile", Args: map[string]string{"MSG": "loaded"},
	}}, "linux/amd64", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if built[0].Image != name || built[0].Layout != "" {
		t.Fatalf("got %+v", built[0])
	}
	for _, ref := range []string{name, extra} {
		if out, err := exec.Command("docker", "image", "inspect", ref).CombinedOutput(); err != nil {
			t.Fatalf("%s is not in the daemon: %s", ref, out)
		}
	}
	out, _ := exec.Command("docker", "run", "--rm", name).CombinedOutput()
	if strings.TrimSpace(string(out)) != "loaded" {
		t.Fatalf("the image runs %q", out)
	}
}
