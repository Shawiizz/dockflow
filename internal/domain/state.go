package domain

import "time"

// Actual is what runs on the server for one app environment, as read from Docker and from
// Dockflow's state files.
type Actual struct {
	Services map[string]ActualService `json:"services"`
	// Networks maps the Docker name of each network that exists to the Compose project it
	// belongs to (LabelProject), empty for a network of no project.
	Networks map[string]string `json:"networks"`
	Volumes  map[string]bool   `json:"volumes"`
	// Env is the environment's record; nil when the app was never deployed.
	Env *EnvRecord `json:"env,omitempty"`
	// Uploads maps each upload destination to the manifest it holds.
	Uploads map[string]string `json:"uploads,omitempty"`
}

// ActualService is a service as it runs.
type ActualService struct {
	Name string `json:"name"`
	// Release is the sequence number of the release whose containers serve this service.
	Release    int             `json:"release"`
	Hash       string          `json:"hash"`
	Containers []ContainerInfo `json:"containers"`
	// Desired is the service as the current release recorded it, when known.
	Desired *Service `json:"desired,omitempty"`
}

// ContainerInfo is one container as Docker reports it.
type ContainerInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Service string `json:"service"`
	Release int    `json:"release"`
	Hash    string `json:"hash"`
	State   string `json:"state"`  // created, running, exited, restarting, …
	Health  string `json:"health"` // healthy, unhealthy, starting, or empty without a healthcheck
	OneOff  bool   `json:"oneoff,omitempty"`
}

// EnvRecord is env.json (docs/design/spec/state-v1.md).
type EnvRecord struct {
	Schema   int  `json:"schema"`
	LastSeq  int  `json:"last_seq"`
	Current  int  `json:"current"`
	Previous int  `json:"previous"`
	Degraded bool `json:"degraded"`
}

// Release statuses.
const (
	StatusApplying   = "applying"
	StatusActive     = "active"
	StatusSuperseded = "superseded"
	StatusRolledBack = "rolled-back"
	StatusFailed     = "failed"
	StatusAbandoned  = "abandoned"
)

// Release is a release record (docs/design/spec/state-v1.md).
type Release struct {
	Schema          int        `json:"schema"`
	App             string     `json:"app"`
	Env             string     `json:"env"`
	Server          string     `json:"server"`
	Seq             int        `json:"seq"`
	Version         string     `json:"version"`
	Status          string     `json:"status"`
	Run             string     `json:"run"`
	CreatedAt       time.Time  `json:"created_at"`
	FinishedAt      *time.Time `json:"finished_at,omitempty"`
	CreatedBy       Author     `json:"created_by"`
	Source          Source     `json:"source"`
	DockflowVersion string     `json:"dockflow_version"`
	RollbackOf      int        `json:"rollback_of,omitempty"`
	// Op is what made the release: deploy, rollback, restart, stop, scale or destroy.
	Op              string            `json:"op,omitempty"`
	Desired         App               `json:"desired"`
	Serving         map[string]int    `json:"serving"` // service → release whose containers serve it
	Hashes          map[string]string `json:"hashes"`
	PlanFingerprint string            `json:"plan_fingerprint"`
	Error           *ReleaseError     `json:"error,omitempty"`
}

// ReleaseError records why a release failed.
type ReleaseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Author is who started a run.
type Author struct {
	User    string `json:"user"`
	Machine string `json:"machine"`
	CI      string `json:"ci,omitempty"`
}

// Source is the code a release was built from.
type Source struct {
	GitSHA string `json:"git_sha,omitempty"`
	Branch string `json:"branch,omitempty"`
	Dirty  bool   `json:"dirty,omitempty"`
}

// LockInfo is lock.json and manual-lock.json.
type LockInfo struct {
	Schema  int       `json:"schema"`
	Run     string    `json:"run,omitempty"`
	Op      string    `json:"op"`
	By      string    `json:"by"`
	CI      string    `json:"ci,omitempty"`
	Message string    `json:"message,omitempty"`
	Since   time.Time `json:"since"`
}
