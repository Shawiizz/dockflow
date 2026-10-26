package compose

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/compose-spec/compose-go/v2/types"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/image"
)

// Result is a converted project, with the warnings the conversion produced.
type Result struct {
	App domain.App
	// Builds are the images to build, one per service with `build`.
	Builds   []image.Build
	Warnings []string
}

// supported are the Compose service keys Dockflow handles in this version. Any other key with
// a value is refused, so nothing is silently dropped (vision, goal 7).
var supported = map[string]bool{
	"image": true, "build": true, "command": true, "entrypoint": true, "environment": true, "labels": true,
	"user": true, "working_dir": true, "hostname": true, "domainname": true, "ports": true,
	"expose": true, "volumes": true, "networks": true, "network_mode": true, "healthcheck": true,
	"restart": true, "deploy": true, "stop_signal": true, "stop_grace_period": true,
	"privileged": true, "read_only": true, "init": true, "tty": true, "stdin_open": true,
	"cap_add": true, "cap_drop": true, "security_opt": true, "extra_hosts": true, "dns": true,
	"dns_search": true, "dns_opt": true, "tmpfs": true, "sysctls": true, "ulimits": true,
	"devices": true, "group_add": true, "pid": true, "ipc": true, "shm_size": true,
	"mem_limit": true, "mem_reservation": true, "cpus": true, "pids_limit": true,
	"logging": true, "platform": true, "depends_on": true, "container_name": true,
	"pull_policy": true, "scale": true, "profiles": true, "env_file": true, "label_file": true,
	"annotations": false,
}

// later are keys that arrive in a later milestone.
var later = map[string]string{"secrets": "M3", "configs": "M3"}

// ignored are keys with no effect on one server, reported as warnings.
var ignoredDeploy = []string{"placement", "endpoint_mode", "rollback_config"}

// Convert turns a loaded project into the domain model of one app environment.
func Convert(p *types.Project, app, env string) (*Result, error) {
	stack := domain.Stack(app, env)
	r := &Result{App: domain.App{Name: app, Env: env, Stack: stack}}

	netKeys := sortedKeys(p.Networks)
	for _, key := range netKeys {
		n := p.Networks[key]
		r.App.Networks = append(r.App.Networks, domain.Network{
			Key: key, Name: n.Name, External: bool(n.External), Driver: n.Driver,
			Internal: n.Internal, Labels: n.Labels,
		})
	}
	for _, key := range sortedKeys(p.Volumes) {
		v := p.Volumes[key]
		r.App.Volumes = append(r.App.Volumes, domain.Volume{
			Key: key, Name: v.Name, External: bool(v.External), Driver: v.Driver,
			DriverOpts: v.DriverOpts, Labels: v.Labels,
		})
	}

	for _, name := range p.ServiceNames() {
		svc := p.Services[name]
		s, warnings, err := convertService(p, stack, svc)
		if err != nil {
			return nil, err
		}
		r.Warnings = append(r.Warnings, warnings...)
		if svc.Build != nil {
			b, warnings, err := convertBuild(svc)
			if err != nil {
				return nil, err
			}
			r.Warnings = append(r.Warnings, warnings...)
			r.Builds = append(r.Builds, *b)
			s.Build = true
			// the image is named and pinned once built (ADR-0009)
			s.Spec.Image = app + "/" + svc.Name
		}
		r.App.Services = append(r.App.Services, *s)
	}
	if err := markJobs(&r.App); err != nil {
		return nil, err
	}
	if err := checkDependencies(&r.App); err != nil {
		return nil, err
	}
	return r, nil
}

// markJobs makes a job of every service another one depends on with
// service_completed_successfully, as `docker compose up` runs it to completion first.
func markJobs(a *domain.App) error {
	for _, s := range a.Services {
		for _, d := range s.DependsOn {
			if d.Condition != types.ServiceConditionCompletedSuccessfully {
				continue
			}
			dep, ok := a.Service(d.Service)
			if !ok {
				continue
			}
			switch dep.Job {
			case "":
				dep.Job = domain.JobBefore
			case domain.JobAfter:
				return errs.Config("service %s waits for %s to complete, which runs after the deploy (x-dockflow.run: after)", s.Name, dep.Name)
			}
		}
	}
	for i := range a.Services {
		if a.Services[i].Job != "" {
			if err := asJob(&a.Services[i]); err != nil {
				return err
			}
		}
	}
	return nil
}

