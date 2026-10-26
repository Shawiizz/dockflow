package compose

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/compose-spec/compose-go/v2/types"

	"github.com/Shawiizz/dockflow/internal/errs"
)

// ExtensionKey is the Compose extension Dockflow reads on services.
const ExtensionKey = "x-dockflow"

// Extension is x-dockflow on a service (docs/design/spec/config-v1.md). Keys of the spec that
// arrive in later milestones are refused with a clear message.
type Extension struct {
	Routes   []RouteExt       `json:"routes"`
	Rollout  *RolloutExt      `json:"rollout"`
	Health   *HealthExt       `json:"health"`
	Stateful bool             `json:"stateful"`
	Run      string           `json:"run"`
	Backup   *json.RawMessage `json:"backup"`
}

// RouteExt is one route.
type RouteExt struct {
	Domains     []string `json:"domains"`
	Path        string   `json:"path"`
	Port        int      `json:"port"`
	TLS         *bool    `json:"tls"`
	StripPrefix bool     `json:"strip_prefix"`
}

// RolloutExt is x-dockflow.rollout.
type RolloutExt struct {
	Strategy string `json:"strategy"`
	Drain    string `json:"drain"`
}

// HTTPExt is x-dockflow.health.http: an internal check, before the switch.
type HTTPExt struct {
	Path     string `json:"path"`
	Port     int    `json:"port"`
	Status   string `json:"status"` // 200, or a range 200-399
	Timeout  string `json:"timeout"`
	Retries  *int   `json:"retries"`
	Interval string `json:"interval"`
}

// HealthExt is x-dockflow.health.
type HealthExt struct {
	Grace        string   `json:"grace"`
	RestartAfter string   `json:"restart_after"`
	HTTP         *HTTPExt `json:"http"`
}

func readExtension(s types.ServiceConfig) (Extension, error) {
	var x Extension
	raw, ok := s.Extensions[ExtensionKey]
	if !ok || raw == nil {
		return x, nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return x, errs.Config("service %s: %s cannot be read", s.Name, ExtensionKey).WithCause(err)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&x); err != nil {
		msg := strings.TrimPrefix(err.Error(), "json: ")
		return x, errs.Config("service %s: %s: %s", s.Name, ExtensionKey, msg).
			WithHint("its keys are listed in docs/design/spec/config-v1.md")
	}
	switch {
	case x.Backup != nil:
		return x, notYetExt(s.Name, "backup", "M4")
	case x.Health != nil && x.Health.RestartAfter != "":
		return x, notYetExt(s.Name, "health.restart_after", "M3")
	}
	return x, nil
}

func notYetExt(service, key, milestone string) error {
	return errs.Config("service %s: x-dockflow.%s is not available yet in this version of Dockflow", service, key).
		WithHint("it arrives with milestone %s (docs/design/roadmap.md)", milestone)
}
