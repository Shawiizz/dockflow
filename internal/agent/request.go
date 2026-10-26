// Package agent is what runs on the server, inside an ephemeral container (ADR-0004): it takes
// the lock, reads the actual state, plans, rolls out and records releases. It reads one Request
// on stdin and writes events on stdout.
package agent

import (
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
)

// Operations.
const (
	OpPlan        = "plan"
	OpDeploy      = "deploy"
	OpRollback    = "rollback"
	OpStatus      = "status"
	OpReleases    = "releases"
	OpLockAcquire = "lock.acquire"
	OpLockRelease = "lock.release"
	OpLockStatus  = "lock.status"
	OpServerInit  = "server.init"
)

// Request is the agent's input. Secret values reach the agent only here, on stdin, never in its
// environment or command line.
type Request struct {
	Op     string        `json:"op"`
	Run    string        `json:"run"`
	App    string        `json:"app,omitempty"`
	Env    string        `json:"env,omitempty"`
	Stack  string        `json:"stack,omitempty"`
	Server string        `json:"server,omitempty"`
	Author domain.Author `json:"author"`

	// Desired is the app to deploy (plan, deploy).
	Desired         *domain.App   `json:"desired,omitempty"`
	Version         string        `json:"version,omitempty"`
	Source          domain.Source `json:"source"`
	DockflowVersion string        `json:"dockflow_version"`

	Keep      int             `json:"keep,omitempty"`
	OnFailure string          `json:"on_failure,omitempty"`
	Timeout   domain.Duration `json:"timeout,omitempty"`
	// Fingerprint, when set, is the plan the deploy must apply: it fails if the plan changed.
	Fingerprint string `json:"fingerprint,omitempty"`
	// Force runs despite a manual lock.
	Force bool `json:"force,omitempty"`
	// WaitLock is how long to wait for another run's lock.
	WaitLock domain.Duration `json:"wait_lock,omitempty"`
	// NoRollback leaves a failed run in place.
	NoRollback bool `json:"no_rollback,omitempty"`

	// Target is the release to roll back to; 0 means the previous one.
	Target int `json:"target,omitempty"`

	// Lock describes a manual lock (lock.acquire).
	Lock *domain.LockInfo `json:"lock,omitempty"`

	// Edge and SwitchImage configure the server (server.init).
	Edge           string   `json:"edge,omitempty"`
	SwitchImage    string   `json:"switch_image,omitempty"`
	SwitchListen   string   `json:"switch_listen,omitempty"`
	TrustedProxies []string `json:"trusted_proxies,omitempty"`

	// RegistryAuth are the credentials of the external registry, when the app uses one.
	RegistryAuth *engine.RegistryAuth `json:"registry_auth,omitempty"`
	// Registry installs the server-local registry (server.init); RegistryImage is its image.
	Registry      bool   `json:"registry,omitempty"`
	RegistryImage string `json:"registry_image,omitempty"`

	// Mask lists the secret values to mask in every event.
	Mask []string `json:"mask,omitempty"`
}

// Status is the result of the status operation.
type Status struct {
	App      string            `json:"app"`
	Env      string            `json:"env"`
	State    *domain.EnvRecord `json:"state,omitempty"`
	Current  *ReleaseSummary   `json:"current,omitempty"`
	Services []ServiceStatus   `json:"services"`
	Lock     *domain.LockInfo  `json:"manual_lock,omitempty"`
}

// ServiceStatus is one service in status.
type ServiceStatus struct {
	Name       string                 `json:"name"`
	Strategy   domain.Strategy        `json:"strategy,omitempty"`
	Release    int                    `json:"release"`
	Desired    int                    `json:"desired"`
	Running    int                    `json:"running"`
	Containers []domain.ContainerInfo `json:"containers"`
	Domains    []string               `json:"domains,omitempty"`
}

// ReleaseSummary is a release without its desired state.
type ReleaseSummary struct {
	Seq        int                  `json:"seq"`
	Version    string               `json:"version"`
	Status     string               `json:"status"`
	Run        string               `json:"run"`
	CreatedAt  string               `json:"created_at"`
	FinishedAt string               `json:"finished_at,omitempty"`
	CreatedBy  domain.Author        `json:"created_by"`
	Source     domain.Source        `json:"source"`
	RollbackOf int                  `json:"rollback_of,omitempty"`
	Services   map[string]string    `json:"services"` // service → image
	Error      *domain.ReleaseError `json:"error,omitempty"`
}

// Summarise returns the summary of a release.
func Summarise(r *domain.Release) ReleaseSummary {
	s := ReleaseSummary{
		Seq: r.Seq, Version: r.Version, Status: r.Status, Run: r.Run,
		CreatedAt: r.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"), CreatedBy: r.CreatedBy,
		Source: r.Source, RollbackOf: r.RollbackOf, Error: r.Error, Services: map[string]string{},
	}
	if r.FinishedAt != nil {
		s.FinishedAt = r.FinishedAt.UTC().Format("2006-01-02T15:04:05Z")
	}
	for _, svc := range r.Desired.Services {
		s.Services[svc.Name] = svc.Spec.Image
	}
	return s
}