// asJob checks and adjusts a job: one container, never restarted, no routes.
func asJob(s *domain.Service) error {
	at := "service " + s.Name
	switch {
	case len(s.Routes) > 0 || s.HTTPCheck != nil:
		return errs.Config("%s: a job serves no traffic: routes and health checks do not apply", at)
	case s.Stateful:
		return errs.Config("%s: a job is not a long-running service: it cannot be stateful", at)
	case s.Replicas > 1:
		return errs.Config("%s: a job runs once: deploy.replicas must be 1", at)
	}
	s.Replicas = 1
	s.Spec.Restart = "no"
	s.Strategy = ""
	return nil
}

// httpCheck reads x-dockflow.health.http. Its port defaults to the first route's.
func httpCheck(at string, h *HTTPExt, routes []RouteExt) (*domain.HTTPCheck, error) {
	at += ": x-dockflow.health.http"
	c := &domain.HTTPCheck{Path: h.Path, Port: h.Port, StatusMin: 200, StatusMax: 399, Retries: 10,
		Timeout: domain.Duration(5 * time.Second), Interval: domain.Duration(3 * time.Second)}
	if c.Path == "" {
		c.Path = "/"
	}
	if !strings.HasPrefix(c.Path, "/") {
		return nil, errs.Config("%s.path must start with /", at)
	}
	if c.Port == 0 && len(routes) > 0 {
		c.Port = routes[0].Port
	}
	if c.Port < 1 || c.Port > 65535 {
		return nil, errs.Config("%s.port is required for a service without routes", at)
	}
	if h.Status != "" {
		lo, hi, isRange := strings.Cut(h.Status, "-")
		var err1, err2 error
		c.StatusMin, err1 = strconv.Atoi(strings.TrimSpace(lo))
		c.StatusMax = c.StatusMin
		if isRange {
			c.StatusMax, err2 = strconv.Atoi(strings.TrimSpace(hi))
		}
		if err1 != nil || err2 != nil || c.StatusMin < 100 || c.StatusMax > 599 || c.StatusMin > c.StatusMax {
			return nil, errs.Config("%s.status %q is not a status or a range like 200-399", at, h.Status)
		}
	}
	for key, v := range map[string]struct {
		s   string
		dst *domain.Duration
	}{"timeout": {h.Timeout, &c.Timeout}, "interval": {h.Interval, &c.Interval}} {
		if v.s == "" {
			continue
		}
		d, err := time.ParseDuration(v.s)
		if err != nil || d <= 0 {
			return nil, errs.Config("%s.%s %q is not a duration", at, key, v.s)
		}
		*v.dst = domain.Duration(d)
	}
	if h.Retries != nil {
		if *h.Retries < 1 {
			return nil, errs.Config("%s.retries must be at least 1", at)
		}
		c.Retries = *h.Retries
	}
	return c, nil
}

// convertBuild maps the Compose build keys to a bake target (ADR-0009).
func convertBuild(s types.ServiceConfig) (*image.Build, []string, error) {
	at := "service " + s.Name + ": build"
	b := s.Build
	var warnings []string
	switch {
	case len(b.Secrets) > 0:
		return nil, nil, errs.Config("%s.secrets is not available yet in this version of Dockflow", at).
			WithHint("it arrives with secrets, in milestone M3 (docs/design/roadmap.md)")
	case b.Isolation != "":
		return nil, nil, errs.Config("%s.isolation is for Windows containers, which Dockflow does not deploy", at)
	case len(b.Ulimits) > 0:
		return nil, nil, errs.Config("%s.ulimits is not supported by buildx bake", at)
	case b.Provenance != "" || b.SBOM != "":
		return nil, nil, errs.Config("%s: provenance and sbom attestations are not supported yet", at)
	}
	if len(b.Platforms) > 0 {
		warnings = append(warnings, fmt.Sprintf("%s.platforms is ignored: images are built for the server's platform", at))
	}
	if len(b.Tags) > 0 {
		warnings = append(warnings, fmt.Sprintf("%s.tags is ignored: images are tagged <app>/<service>:<version>, plus registry.additional_tags", at))
	}
	out := &image.Build{
		Service: s.Name, Context: b.Context, Dockerfile: b.Dockerfile, DockerfileInline: b.DockerfileInline,
		Labels: copyMap(b.Labels), Target: b.Target, CacheFrom: b.CacheFrom, CacheTo: b.CacheTo,
		NoCache: b.NoCache, NoCacheFilter: b.NoCacheFilter, Pull: b.Pull, Network: b.Network,
		ShmSize: int64(b.ShmSize), Entitlements: b.Entitlements,
	}
	if b.Privileged {
		out.Entitlements = append(out.Entitlements, "security.insecure")
	}
	if len(b.AdditionalContexts) > 0 {
		out.AdditionalContexts = map[string]string(b.AdditionalContexts)
	}
	if len(b.Args) > 0 {
		out.Args = map[string]string{}
		for k, v := range b.Args {
			if v != nil {
				out.Args[k] = *v
			}
		}
	}
	if len(b.ExtraHosts) > 0 {
		out.ExtraHosts = b.ExtraHosts.AsList(":")
	}
	for _, k := range b.SSH {
		if k.Path == "" {
			out.SSH = append(out.SSH, k.ID)
		} else {
			out.SSH = append(out.SSH, k.ID+"="+k.Path)
		}
	}
	return out, warnings, nil
}

