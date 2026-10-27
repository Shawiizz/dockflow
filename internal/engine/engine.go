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
	// HealthLog is the output of the last health check, from Inspect.
	HealthLog     string
	FailingStreak int
	// IPs are the container's addresses per network, from Inspect.
	IPs map[string]string
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
	// Attach connects to a created container's stdin, stdout and stderr, before it starts. With
	// tty, the output is the terminal's, in Stdout.
	Attach(ctx context.Context, id string, tty bool) (*Attached, error)
	// Resize sets the terminal size of a container started with a TTY.
	Resize(ctx context.Context, id string, width, height uint) error
	// Exec runs a command in a running container.
	Exec(ctx context.Context, id string, o ExecOptions) (*Exec, error)
	// CopyTo extracts a tar archive into dir in the container; CopyFrom returns path as a tar.
	CopyTo(ctx context.Context, id, dir string, tar io.Reader) error
	CopyFrom(ctx context.Context, id, path string) (io.ReadCloser, error)
	// Images lists the images of the server.
	Images(ctx context.Context) ([]Image, error)
	// Wait returns the container's exit code once it stops.
	Wait(ctx context.Context, id string) (int, error)
	// Logs streams the container's output.
	Logs(ctx context.Context, id string, o LogOptions) (io.ReadCloser, error)
	// WaitHealthy returns once the container is healthy, or, without a healthcheck, once it has
	// been running for grace. It fails when the container exits, becomes unhealthy, restarts in a
	// loop, or when timeout passes.
	WaitHealthy(ctx context.Context, id string, grace, timeout time.Duration) error

	Networks(ctx context.Context) (map[string]string, error)
	CreateNetwork(ctx context.Context, n domain.Network, project string) error
	Connect(ctx context.Context, network, container string, aliases []string) error
	Disconnect(ctx context.Context, network, container string) error

	RemoveNetwork(ctx context.Context, name string) error
	// LabeledNetworks lists the networks that carry label, with the containers attached.
	LabeledNetworks(ctx context.Context, label string) ([]NetworkInfo, error)
	// PruneNetworks removes the unused networks Dockflow does not manage.
	PruneNetworks(ctx context.Context) ([]string, error)

	Volumes(ctx context.Context) (map[string]bool, error)
	CreateVolume(ctx context.Context, v domain.Volume, project string) error
	RemoveVolume(ctx context.Context, name string) error
	// PruneVolumes removes the unused anonymous volumes Dockflow does not manage.
	PruneVolumes(ctx context.Context) ([]string, error)

	// ResolveImage makes the image available according to Compose's pull_policy (missing,
	// always, never) and returns a reference pinned to its content. auth, when set, is used to
	// pull from its registry.
	ResolveImage(ctx context.Context, ref, policy string, auth *RegistryAuth) (string, error)
	// ImportImage creates an image from a filesystem tar (the agent image, ADR-0004).
	ImportImage(ctx context.Context, tar io.Reader, ref string, changes []string) error
	HasImage(ctx context.Context, ref string) (bool, error)
	// InspectImage returns the image ref names.
	InspectImage(ctx context.Context, ref string) (Image, error)
	// TagImage gives the image ref names a further name.
	TagImage(ctx context.Context, ref, name string) error
	// PushImage pushes the image ref names to its registry (images built on the server).
	PushImage(ctx context.Context, ref string, auth *RegistryAuth) error
	RemoveImage(ctx context.Context, ref string) error

	// Plugins lists the managed plugins (ADR-0018).
	Plugins(ctx context.Context) ([]Plugin, error)
	// InstallPlugin pulls the plugin ref under the local name alias, grants the privileges it
	// asks for, sets its settings (key=value) and enables it. It returns the privileges granted.
	InstallPlugin(ctx context.Context, ref, alias string, settings []string, auth *RegistryAuth) ([]string, error)
	// RemovePlugin disables and removes a plugin; it fails while volumes use it.
	RemovePlugin(ctx context.Context, name string) error
}

// NetworkInfo is a network and the names of the containers attached to it.
type NetworkInfo struct {
	Name       string            `json:"name"`
	Labels     map[string]string `json:"-"`
	Containers []string          `json:"containers"`
}

// Plugin is a managed plugin of the engine.
type Plugin struct {
	Name      string   `json:"name"`
	Reference string   `json:"reference"`
	Enabled   bool     `json:"enabled"`
	Types     []string `json:"types"`
	// Settings are the names of its settings, never their values.
	Settings []string `json:"settings,omitempty"`
}

// LogOptions select a container's output.
type LogOptions struct {
	Follow bool
	// Stderr includes the standard error, interleaved with the output.
	Stderr     bool
	Tail       string // a number of lines, or all
	Since      string // a timestamp or a duration
	Timestamps bool
}

// ExecOptions are a command to run in a running container.
type ExecOptions struct {
	Cmd        []string
	Env        []string
	User       string
	WorkingDir string
	TTY        bool
	Stdin      bool
	Width      uint
	Height     uint
}

// Exec is a running command: its streams, its terminal and its exit code.
type Exec struct {
	Attached
	Resize func(ctx context.Context, width, height uint) error
	// Wait returns the exit code once the command has ended.
	Wait func(ctx context.Context) (int, error)
}

// Image is an image of the server.
type Image struct {
	ID      string
	Tags    []string
	Digests []string
	Size    int64
	Created int64
	// Containers is how many containers use it, or -1 when unknown.
	Containers int64
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
