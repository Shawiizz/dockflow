package domain

// Action kinds of a plan.
const (
	ActionCreateNetwork = "network.create"
	ActionCreateVolume  = "volume.create"
	ActionCreateService = "service.create"
	ActionUpdateService = "service.update"
	ActionRemoveService = "service.remove"
	ActionRoutes        = "routes.apply"
	ActionJob           = "job.run"
	ActionUpload        = "upload.apply"
	ActionCreateSecret  = "secret.create"
	ActionCreateConfig  = "config.create"
	ActionPorts         = "ports.apply"
)

// Plan is the ordered list of changes that turns the actual state into the desired one
// (ADR-0008).
type Plan struct {
	App         string   `json:"app"`
	Env         string   `json:"env"`
	Fingerprint string   `json:"fingerprint"`
	Actions     []Action `json:"actions"`
	// Unchanged lists services whose containers stay as they are.
	Unchanged []string `json:"unchanged,omitempty"`
	Summary   Summary  `json:"summary"`
	Warnings  []string `json:"warnings,omitempty"`
}

// Empty reports whether the plan changes nothing.
func (p *Plan) Empty() bool { return len(p.Actions) == 0 }

// Action is one change.
type Action struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Target   string   `json:"target"`
	Reason   string   `json:"reason"`
	Strategy Strategy `json:"strategy,omitempty"`
}

// Summary counts the changes of a plan.
type Summary struct {
	Create int `json:"create"`
	Update int `json:"update"`
	Remove int `json:"remove"`
}
