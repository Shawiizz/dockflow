// Package engine is the port through which Dockflow drives a server's container engine
// (ADR-0003). The Docker adapter lives in engine/docker.
package engine

import (
	"context"
	"io"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
)

// Info describes the engine of a server.
type Info struct {
	Name          string
	OS            string
	Arch          string // amd64, arm64
	EngineVersion string
	APIVersion    string
}

// Container is a container as the engine reports it.
type Container struct {
	domain.ContainerInfo
	Labels       map[string]string
	Image        string
	RestartCount int
	ExitCode     int
	OOMKilled    bool
	Error        string
}

// Filter selects containers by label; an empty value matches any value of the label.
type Filter struct {
	Labels map[string]string
	// All includes stopped containers.
	All bool
}

// Engine drives one server's containers, networks, volumes and images.
type Engine interface {
	Info(ctx context.Context) (Info, error)

	Containers(ctx context.Context, f Filter) ([]Container, error)
	Inspect(ctx context.Context, id string) (Container, error)
	Create(ctx context.Context, name string, spec domain.ContainerSpec, labels map[string]string) (string, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, grace *time.Duration) error
	Remove(ctx context.Context, id string) error
	Kill(ctx context.Context, id, signal string) error
	Rename(ctx context.Context, id, name string) error
	// Attach connects to a created container's stdin, stdout and stderr, before it starts.
	Attach(ctx context.Context, id string) (*Attached, error)
	// Wait returns the container's exit code once it stops.
	Wait(ctx context.Context, id string) (int, error)
	// Logs streams the container's stdout, and stderr when asked, from the start, following it
	// while it runs.
	Logs(ctx context.Context, id string, follow, stderr bool) (io.ReadCloser, error)
	// WaitHealthy returns once the container is healthy, or, without a healthcheck, once it has
	// been running for grace. It fails when the container exits, becomes unhealthy, restarts in a
	// loop, or when timeout passes.
	WaitHealthy(ctx context.Context, id string, grace, timeout time.Duration) error

	Networks(ctx context.Context) (map[string]bool, error)
	CreateNetwork(ctx context.Context, n domain.Network, project string) error
	Connect(ctx context.Context, network, container string, aliases []string) error
	Disconnect(ctx context.Context, network, container string) error

	Volumes(ctx context.Context) (map[string]bool, error)
	CreateVolume(ctx context.Context, v domain.Volume, project string) error

	// ResolveImage makes the image available according to Compose's pull_policy (missing,
	// always, never) and returns a reference pinned to its content. auth, when set, is used to
	// pull from its registry.
	ResolveImage(ctx context.Context, ref, policy string, auth *RegistryAuth) (string, error)
	// ImportImage creates an image from a filesystem tar (the agent image, ADR-0004).
	ImportImage(ctx context.Context, tar io.Reader, ref string, changes []string) error
	HasImage(ctx context.Context, ref string) (bool, error)
	RemoveImage(ctx context.Context, ref string) error
}

// RegistryAuth are the credentials of a registry.
type RegistryAuth struct {
	Server   string `json:"server"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// Attached is an attached container: its stdin, and its stdout and stderr, demultiplexed.
type Attached struct {
	// Stdin closes the container's stdin when closed.
	Stdin  io.WriteCloser
	Stdout io.Reader
	Stderr io.Reader
	Close  func()
}

// HealthError is why a container did not become healthy.
type HealthError struct {
	Container string
	// Kind is crash_loop, exited, unhealthy or timeout (service.failed's reason).
	Kind   string
	Reason string
}

func (e *HealthError) Error() string { return e.Container + ": " + e.Reason }
