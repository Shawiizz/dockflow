// Package agent is what runs on the server, inside an ephemeral container (ADR-0004): it takes
// the lock, reads the actual state, plans, rolls out and records releases. It reads one Request
// on stdin and writes events on stdout.
package agent

import (
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/state"
	"github.com/Shawiizz/dockflow/internal/upload"
)

// PruneRequest selects the unused Docker objects prune removes.
type PruneRequest struct {
	Containers bool `json:"containers"`
	Images     bool `json:"images"`
	// AllImages removes every unused image, not only untagged ones; images of releases in
	// retention are always kept.
	AllImages bool `json:"all_images"`
	Volumes   bool `json:"volumes"`
	Networks  bool `json:"networks"`
	// Registry runs the server-local registry's garbage collection.
	Registry bool `json:"registry"`
}

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
	OpRestart     = "restart"
	OpStop        = "stop"
	OpScale       = "scale"
	OpDestroy     = "destroy"
	OpPrune       = "prune"
	OpDetails     = "details"
	OpUploadHave  = "upload.have"
	OpRevoke      = "secrets.revoke"
	// Server-wide operations (ADR-0018).
	OpNetworkCreate = "server.network.create"
	OpNetworkList   = "server.network.list"
	OpNetworkRemove = "server.network.remove"
	OpPluginInstall = "server.plugin.install"
	OpPluginList    = "server.plugin.list"
	OpPluginRemove  = "server.plugin.remove"
	// OpCloudflareRefresh is run by the weekly timer of provisioning (ADR-0014).
	OpCloudflareRefresh = "server.cloudflare.refresh"
	OpServerStatus      = "server.status"
	OpServerCheck       = "server.check"
	OpServerUninstall   = "server.uninstall"
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
	// Manifests are the upload manifests of Desired, by digest; Blobs is how many files follow
	// the request on stdin, as a tar of blobs named by their sha256.
	Manifests map[string]upload.Manifest `json:"manifests,omitempty"`
	Blobs     int                        `json:"blobs,omitempty"`
	// Have lists blobs whose presence on the server is asked (upload.have).
	Have []string `json:"have,omitempty"`
	// AgentImage is the agent's own image, which helper containers run.
	AgentImage string `json:"agent_image,omitempty"`
	// Hooks are the exec hooks, with their environments.
	Hooks []domain.Hook `json:"hooks,omitempty"`
	// Endpoints are the public checks, run StartupDelay after the switch.
	Endpoints    []domain.Endpoint `json:"endpoints,omitempty"`
	StartupDelay domain.Duration   `json:"startup_delay,omitempty"`
	// Fingerprint, when set, is the plan the deploy must apply: it fails if the plan changed.
	Fingerprint string `json:"fingerprint,omitempty"`
	// Force runs despite a manual lock.
	Force bool `json:"force,omitempty"`
	// WaitLock is how long to wait for another run's lock.
	WaitLock domain.Duration `json:"wait_lock,omitempty"`
	// NoRollback leaves a failed run in place.
	NoRollback bool `json:"no_rollback,omitempty"`

	// Only limits plan and deploy to these services: the others stay as the current release has
	// them.
	Only []string `json:"only,omitempty"`

	// Target is the release to roll back to; 0 means the previous one, or the newest release of
	// TargetVersion when it is set.
	Target        int    `json:"target,omitempty"`
	TargetVersion string `json:"target_version,omitempty"`
	// Services are the services restart, stop, scale, destroy and rollback act on; none means
	// all.
	Services []string `json:"services,omitempty"`
	// Name is the Compose secret secrets.revoke removes the old files of, the shared network of
	// server.network.*, or the plugin of server.plugin.*.
	Name string `json:"name,omitempty"`
	// Alias and Settings are a plugin's local name and its key=value settings.
	Alias    string   `json:"alias,omitempty"`
	Settings []string `json:"settings,omitempty"`
	// Replicas is scale's count.
	Replicas int `json:"replicas,omitempty"`
	// Volumes also deletes the app's volumes (destroy).
	Volumes bool `json:"volumes,omitempty"`
	// Prune selects what prune removes.
	Prune *PruneRequest `json:"prune,omitempty"`

	// Lock describes a manual lock (lock.acquire).
	Lock *domain.LockInfo `json:"lock,omitempty"`

	// PortFilter and Watchdog turn the published-port filter (ADR-0014) and the watchdog
	// (ADR-0010) on or off; nil keeps what the server has, on for a new server. SSHPort is the
	// port the filter lets SSH in on (server.init).
	PortFilter *bool `json:"port_filter,omitempty"`
	Watchdog   *bool `json:"watchdog,omitempty"`
	SSHPort    int   `json:"ssh_port,omitempty"`
	// Edge and SwitchImage configure the server (server.init); empty keeps what the server has.
	Edge           string   `json:"edge,omitempty"`
	SwitchImage    string   `json:"switch_image,omitempty"`
	SwitchListen   string   `json:"switch_listen,omitempty"`
	TrustedProxies []string `json:"trusted_proxies,omitempty"`
	// ACMEEmail is the address the certificate authority writes to about the switch's
	// certificates (server.init); nil keeps the server's, "" removes it.
	ACMEEmail *string `json:"acme_email,omitempty"`
	// ACMECA is the ACME directory the switch gets its certificates from (server.init); nil
	// keeps the server's, "" goes back to Let's Encrypt, then ZeroSSL.
	ACMECA *string `json:"acme_ca,omitempty"`

	// RegistryAuth are the credentials of the external registry, when the app uses one.
	RegistryAuth *engine.RegistryAuth `json:"registry_auth,omitempty"`
	// Registry installs or removes the server-local registry (server.init), nil keeping what the
	// server has; RegistryImage is its image.
	Registry      *bool  `json:"registry,omitempty"`
	RegistryImage string `json:"registry_image,omitempty"`
	// Upgrade pulls the server's images again by their names (server upgrade).
	Upgrade bool `json:"upgrade,omitempty"`

	// Mask lists the secret values to mask in every event.
	Mask []string `json:"mask,omitempty"`
	// Files are the contents of the Compose secrets and configs, by server path: written when
	// missing, never recorded.
	Files map[string]string `json:"files,omitempty"`
}