func convertService(p *types.Project, stack string, s types.ServiceConfig) (*domain.Service, []string, error) {
	at := "service " + s.Name
	var warnings []string
	if !domain.ServiceName.MatchString(s.Name) {
		return nil, nil, errs.Config("%s: the name must match %s", at, domain.ServiceName)
	}
	if err := checkKeys(s); err != nil {
		return nil, nil, err
	}
	if s.Image == "" && s.Build == nil {
		return nil, nil, errs.Config("%s: `image` or `build` is required", at)
	}
	x, err := readExtension(s)
	if err != nil {
		return nil, nil, err
	}

	spec := domain.ContainerSpec{
		Image:       s.Image,
		Command:     []string(s.Command),
		Entrypoint:  []string(s.Entrypoint),
		Labels:      copyMap(s.Labels),
		User:        s.User,
		WorkingDir:  s.WorkingDir,
		Hostname:    s.Hostname,
		DomainName:  s.DomainName,
		Privileged:  s.Privileged,
		ReadOnly:    s.ReadOnly,
		Init:        s.Init,
		Tty:         s.Tty,
		StdinOpen:   s.StdinOpen,
		CapAdd:      s.CapAdd,
		CapDrop:     s.CapDrop,
		SecurityOpt: s.SecurityOpt,
		DNS:         s.DNS,
		DNSSearch:   s.DNSSearch,
		DNSOptions:  s.DNSOpts,
		GroupAdd:    s.GroupAdd,
		Pid:         s.Pid,
		Ipc:         s.Ipc,
		ShmSize:     int64(s.ShmSize),
		StopSignal:  s.StopSignal,
		Platform:    s.Platform,
		NetworkMode: s.NetworkMode,
	}
	if len(s.ExtraHosts) > 0 {
		spec.ExtraHosts = s.ExtraHosts.AsList(":")
		sort.Strings(spec.ExtraHosts)
	}
	for k, v := range s.Environment {
		if v != nil {
			spec.Env = append(spec.Env, k+"="+*v)
		}
	}
	sort.Strings(spec.Env)
	if s.StopGracePeriod != nil {
		d := domain.Duration(*s.StopGracePeriod)
		spec.StopGrace = &d
	}
	for _, e := range s.Expose {
		spec.Expose = append(spec.Expose, e)
	}

	switch s.NetworkMode {
	case "", "host", "none":
	case "bridge":
		spec.NetworkMode = ""
	default:
		return nil, nil, errs.Config("%s: network_mode %q is not supported yet; use host, none or networks", at, s.NetworkMode)
	}

	// ports
	fixedPorts := false
	for _, port := range s.Ports {
		proto := port.Protocol
		if proto == "" {
			proto = "tcp"
		}
		if port.Published != "" {
			fixedPorts = true
		}
		spec.Ports = append(spec.Ports, domain.Port{
			HostIP: port.HostIP, HostPort: port.Published, ContainerPort: int(port.Target), Protocol: proto,
		})
	}

	// mounts
	for _, v := range s.Volumes {
		m := domain.Mount{Type: v.Type, Target: v.Target, ReadOnly: v.ReadOnly}
		switch v.Type {
		case types.VolumeTypeVolume:
			if v.Source != "" {
				vol, ok := p.Volumes[v.Source]
				if !ok {
					return nil, nil, errs.Config("%s: volume %q is not declared under volumes", at, v.Source)
				}
				m.Source = vol.Name
			}
			if v.Volume != nil {
				m.NoCopy = v.Volume.NoCopy
				if v.Volume.Subpath != "" {
					return nil, nil, errs.Config("%s: volume subpath is not supported yet", at)
				}
			}
		case types.VolumeTypeBind:
			m.Source = v.Source
			if v.Bind != nil {
				m.CreateHostPath = bool(v.Bind.CreateHostPath)
				if v.Bind.Propagation != "" || v.Bind.SELinux != "" {
					return nil, nil, errs.Config("%s: bind propagation and selinux options are not supported yet", at)
				}
			} else {
				m.CreateHostPath = true
			}
		case types.VolumeTypeTmpfs:
			if v.Tmpfs != nil {
				m.TmpfsSize = int64(v.Tmpfs.Size)
			}
		default:
			return nil, nil, errs.Config("%s: volume type %q is not supported", at, v.Type)
		}
		spec.Mounts = append(spec.Mounts, m)
	}
	if len(s.Tmpfs) > 0 {
		spec.Tmpfs = map[string]string{}
		for _, t := range s.Tmpfs {
			path, opts, _ := strings.Cut(t, ":")
			spec.Tmpfs[path] = opts
		}
	}

	// networks, with the service name as an alias on each, as Compose does
	if spec.NetworkMode == "" {
		for _, key := range sortedKeys(s.Networks) {
			n, ok := p.Networks[key]
			if !ok {
				return nil, nil, errs.Config("%s: network %q is not declared under networks", at, key)
			}
			a := domain.Attachment{Network: n.Name, Aliases: []string{s.Name}}
			if cfg := s.Networks[key]; cfg != nil {
				a.Aliases = append(a.Aliases, cfg.Aliases...)
				a.IPv4Address = cfg.Ipv4Address
				a.IPv6Address = cfg.Ipv6Address
			}
			a.Aliases = dedupe(a.Aliases)
			spec.Networks = append(spec.Networks, a)
		}
	}

	if hc := s.HealthCheck; hc != nil {
		spec.Healthcheck = &domain.Healthcheck{
			Test: hc.Test, Disable: hc.Disable, Retries: hc.Retries,
			Interval: dur(hc.Interval), Timeout: dur(hc.Timeout),
			StartPeriod: dur(hc.StartPeriod), StartInterval: dur(hc.StartInterval),
		}
	}

	for k, v := range s.Sysctls {
		if spec.Sysctls == nil {
			spec.Sysctls = map[string]string{}
		}
		spec.Sysctls[k] = v
	}
	for _, name := range sortedKeys(s.Ulimits) {
		u := s.Ulimits[name]
		soft, hard := int64(u.Soft), int64(u.Hard)
		if u.Single != 0 {
			soft, hard = int64(u.Single), int64(u.Single)
		}
		spec.Ulimits = append(spec.Ulimits, domain.Ulimit{Name: name, Soft: soft, Hard: hard})
	}
	for _, d := range s.Devices {
		spec.Devices = append(spec.Devices, domain.Device{Source: d.Source, Target: d.Target, Permissions: d.Permissions})
	}
	if s.Logging != nil {
		spec.Logging = &domain.Logging{Driver: s.Logging.Driver, Options: s.Logging.Options}
	}

	// resources: deploy.resources wins over the legacy keys, as in Compose
	spec.Resources = domain.Resources{
		MemoryLimit: int64(s.MemLimit), MemoryReservation: int64(s.MemReservation),
		CPUs: float64(s.CPUS), PidsLimit: s.PidsLimit,
	}

	// restart policy: Compose's restart, else deploy.restart_policy, else unless-stopped (ADR-0010)
	spec.Restart = s.Restart
	strategy := domain.Strategy("")
	if d := s.Deploy; d != nil {
		if d.Resources.Limits != nil {
			l := d.Resources.Limits
			if l.MemoryBytes != 0 {
				spec.Resources.MemoryLimit = int64(l.MemoryBytes)
			}
			if l.NanoCPUs != 0 {
				spec.Resources.CPUs = float64(l.NanoCPUs)
			}
			if l.Pids != 0 {
				spec.Resources.PidsLimit = l.Pids
			}
		}
		if d.Resources.Reservations != nil && d.Resources.Reservations.MemoryBytes != 0 {
			spec.Resources.MemoryReservation = int64(d.Resources.Reservations.MemoryBytes)
		}
		if spec.Restart == "" && d.RestartPolicy != nil {
			switch d.RestartPolicy.Condition {
			case "none":
				spec.Restart = "no"
			case "on-failure":
				spec.Restart = "on-failure"
				if d.RestartPolicy.MaxAttempts != nil {
					spec.Restart += ":" + strconv.FormatUint(*d.RestartPolicy.MaxAttempts, 10)
				}
			case "any", "":
				spec.Restart = "always"
			}
		}
		if d.UpdateConfig != nil {
			switch d.UpdateConfig.Order {
			case "start-first":
				strategy = domain.StrategyStartFirst
			case "stop-first":
				strategy = domain.StrategyStopFirst
			}
		}
		if d.Mode != "" && d.Mode != "replicated" {
			return nil, nil, errs.Config("%s: deploy.mode %q makes no sense on one server; use replicas", at, d.Mode)
		}
		if len(d.Placement.Constraints) > 0 || len(d.Placement.Preferences) > 0 {
			warnings = append(warnings, at+": deploy.placement is ignored on one server")
		}
		if d.EndpointMode != "" {
			warnings = append(warnings, at+": deploy.endpoint_mode is ignored on one server")
		}
		if d.RollbackConfig != nil {
			warnings = append(warnings, at+": deploy.rollback_config is ignored: Dockflow rolls back the whole app")
		}
	}
	_ = ignoredDeploy
	if spec.Restart == "" {
		spec.Restart = "unless-stopped"
	}
	spec.Resources.CPUs = math.Round(spec.Resources.CPUs*1000) / 1000

	svc := &domain.Service{
		Name:          s.Name,
		Replicas:      s.GetScale(),
		Spec:          spec,
		ContainerName: s.ContainerName,
		Stateful:      x.Stateful,
		Drain:         domain.Duration(30 * time.Second),
		HealthGrace:   domain.Duration(10 * time.Second),
	}
	switch s.PullPolicy {
	case "", types.PullPolicyMissing, types.PullPolicyIfNotPresent, types.PullPolicyBuild:
		// built images are always built, and pulled by digest from the registry
		svc.PullPolicy = "missing"
	case types.PullPolicyAlways, types.PullPolicyNever:
		svc.PullPolicy = s.PullPolicy
	default:
		return nil, nil, errs.Config("%s: pull_policy %q is not supported yet", at, s.PullPolicy)
	}
	for _, depName := range sortedKeys(s.DependsOn) {
		d := s.DependsOn[depName]
		cond := d.Condition
		if cond == "" {
			cond = types.ServiceConditionStarted
		}
		svc.DependsOn = append(svc.DependsOn, domain.Dependency{Service: depName, Condition: cond})
	}
	switch x.Run {
	case "":
	case domain.JobBefore, domain.JobAfter:
		svc.Job = x.Run
	default:
		return nil, nil, errs.Config("%s: x-dockflow.run must be before or after, not %q", at, x.Run)
	}
	for _, rt := range x.Routes {
		route := domain.Route{Domains: rt.Domains, Path: rt.Path, Port: rt.Port, TLS: true, StripPrefix: rt.StripPrefix}
		if rt.TLS != nil {
			route.TLS = *rt.TLS
		}
		if route.Path == "" {
			route.Path = "/"
		}
		if len(route.Domains) == 0 || route.Port <= 0 {
			return nil, nil, errs.Config("%s: every route needs domains and a port", at)
		}
		if !strings.HasPrefix(route.Path, "/") {
			return nil, nil, errs.Config("%s: route path %q must start with /", at, route.Path)
		}
		svc.Routes = append(svc.Routes, route)
	}
	if x.Rollout != nil && x.Rollout.Drain != "" {
		d, err := time.ParseDuration(x.Rollout.Drain)
		if err != nil {
			return nil, nil, errs.Config("%s: x-dockflow.rollout.drain: %v", at, err)
		}
		svc.Drain = domain.Duration(d)
	}
	if x.Health != nil && x.Health.Grace != "" {
		d, err := time.ParseDuration(x.Health.Grace)
		if err != nil {
			return nil, nil, errs.Config("%s: x-dockflow.health.grace: %v", at, err)
		}
		svc.HealthGrace = domain.Duration(d)
	}
	if x.Health != nil && x.Health.HTTP != nil {
		c, err := httpCheck(at, x.Health.HTTP, x.Routes)
		if err != nil {
			return nil, nil, err
		}
		svc.HTTPCheck = c
	}

	// strategy (ADR-0010)
	if x.Rollout != nil && x.Rollout.Strategy != "" {
		strategy = domain.Strategy(x.Rollout.Strategy)
		switch strategy {
		case domain.StrategySwitch, domain.StrategyStartFirst, domain.StrategyStopFirst:
		default:
			return nil, nil, errs.Config("%s: x-dockflow.rollout.strategy must be switch, start-first or stop-first", at)
		}
	}
	forcesStop := svc.Stateful || svc.ContainerName != "" || fixedPorts || spec.NetworkMode == "host"
	if strategy == "" {
		switch {
		case forcesStop:
			strategy = domain.StrategyStopFirst
		case len(svc.Routes) > 0:
			strategy = domain.StrategySwitch
		default:
			strategy = domain.StrategyStartFirst
		}
	}
	svc.Strategy = strategy
	if strategy != domain.StrategyStopFirst && forcesStop {
		why := "it is stateful"
		switch {
		case svc.ContainerName != "":
			why = "it has a container_name"
		case fixedPorts:
			why = "it publishes fixed host ports"
		case spec.NetworkMode == "host":
			why = "it is on the host network"
		}
		return nil, nil, errs.Config("%s: strategy %s is impossible because %s; use stop-first", at, strategy, why)
	}
	if strategy == domain.StrategySwitch && len(svc.Routes) == 0 {
		return nil, nil, errs.Config("%s: strategy switch needs routes (x-dockflow.routes)", at)
	}
	if len(svc.Routes) > 0 && spec.NetworkMode != "" {
		return nil, nil, errs.Config("%s: a routed service must be on bridge networks, not network_mode %s", at, spec.NetworkMode)
	}
	if (svc.Stateful || svc.ContainerName != "") && svc.Replicas > 1 {
		return nil, nil, errs.Config("%s: a stateful service or one with container_name runs once, not %d times", at, svc.Replicas)
	}
	if svc.Replicas < 0 {
		return nil, nil, errs.Config("%s: replicas cannot be negative", at)
	}
	if len(svc.Routes) > 0 && (spec.Healthcheck == nil || spec.Healthcheck.Disable) {
		warnings = append(warnings, fmt.Sprintf("%s: routed without a healthcheck: it counts as healthy after %s running", at, svc.HealthGrace.D()))
	}
	return svc, warnings, nil
}

