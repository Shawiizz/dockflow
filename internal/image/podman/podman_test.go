package podman_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/image"
	"github.com/Shawiizz/dockflow/internal/image/oci"
	"github.com/Shawiizz/dockflow/internal/image/podman"
)

func TestBuildArgs(t *testing.T) {
	b := image.Build{
		Service: "web", Context: "/src/web", Dockerfile: "docker/Dockerfile",
		Args: map[string]string{"B": "2", "A": "1"}, Labels: map[string]string{"team": "shop"},
		AdditionalContexts: map[string]string{"base": "/src/base"}, Target: "prod", NoCache: true,
		ExtraHosts: []string{"db:10.0.0.2"}, ShmSize: 1 << 20,
	}
	got := podman.BuildArgs(b, "linux/arm64", "/tmp/web.iid", "")
	want := []string{
		"build", "--platform", "linux/arm64", "--iidfile", "/tmp/web.iid", "-t", "localhost/dockflow-build/web",
		"-f", "/src/web/docker/Dockerfile", "--build-arg", "A=1", "--build-arg", "B=2", "--label", "team=shop",
		"--build-context", "base=/src/base", "--target", "prod", "--no-cache", "--add-host", "db:10.0.0.2",
		"--shm-size", "1048576b", "/src/web",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	inline := podman.BuildArgs(image.Build{Service: "x", Context: "/c", Dockerfile: "ignored"}, "linux/amd64", "i", "/tmp/x.Dockerfile")
	if inline[7] != "-f" || inline[8] != "/tmp/x.Dockerfile" {
		t.Fatalf("an inline Dockerfile must be the one used: %q", inline)
	}
}

// Contract test: a real podman build exported as an OCI layout. Skipped without Podman.
// DOCKFLOW_PODMAN_ARGS adds global podman flags (--storage-driver vfs in a container).
func TestBuild(t *testing.T) {
	if err := exec.Command("podman", "version").Run(); err != nil {
		if os.Getenv("DOCKFLOW_CONTRACT") != "" && os.Getenv("DOCKFLOW_PODMAN") != "" {
			t.Fatal("podman is required")
		}
		t.Skip("no podman")
	}
	ctxDir, _ := filepath.Abs("../oci/testdata/app")
	dir := t.TempDir()
	p := &podman.Builder{Args: strings.Fields(os.Getenv("DOCKFLOW_PODMAN_ARGS"))}
	var lines []string
	built, err := p.Build(context.Background(), []image.Build{{
		Service: "web", Context: ctxDir, Dockerfile: "Dockerfile", Args: map[string]string{"MSG": "hello"},
		Labels: map[string]string{"dockflow.test": "yes"},
	}}, "linux/amd64", dir, func(svc, line string) {
		if svc == "web" {
			lines = append(lines, line)
		}
	})
	if err != nil {
		t.Fatalf("%v\n%s", err, strings.Join(lines, "\n"))
	}
	if len(lines) == 0 {
		t.Fatal("no build output was attributed to the service")
	}
	img, err := oci.Image(built[0].Layout)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := img.ConfigFile()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Config.Labels["dockflow.test"] != "yes" {
		t.Fatalf("the labels must reach the image: %v", cfg.Config.Labels)
	}
}
