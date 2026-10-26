package domain

// ContainerSpec is everything needed to create one container of a service, except its name and
// the labels Dockflow manages. It is what a release records, so a rollback recreates the same
// containers.
type ContainerSpec struct {
	// Image is the reference to run: pinned by digest once the plan has resolved it.
	Image      string            `json:"image"`
	Command    []string          `json:"command,omitempty"`
	Entrypoint []string          `json:"entrypoint,omitempty"`
	Env        []string          `json:"env,omitempty"` // KEY=value, sorted
	Labels     map[string]string `json:"labels,omitempty"`
	User       string            `json:"user,omitempty"`
	WorkingDir string            `json:"working_dir,omitempty"`
	Hostname   string            `json:"hostname,omitempty"`
	DomainName string            `json:"domainname,omitempty"`
	Ports      []Port            `json:"ports,omitempty"`
	Expose     []string          `json:"expose,omitempty"`
	Mounts     []Mount           `json:"mounts,omitempty"`
	Networks   []Attachment      `json:"networks,omitempty"`
	// NetworkMode is host, none, service:<name> or container:<name>; empty means bridge networks.
	NetworkMode string       `json:"network_mode,omitempty"`
	Healthcheck *Healthcheck `json:"healthcheck,omitempty"`
	Restart     string       `json:"restart"`
	StopSignal  string       `json:"stop_signal,omitempty"`
	StopGrace   *Duration    `json:"stop_grace,omitempty"`
	Privileged  bool         `json:"privileged,omitempty"`
	ReadOnly    bool         `json:"read_only,omitempty"`
	Init        *bool        `json:"init,omitempty"`
	Tty         bool         `json:"tty,omitempty"`
	StdinOpen   bool         `json:"stdin_open,omitempty"`
	// StdinOnce closes stdin after the first attached client detaches (the agent's input).
	StdinOnce   bool              `json:"stdin_once,omitempty"`
	CapAdd      []string          `json:"cap_add,omitempty"`
	CapDrop     []string          `json:"cap_drop,omitempty"`
	SecurityOpt []string          `json:"security_opt,omitempty"`
	ExtraHosts  []string          `json:"extra_hosts,omitempty"`
	DNS         []string          `json:"dns,omitempty"`
	DNSSearch   []string          `json:"dns_search,omitempty"`
	DNSOptions  []string          `json:"dns_opt,omitempty"`
	Tmpfs       map[string]string `json:"tmpfs,omitempty"`
	Sysctls     map[string]string `json:"sysctls,omitempty"`
	Ulimits     []Ulimit          `json:"ulimits,omitempty"`
	Devices     []Device          `json:"devices,omitempty"`
	GroupAdd    []string          `json:"group_add,omitempty"`
	Pid         string            `json:"pid,omitempty"`
	Ipc         string            `json:"ipc,omitempty"`
	ShmSize     int64             `json:"shm_size,omitempty"`
	Resources   Resources         `json:"resources"`
	Logging     *Logging          `json:"logging,omitempty"`
	Platform    string            `json:"platform,omitempty"`
}

// Port is a published port.
type Port struct {
	HostIP        string `json:"host_ip,omitempty"`
	HostPort      string `json:"host_port,omitempty"` // empty: a random port
	ContainerPort int    `json:"container_port"`
	Protocol      string `json:"protocol"` // tcp, udp
}

// Mount is a volume, bind or tmpfs mount.
type Mount struct {
	Type     string `json:"type"` // volume, bind, tmpfs
	Source   string `json:"source,omitempty"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"read_only,omitempty"`
	// CreateHostPath creates a missing bind source, as Compose's short syntax does.
	CreateHostPath bool  `json:"create_host_path,omitempty"`
	NoCopy         bool  `json:"nocopy,omitempty"`
	TmpfsSize      int64 `json:"tmpfs_size,omitempty"`
}

// Attachment connects a container to a network.
type Attachment struct {
	Network     string   `json:"network"` // Docker name
	Aliases     []string `json:"aliases,omitempty"`
	IPv4Address string   `json:"ipv4_address,omitempty"`
	IPv6Address string   `json:"ipv6_address,omitempty"`
}

// Healthcheck is a container healthcheck.
type Healthcheck struct {
	Test          []string  `json:"test,omitempty"`
	Interval      *Duration `json:"interval,omitempty"`
	Timeout       *Duration `json:"timeout,omitempty"`
	StartPeriod   *Duration `json:"start_period,omitempty"`
	StartInterval *Duration `json:"start_interval,omitempty"`
	Retries       *uint64   `json:"retries,omitempty"`
	Disable       bool      `json:"disable,omitempty"`
}

// Ulimit is one ulimit.
type Ulimit struct {
	Name string `json:"name"`
	Soft int64  `json:"soft"`
	Hard int64  `json:"hard"`
}

// Device maps a host device into the container.
type Device struct {
	Source      string `json:"source"`
	Target      string `json:"target"`
	Permissions string `json:"permissions,omitempty"`
}

// Resources are container limits.
type Resources struct {
	MemoryLimit       int64   `json:"memory_limit,omitempty"`
	MemoryReservation int64   `json:"memory_reservation,omitempty"`
	CPUs              float64 `json:"cpus,omitempty"`
	PidsLimit         int64   `json:"pids_limit,omitempty"`
}

// Logging is the container's log driver.
type Logging struct {
	Driver  string            `json:"driver"`
	Options map[string]string `json:"options,omitempty"`
}
