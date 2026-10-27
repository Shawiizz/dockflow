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
	Uploads  []Upload  `json:"uploads,omitempty"`
	// Files are the Compose secrets and configs, by content; their values are never here.
	Files []File `json:"files,omitempty"`
	// PublicPorts are the published ports the port filter lets in from outside (ADR-0014).
	PublicPorts []PublicPort `json:"public_ports,omitempty"`
	// Routes are the routes of dockflow.yml that target no service: redirects and proxies
	// (ADR-0011). Its files routes are services of their own.
	Routes []AppRoute `json:"routes,omitempty"`
}

// AppRoute is a route of dockflow.yml that targets no service of the app.
type AppRoute struct {
	Route
	// Redirect is the URL a redirect sends to, with Status (301, 302, 303, 307 or 308).
	Redirect string `json:"redirect,omitempty"`
	Status   int    `json:"status,omitempty"`
	// Proxy is the URL requests are sent to; Network is a shared network the switch joins to
	// reach it.
	Proxy   string `json:"proxy,omitempty"`
	Network string `json:"network,omitempty"`
}

// FileServerImage stands for the switch's image in the services of files routes: the agent
// gives them the image the switch runs.
const FileServerImage = "dockflow:file-server"

// PublicPort is a port of firewall.public_ports: open to everyone, or to the From CIDRs.
type PublicPort struct {
	Port int `json:"port"`
	// Protocol is tcp or udp; empty means both.
	Protocol string   `json:"protocol,omitempty"`
	From     []string `json:"from,omitempty"`
}

// File is a Compose secret or config written on the server (ADR-0012): named after the hash of
// its content and permissions, so a new value is a new file and the services that mount it are
// redeployed. Secrets are on a tmpfs.
type File struct {
	Name   string `json:"name"`
	Secret bool   `json:"secret,omitempty"`
	// Hash is the sha256 of the content, uid, gid and mode.
	Hash string `json:"hash"`
	// Path is where the file is on the server.
	Path string `json:"path"`
	UID  int    `json:"uid"`
	GID  int    `json:"gid"`
	Mode uint32 `json:"mode"`
}

// SecretsRoot and configs are where Compose secrets and configs are written on the server.
const SecretsRoot = "/run/dockflow/secrets"

// SecretPath is the server path of a secret's file.
func SecretPath(stack, name, hash string) string {
	return SecretsRoot + "/" + stack + "/" + name + "-" + hash[:12]
}

// ConfigPath is the server path of a config's file, in the app's state directory.
func ConfigPath(stack, name, hash string) string {
	return "/var/lib/dockflow/apps/" + stack + "/configs/" + name + "-" + hash[:12]
}

// Upload sends files to a volume of the app or a path on the server (ADR-0021).
type Upload struct {
	// Dest is volume:<key> or an absolute path on the server.
	Dest string `json:"dest"`
	// Volume is the Docker name of the volume, for volume:<key>.
	Volume string `json:"volume,omitempty"`
	Mirror bool   `json:"mirror,omitempty"`
	Mode   string `json:"mode,omitempty"`  // octal, for the written files
	Owner  string `json:"owner,omitempty"` // uid or uid:gid
	// Manifest is the digest of the manifest of the files.
	Manifest string `json:"manifest"`
	// Plugin is the id of the plugin that added the upload (ADR-0017).
	Plugin string `json:"plugin,omitempty"`
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
	if len(a.Routes) > 0 {
		return true
	}
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
	// Stopped is set by `dockflow stop`: the service runs no container until a deploy or a
	// restart.
	Stopped bool `json:"stopped,omitempty"`
	// Job is before or after for a one-off job run in every deploy that changes something; empty
	// for a long-running service (ADR-0010).
	Job string `json:"job,omitempty"`
	// Build tells that Dockflow builds the image, so it is named and pinned at deploy time.
	Build     bool         `json:"build,omitempty"`
	Routes    []Route      `json:"routes,omitempty"`
	DependsOn []Dependency `json:"depends_on,omitempty"`
	Stateful  bool         `json:"stateful,omitempty"`
	// Backup is how the service is backed up (ADR-0015); nil when it is not.
	Backup *Backup `json:"backup,omitempty"`
	// Drain is how long requests in flight are given before old containers stop (switch).
	Drain Duration `json:"drain"`
	// HealthGrace is how long a container without a healthcheck must run to count as healthy.
	HealthGrace Duration `json:"health_grace"`
	// RestartAfter is how long a container may stay unhealthy before the watchdog restarts it
	// (ADR-0010): nil for the default, 0 for never.
	RestartAfter *Duration `json:"restart_after,omitempty"`
	// HTTPCheck is checked on every new container, from inside the app's network, before the
	// switch.
	HTTPCheck *HTTPCheck `json:"http_check,omitempty"`
	// ContainerName is Compose's container_name, which forces stop-first and one replica.
	ContainerName string `json:"container_name,omitempty"`
}

