// Package domain holds Dockflow's model of an application, independent of Docker's types:
// what should run (an App), what runs (Actual), how to go from one to the other (Plan), and
// what was deployed (Release). It does no I/O.
package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

// Strategy is how a service moves from one release to the next (ADR-0010).
type Strategy string

// Rollout strategies.
const (
	StrategySwitch     Strategy = "switch"
	StrategyStartFirst Strategy = "start-first"
	StrategyStopFirst  Strategy = "stop-first"
)

// App is the desired state of one environment of an application.
type App struct {
	Name     string    `json:"name"`
	Env      string    `json:"env"`
	Stack    string    `json:"stack"`
	Services []Service `json:"services"`
	Networks []Network `json:"networks"`
	Volumes  []Volume  `json:"volumes"`
}

// Service returns the service with the given name.
func (a *App) Service(name string) (*Service, bool) {
	for i := range a.Services {
		if a.Services[i].Name == name {
			return &a.Services[i], true
		}
	}
	return nil, false
}

// Job kinds.
const (
	JobBefore = "before"
	JobAfter  = "after"
)

// HasRoutes reports whether any service is routed by the switch.
func (a *App) HasRoutes() bool {
	for _, s := range a.Services {
		if len(s.Routes) > 0 {
			return true
		}
	}
	return false
}

// Service is one Compose service.
type Service struct {
	Name     string        `json:"name"`
	Strategy Strategy      `json:"strategy"`
	Replicas int           `json:"replicas"`
	Spec     ContainerSpec `json:"spec"`
	// PullPolicy is Compose's pull_policy: missing (default), always, never.
	PullPolicy string `json:"pull_policy"`
	// Job is before or after for a one-off job run in every deploy that changes something; empty
	// for a long-running service (ADR-0010).
	Job string `json:"job,omitempty"`
	// Build tells that Dockflow builds the image, so it is named and pinned at deploy time.
	Build     bool         `json:"build,omitempty"`
	Routes    []Route      `json:"routes,omitempty"`
	DependsOn []Dependency `json:"depends_on,omitempty"`
	Stateful  bool         `json:"stateful,omitempty"`
	// Drain is how long requests in flight are given before old containers stop (switch).
	Drain Duration `json:"drain"`
	// HealthGrace is how long a container without a healthcheck must run to count as healthy.
	HealthGrace Duration `json:"health_grace"`
	// HTTPCheck is checked on every new container, from inside the app's network, before the
	// switch.
	HTTPCheck *HTTPCheck `json:"http_check,omitempty"`
	// ContainerName is Compose's container_name, which forces stop-first and one replica.
	ContainerName string `json:"container_name,omitempty"`
}

// Hash identifies everything that makes containers of this service different: a service whose
// hash is unchanged keeps its containers.
func (s *Service) Hash() string {
	type hashed struct {
		Spec      ContainerSpec
		Replicas  int
		Name      string
		Container string
	}
	b, _ := json.Marshal(hashed{s.Spec, s.Replicas, s.Name, s.ContainerName})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:16]
}

// HTTPCheck is an HTTP request that must answer with a status in [StatusMin, StatusMax].
type HTTPCheck struct {
	Path      string   `json:"path"`
	Port      int      `json:"port"`
	StatusMin int      `json:"status_min"`
	StatusMax int      `json:"status_max"`
	Timeout   Duration `json:"timeout"`
	Retries   int      `json:"retries"`
	Interval  Duration `json:"interval"`
}

// Endpoint is a public check, made after the switch on a full URL (health.endpoints).
type Endpoint struct {
	Name           string   `json:"name"`
	URL            string   `json:"url"`
	Method         string   `json:"method"`
	ExpectedStatus int      `json:"expected_status"`
	Timeout        Duration `json:"timeout"`
	Retries        int      `json:"retries"`
	RetryDelay     Duration `json:"retry_delay"`
	ValidateCerts  bool     `json:"validate_certs"`
}

// Dependency is one depends_on entry.
type Dependency struct {
	Service   string `json:"service"`
	Condition string `json:"condition"` // service_started, service_healthy, service_completed_successfully
}

// Route sends HTTP traffic for domains and a path to a container port, through the switch.
type Route struct {
	Domains     []string `json:"domains"`
	Path        string   `json:"path"`
	Port        int      `json:"port"`
	TLS         bool     `json:"tls"`
	StripPrefix bool     `json:"strip_prefix,omitempty"`
}

// Network is a network of the app.
type Network struct {
	// Key is the name in the Compose file; Name is the Docker name.
	Key      string            `json:"key"`
	Name     string            `json:"name"`
	External bool              `json:"external,omitempty"`
	Driver   string            `json:"driver,omitempty"`
	Internal bool              `json:"internal,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
}

// Volume is a named volume of the app.
type Volume struct {
	Key        string            `json:"key"`
	Name       string            `json:"name"`
	External   bool              `json:"external,omitempty"`
	Driver     string            `json:"driver,omitempty"`
	DriverOpts map[string]string `json:"driver_opts,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
}

// Duration is a time.Duration that reads and writes as a Go duration string in JSON.
type Duration time.Duration

// MarshalJSON writes the duration as "30s".
func (d Duration) MarshalJSON() ([]byte, error) { return json.Marshal(time.Duration(d).String()) }

// UnmarshalJSON reads "30s".
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return err
	}
	*d = Duration(v)
	return nil
}

// D returns the time.Duration.
func (d Duration) D() time.Duration { return time.Duration(d) }
