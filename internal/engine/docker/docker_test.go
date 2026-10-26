package docker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
)

// Contract tests: they run against the Docker Engine of DOCKER_HOST, and are skipped without one.

const testImage = "mirror.gcr.io/library/alpine:3"

func newEngine(t *testing.T) *Engine {
	t.Helper()
	e, err := New(nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := e.Info(ctx); err != nil {
		if os.Getenv("DOCKFLOW_CONTRACT") != "" {
			t.Fatalf("Docker is required: %v", err)
		}
		t.Skipf("no Docker Engine: %v", err)
	}
	t.Cleanup(func() { e.Close() })
	return e
}

func project(t *testing.T) string {
	return strings.ToLower(fmt.Sprintf("dftest-%s-%d", strings.ReplaceAll(t.Name(), "/", "-"), time.Now().UnixNano()%100000))
}

func cleanup(t *testing.T, e *Engine, project string) {
	t.Cleanup(func() {
		ctx := context.Background()
		cs, _ := e.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelProject: project}})
		for _, c := range cs {
			e.Remove(ctx, c.ID)
		}
		e.c.NetworkRemove(ctx, project+"_default", client.NetworkRemoveOptions{})
	})
}

func TestCreateRunAndList(t *testing.T) {
	e := newEngine(t)
	ctx := context.Background()
	p := project(t)
	cleanup(t, e, p)

	img, err := e.ResolveImage(ctx, testImage, "missing", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(img, "@sha256:") && !strings.HasPrefix(img, "sha256:") {
		t.Fatalf("the image must be pinned, got %s", img)
	}
	net := domain.Network{Key: "default", Name: p + "_default"}
	if err := e.CreateNetwork(ctx, net, p); err != nil {
		t.Fatal(err)
	}
	if err := e.CreateNetwork(ctx, net, p); err != nil {
		t.Fatalf("creating an existing network must succeed: %v", err)
	}
	nets, _ := e.Networks(ctx)
	if nets[net.Name] != p {
		t.Fatalf("the network must be listed with its project %q: %q", p, nets[net.Name])
	}

	spec := domain.ContainerSpec{
		Image: img, Command: []string{"sleep", "300"}, Env: []string{"A=1"}, Restart: "unless-stopped",
		Networks:  []domain.Attachment{{Network: net.Name, Aliases: []string{"web"}}},
		Ports:     []domain.Port{{HostIP: "127.0.0.1", ContainerPort: 80, Protocol: "tcp"}},
		Mounts:    []domain.Mount{{Type: "tmpfs", Target: "/scratch", TmpfsSize: 1 << 20}},
		Resources: domain.Resources{MemoryLimit: 64 << 20},
	}
	labels := map[string]string{domain.LabelProject: p, domain.LabelService: "web", domain.LabelRelease: "3", domain.LabelHash: "abc"}
	id, err := e.Create(ctx, p+"-web-3-1", spec, labels)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := e.WaitHealthy(ctx, id, time.Second, 30*time.Second); err != nil {
		t.Fatalf("a running container without healthcheck is healthy after the grace: %v", err)
	}
	cs, err := e.Containers(ctx, engine.Filter{Labels: map[string]string{domain.LabelProject: p}})
	if err != nil || len(cs) != 1 {
		t.Fatalf("list: %v %v", cs, err)
	}
	c := cs[0]
	if c.Service != "web" || c.Release != 3 || c.Hash != "abc" || c.State != "running" || c.Name != p+"-web-3-1" {
		t.Fatalf("labels not read back: %+v", c)
	}
	grace := time.Second
	if err := e.Stop(ctx, id, &grace); err != nil {
		t.Fatal(err)
	}
	if err := e.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := e.Remove(ctx, id); err != nil {
		t.Fatalf("removing a removed container must succeed: %v", err)
	}
}

func TestWaitHealthyFailures(t *testing.T) {
	e := newEngine(t)
	ctx := context.Background()
	p := project(t)
	cleanup(t, e, p)
	img, err := e.ResolveImage(ctx, testImage, "missing", nil)
	if err != nil {
		t.Fatal(err)
	}
	labels := map[string]string{domain.LabelProject: p}
	interval := domain.Duration(200 * time.Millisecond)
	retries := uint64(2)

	cases := []struct {
		name string
		spec domain.ContainerSpec
		want string
	}{
		{"exits", domain.ContainerSpec{Image: img, Command: []string{"sh", "-c", "exit 3"}, Restart: "no"}, "code 3"},
		{"crashloop", domain.ContainerSpec{Image: img, Command: []string{"sh", "-c", "exit 1"}, Restart: "always"}, "restarted"},
		{"unhealthy", domain.ContainerSpec{Image: img, Command: []string{"sleep", "300"}, Restart: "no",
			Healthcheck: &domain.Healthcheck{Test: []string{"CMD", "false"}, Interval: &interval, Retries: &retries}}, "unhealthy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id, err := e.Create(ctx, p+"-"+tc.name, tc.spec, labels)
			if err != nil {
				t.Fatal(err)
			}
			if err := e.Start(ctx, id); err != nil {
				t.Fatal(err)
			}
			err = e.WaitHealthy(ctx, id, 30*time.Second, 60*time.Second)
			var he *engine.HealthError
			if !errors.As(err, &he) || !strings.Contains(he.Reason, tc.want) {
				t.Fatalf("want a health error with %q, got %v", tc.want, err)
			}
		})
	}

	ok := domain.ContainerSpec{Image: img, Command: []string{"sleep", "300"}, Restart: "no",
		Healthcheck: &domain.Healthcheck{Test: []string{"CMD", "true"}, Interval: &interval}}
	id, _ := e.Create(ctx, p+"-healthy", ok, labels)
	e.Start(ctx, id)
	if err := e.WaitHealthy(ctx, id, time.Hour, 60*time.Second); err != nil {
		t.Fatalf("healthy must return before the grace: %v", err)
	}
}

func TestPin(t *testing.T) {
	d := "sha256:" + strings.Repeat("a", 64)
	if got := pin("alpine:3", "sha256:id", []string{"alpine@" + d}); got != "alpine:3@"+d {
		t.Fatalf("got %s", got)
	}
	if got := pin("localbuilt:1", "sha256:id", nil); got != "sha256:id" {
		t.Fatalf("got %s", got)
	}
	if got := pin("alpine@"+d, "sha256:id", nil); got != "alpine@"+d {
		t.Fatalf("got %s", got)
	}
}