// DefaultRestartAfter is how long a container stays unhealthy before the watchdog restarts it.
const DefaultRestartAfter = 2 * time.Minute

// RestartDelay is the service's RestartAfter, or the default.
func (s *Service) RestartDelay() time.Duration {
	if s.RestartAfter == nil {
		return DefaultRestartAfter
	}
	return s.RestartAfter.D()
}

// Hash identifies everything that makes containers of this service different: a service whose
// hash is unchanged keeps its containers.
func (s *Service) Hash() string {
	type hashed struct {
		Spec      ContainerSpec
		Replicas  int
		Name      string
		Container string
		Stopped   bool `json:",omitempty"`
	}
	b, _ := json.Marshal(hashed{s.Spec, s.Replicas, s.Name, s.ContainerName, s.Stopped})
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

// Count is how many containers the service runs: its replicas, or none when stopped.
func (s *Service) Count() int {
	if s.Stopped {
		return 0
	}
	return s.Replicas
}

// Dependency is one depends_on entry.
type Dependency struct {
	Service   string `json:"service"`
	Condition string `json:"condition"` // service_started, service_healthy, service_completed_successfully
}

// Route sends HTTP traffic for domains and a path to a container port, through the switch.
type Route struct {
	// Name is given to the routes of dockflow.yml, which error pages can show.
	Name        string   `json:"name,omitempty"`
	Domains     []string `json:"domains"`
	Path        string   `json:"path"`
	Port        int      `json:"port"`
	TLS         bool     `json:"tls"`
	StripPrefix bool     `json:"strip_prefix,omitempty"`
	RouteOptions
}

// RouteOptions are what the switch does to a route's requests and responses (ADR-0011).
type RouteOptions struct {
	// Headers are response headers to set; a name starting with "-" removes the header.
	Headers map[string]string `json:"headers,omitempty"`
	// Encode are the compressions offered, zstd and gzip, in order of preference.
	Encode []string `json:"encode,omitempty"`
	// MaxBody is the largest request body, in bytes; 0 for no limit.
	MaxBody  int64          `json:"max_body,omitempty"`
	Timeouts *RouteTimeouts `json:"timeouts,omitempty"`
	Auth     *RouteAuth     `json:"auth,omitempty"`
	// Caddy are raw Caddyfile directives, run before the request is proxied.
	Caddy string `json:"caddy,omitempty"`
	// ErrorPages replace the answers of the given statuses, and the failures to reach the
	// containers.
	ErrorPages []ErrorPage `json:"error_pages,omitempty"`
}

// ErrorPage is what a route answers for some statuses: the route of dockflow.yml named Route,
// or Body, an inline page.
type ErrorPage struct {
	Statuses []int  `json:"statuses"`
	Route    string `json:"route,omitempty"`
	Body     string `json:"body,omitempty"`
}

// RouteTimeouts bound the switch's connection to the containers.
type RouteTimeouts struct {
	Read  Duration `json:"read,omitempty"`
	Write Duration `json:"write,omitempty"`
	Dial  Duration `json:"dial,omitempty"`
}

// RouteAuth is HTTP basic authentication in front of a route.
type RouteAuth struct {
	User     string `json:"user"`
	Password string `json:"password"`
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