func checkKeys(s types.ServiceConfig) error {
	b, err := json.Marshal(s)
	if err != nil {
		return errs.Internal("encode service %s", s.Name).WithCause(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return errs.Internal("decode service %s", s.Name).WithCause(err)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := strings.TrimSpace(string(m[k]))
		if v == "null" || v == "" || v == "[]" || v == "{}" || v == `""` || v == "false" || v == "0" {
			continue
		}
		if ms, ok := later[k]; ok {
			return errs.Config("service %s: `%s` is not available yet in this version of Dockflow", s.Name, k).
				WithHint("it arrives with milestone %s (docs/design/roadmap.md)", ms)
		}
		if !supported[k] {
			return errs.Config("service %s: the Compose key `%s` is not supported yet", s.Name, k).
				WithHint("supported keys are listed in docs/design/spec/config-v1.md#compose-support")
		}
	}
	return nil
}

func checkDependencies(a *domain.App) error {
	names := map[string]bool{}
	for _, s := range a.Services {
		names[s.Name] = true
	}
	for _, s := range a.Services {
		for _, d := range s.DependsOn {
			if !names[d.Service] {
				return errs.Config("service %s depends on %s, which does not exist", s.Name, d.Service)
			}
		}
	}
	if _, err := Order(a); err != nil {
		return err
	}
	return nil
}

// Order returns the service names in an order that respects depends_on, alphabetical among
// services with no dependency between them.
func Order(a *domain.App) ([]string, error) {
	deps := map[string][]string{}
	for _, s := range a.Services {
		for _, d := range s.DependsOn {
			deps[s.Name] = append(deps[s.Name], d.Service)
		}
	}
	var out []string
	state := map[string]int{} // 1 visiting, 2 done
	var visit func(string) error
	visit = func(n string) error {
		switch state[n] {
		case 1:
			return errs.Config("depends_on has a cycle through %s", n)
		case 2:
			return nil
		}
		state[n] = 1
		ds := append([]string{}, deps[n]...)
		sort.Strings(ds)
		for _, d := range ds {
			if err := visit(d); err != nil {
				return err
			}
		}
		state[n] = 2
		out = append(out, n)
		return nil
	}
	names := make([]string, 0, len(a.Services))
	for _, s := range a.Services {
		names = append(names, s.Name)
	}
	sort.Strings(names)
	for _, n := range names {
		if err := visit(n); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func dur(d *types.Duration) *domain.Duration {
	if d == nil {
		return nil
	}
	v := domain.Duration(*d)
	return &v
}

func copyMap(m map[string]string) map[string]string {
	if len(m) == 0 {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