// Status is the result of the status operation.
type Status struct {
	App      string            `json:"app"`
	Env      string            `json:"env"`
	State    *domain.EnvRecord `json:"state,omitempty"`
	Current  *ReleaseSummary   `json:"current,omitempty"`
	Services []ServiceStatus   `json:"services"`
	Lock     *domain.LockInfo  `json:"manual_lock,omitempty"`
	// DiskFree and DiskTotal are the bytes of the filesystem holding Dockflow's state.
	DiskFree  uint64 `json:"disk_free,omitempty"`
	DiskTotal uint64 `json:"disk_total,omitempty"`
	// Watchdog are the watchdog's most recent restarts, oldest first.
	Watchdog []state.WatchdogRestart `json:"watchdog,omitempty"`
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
	Op         string               `json:"op,omitempty"`
	Services   map[string]string    `json:"services"` // service → image
	Error      *domain.ReleaseError `json:"error,omitempty"`
}

// Summarise returns the summary of a release.
func Summarise(r *domain.Release) ReleaseSummary {
	s := ReleaseSummary{
		Seq: r.Seq, Version: r.Version, Status: r.Status, Run: r.Run,
		CreatedAt: r.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"), CreatedBy: r.CreatedBy,
		Source: r.Source, RollbackOf: r.RollbackOf, Op: r.Op, Error: r.Error, Services: map[string]string{},
	}
	if r.FinishedAt != nil {
		s.FinishedAt = r.FinishedAt.UTC().Format("2006-01-02T15:04:05Z")
	}
	for _, svc := range r.Desired.Services {
		s.Services[svc.Name] = svc.Spec.Image
	}
	return s
}
