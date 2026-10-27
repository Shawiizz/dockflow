package agent

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// recover brings the environment back to its current release after a run that did not finish:
// an agent that died, or a failed run left in place. It runs under the lock, before planning.
func (r *runner) recover(ctx context.Context) error {
	if err := r.removeJobs(ctx); err != nil {
		return err
	}
	env, err := r.app.Env()
	if err != nil {
		return err
	}
	unfinished := false
	if env != nil && env.LastSeq > env.Current {
		rel, err := r.app.Release(env.LastSeq)
		if err != nil {
			return err
		}
		if rel != nil && rel.Status == domain.StatusApplying {
			now := r.Now().UTC()
			rel.Status, rel.FinishedAt = domain.StatusAbandoned, &now
			rel.Error = &domain.ReleaseError{Code: "run.abandoned", Message: "the agent stopped before the run finished"}
			if err := r.app.WriteRelease(rel); err != nil {
				return err
			}
			r.warn("run.abandoned", fmt.Sprintf("release %d was abandoned by run %s: restoring release %d", rel.Seq, rel.Run, env.Current))
			unfinished = true
		}
	}
	o, err := observe(ctx, r.Engine, r.app, r.stack)
	if err != nil {
		return err
	}
	if len(o.leftovers) == 0 && !unfinished {
		return nil
	}
	for _, c := range o.leftovers {
		r.warn("run.leftover", fmt.Sprintf("removing %s, left by an unfinished run", c.Name))
		if err := r.Engine.Remove(ctx, c.ID); err != nil {
			return err
		}
	}
	serving := map[string][]string{}
	for name, cs := range o.serving {
		var s *domain.Service
		if o.current != nil {
			s, _ = o.current.Desired.Service(name)
		}
		for _, c := range cs {
			proper := c.Name
			if s != nil {
				proper = containerName(r.stack, s, c.Release, max(number(c), 1))
			}
			if c.Name != proper {
				if err := r.Engine.Rename(ctx, c.ID, proper); err != nil {
					return err
				}
			}
			if c.State != "running" && c.State != "restarting" {
				r.warn("run.restarted", "starting "+proper+", stopped by an unfinished run")
				if err := r.Engine.Start(ctx, c.ID); err != nil {
					return err
				}
			}
			serving[name] = append(serving[name], proper)
		}
	}
	var routes []proxy.Route
	if o.current != nil {
		routes = routesFor(r.stack, &o.current.Desired, serving)
		// an interrupted upload may have changed some files: put the current ones back
		for _, u := range o.current.Desired.Uploads {
			if _, _, err := r.applyUpload(ctx, u, u.Manifest, u.Mirror); err != nil {
				return err
			}
		}
		r.forgetBaselines()
	}
	return r.applyRoutes(ctx, routes)
}

func (r *runner) status(ctx context.Context) events.RunFinishedData {
	o, err := observe(ctx, r.Engine, r.app, r.stack)
	if err != nil {
		return failed(err)
	}
	st := Status{App: r.req.App, Env: r.req.Env, State: o.actual.Env, Services: []ServiceStatus{}}
	st.DiskFree, st.DiskTotal = diskUsage(r.Store.Root())
	if st.Lock, err = r.app.ManualLock(); err != nil {
		return failed(err)
	}
	if wd, err := r.app.Watchdog(); err == nil {
		st.Watchdog = wd.Restarts
		if n := len(st.Watchdog); n > 5 {
			st.Watchdog = st.Watchdog[n-5:]
		}
	}
	names := map[string]bool{}
	if o.current != nil {
		sum := Summarise(o.current)
		st.Current = &sum
		for _, s := range o.current.Desired.Services {
			if s.Job == "" {
				names[s.Name] = true
			}
		}
	}
	for name := range o.actual.Services {
		names[name] = true
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	for _, name := range sorted {
		ss := ServiceStatus{Name: name, Containers: []domain.ContainerInfo{}}
		if o.current != nil {
			if s, ok := o.current.Desired.Service(name); ok {
				ss.Strategy, ss.Desired = s.Strategy, s.Count()
				for _, rt := range s.Routes {
					for _, d := range rt.Domains {
						ss.Domains = append(ss.Domains, d+rt.Path)
					}
				}
			}
		}
		if as, ok := o.actual.Services[name]; ok {
			ss.Release = as.Release
			ss.Containers = as.Containers
			for _, c := range as.Containers {
				if c.State == "running" && c.Health != "unhealthy" {
					ss.Running++
				}
			}
		}
		st.Services = append(st.Services, ss)
	}
	r.result(st)
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

func (r *runner) releases() events.RunFinishedData {
	seqs, err := r.app.Releases()
	if err != nil {
		return failed(err)
	}
	env, err := r.app.Env()
	if err != nil {
		return failed(err)
	}
	list := []ReleaseSummary{}
	for i := len(seqs) - 1; i >= 0; i-- {
		rel, err := r.app.Release(seqs[i])
		if err != nil {
			return failed(err)
		}
		if rel != nil {
			list = append(list, Summarise(rel))
		}
	}
	r.result(map[string]any{"state": env, "releases": list})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// Switch volumes: Caddy's data (certificates), its autosaved configuration, and the admin socket.
const (
	SwitchAdminVolume  = "dockflow-switch-admin"
	switchDataVolume   = "dockflow-switch-data"
	switchConfigVolume = "dockflow-switch-config"
	// DefaultSwitchImage is the official Caddy image; it is pinned by digest when installed.
	DefaultSwitchImage = "caddy:2"
)

// SwitchAdminDir is where the switch's shared volume is mounted, in the switch and in the agent.
const SwitchAdminDir = proxy.SharedDir

// serverInit installs or updates the switch, the registry and the watchdog, and records the
// server's settings.
func (r *runner) serverInit(ctx context.Context) events.RunFinishedData {
	// an option the run does not give keeps what the server has
	previous, err := r.Store.Server()
	if err != nil {
		return failed(err)
	}
	if previous == nil {
		previous = &state.Server{}
	}
	edge := r.req.Edge
	if edge == "" {
		edge = previous.Edge
	}
	if edge == "" {
		edge = proxy.EdgeBuiltin
	}
	listen, trusted := "", r.req.TrustedProxies
	switch edge {
	case proxy.EdgeBuiltin, proxy.EdgeNone, proxy.EdgeCloudflare:
		if r.req.SwitchListen != "" || len(trusted) > 0 {
			return failed(errs.Usage("--switch-listen and --trusted-proxy go with --edge external"))
		}
	case proxy.EdgeExternal:
		listen = r.req.SwitchListen
		if previous.Edge == proxy.EdgeExternal {
			if listen == "" {
				listen = previous.SwitchListen
			}
			if trusted == nil {
				trusted = previous.TrustedProxies
			}
		}
		if listen == "" {
			listen = proxy.DefaultListen
		}
		if _, _, err := splitListen(listen); err != nil {
			return failed(err)
		}
		for _, cidr := range trusted {
			if _, err := netip.ParsePrefix(cidr); err != nil {
				return failed(errs.Usage("--trusted-proxy %q is not a CIDR", cidr))
			}
		}
	default:
		return failed(errs.Usage("edge %q is not an edge: use builtin, cloudflare, external or none", edge))
	}
	l, err := r.Store.LockServer()
	if err != nil {
		return failed(err)
	}
	table, err := r.Store.SwitchRoutes()
	l.Release()
	if err != nil {
		return failed(err)
	}
	srv := state.Server{Name: r.req.Server, Edge: edge, DockflowVersion: r.req.DockflowVersion, SwitchListen: listen, TrustedProxies: trusted,
		NoPortFilter: previous.NoPortFilter, NoWatchdog: previous.NoWatchdog, SSHPort: r.req.SSHPort}
	if r.req.PortFilter != nil {
		srv.NoPortFilter = !*r.req.PortFilter
	}
	if r.req.Watchdog != nil {
		srv.NoWatchdog = !*r.req.Watchdog
	}
	if srv.SSHPort == 0 {
		srv.SSHPort = previous.SSHPort
	}
	srv.ACMEEmail = previous.ACMEEmail
	if r.req.ACMEEmail != nil {
		srv.ACMEEmail = *r.req.ACMEEmail
		if srv.ACMEEmail != "" && !acmeEmail.MatchString(srv.ACMEEmail) {
			return failed(errs.Usage("--acme-email %q is not an email address", srv.ACMEEmail))
		}
	}
	srv.ACMECA = previous.ACMECA
	if r.req.ACMECA != nil {
		srv.ACMECA = *r.req.ACMECA
		if u, err := url.Parse(srv.ACMECA); srv.ACMECA != "" && (err != nil || u.Scheme != "https" || u.Host == "") {
			return failed(errs.Usage("--acme-ca %q is not the https URL of an ACME directory", srv.ACMECA))
		}
	}
	if edge == proxy.EdgeCloudflare {
		srv.CloudflareRanges = r.cloudflareRanges(ctx, previous.CloudflareRanges)
	}
	// a server that was initialised without a registry has no registry image
	registry := previous.Edge == "" || previous.RegistryImage != ""
	if r.req.Registry != nil {
		registry = *r.req.Registry
	}

	// the registry first: it needs no network, and the switch's ports are the likelier failure
	if registry {
		image := r.req.RegistryImage
		if image == "" {
			image = previous.RegistryImage
		}
		if image == "" {
			image = DefaultRegistryImage
		}
		image = r.upgraded(image, r.req.RegistryImage)
		pinned, err := r.ensure(ctx, RegistryContainer, domain.KindRegistry, image, registrySpec,
			"port 5959 must be free on the server's loopback")
		if err != nil {
			return failed(err)
		}
		srv.RegistryImage = pinned
	} else if err := r.removeKind(ctx, domain.KindRegistry); err != nil {
		return failed(err)
	}

	routes := state.AllRoutes(table)
	if edge == proxy.EdgeNone {
		if len(routes) > 0 {
			return failed(errs.Plan("server.routes_in_use", "%d routes still go through the switch", len(routes)).
				WithHint("remove the routes of the apps on this server first"))
		}
		if err := r.removeKind(ctx, domain.KindSwitch); err != nil {
			return failed(err)
		}
	} else {
		image := r.req.SwitchImage
		if image == "" {
			image = previous.SwitchImage
		}
		if image == "" {
			image = DefaultSwitchImage
		}
		image = r.upgraded(image, r.req.SwitchImage)
		hint := "ports 80 and 443 must be free on the server"
		if edge == proxy.EdgeExternal {
			hint = listen + " must be free on the server"
		}
		specOf := func(image string) domain.ContainerSpec { return switchSpec(image, edge, listen) }
		if srv.SwitchImage, err = r.ensure(ctx, SwitchContainer, domain.KindSwitch, image, specOf, hint); err != nil {
			return failed(err)
		}
	}
	if srv.NoWatchdog {
		if err := r.removeKind(ctx, domain.KindWatchdog); err != nil {
			return failed(err)
		}
	} else {
		if r.req.AgentImage == "" {
			return failed(errs.Internal("the agent's image is unknown"))
		}
		if srv.WatchdogImage, err = r.ensure(ctx, WatchdogContainer, domain.KindWatchdog, r.req.AgentImage, watchdogSpec, "the watchdog runs the agent's image"); err != nil {
			return failed(err)
		}
	}
	if err := r.Store.WriteServer(srv); err != nil {
		return failed(err)
	}
	if edge != proxy.EdgeNone {
		// a new switch starts empty: give it every app's routes back
		if err := r.joinNetworks(ctx, routes); err != nil {
			return failed(err)
		}
		if r.Switch == nil {
			return failed(errs.Internal("the agent has no switch client"))
		}
		cfg := switchConfig(&srv, routes)
		cfg.Reload = true
		if err := r.Switch.Apply(ctx, cfg); err != nil {
			return failed(err)
		}
	}
	switch {
	case !srv.NoPortFilter:
		if err := r.syncFilter(ctx); err != nil {
			return failed(err)
		}
	case previous.Edge != "" && !previous.NoPortFilter:
		// --no-port-filter on a server that had it: an empty chain lets everything in
		if err := r.clearFilter(ctx); err != nil {
			return failed(err)
		}
	}
	if s, err := r.Store.Server(); err == nil && s != nil {
		srv = *s
	}
	r.result(srv)
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// upgraded is the image to run: with server upgrade, the server's image is pulled again by its
// name, unless the run names an image.
func (r *runner) upgraded(image, given string) string {
	if !r.req.Upgrade || given != "" {
		return image
	}
	if i := strings.Index(image, "@sha256:"); i > 0 {
		return image[:i] + "#pull"
	}
	return image
}

// ensure runs the system container name from image, replacing it when its spec changed. It
// returns the pinned image. An image marked #pull is pulled again: an upgrade.
func (r *runner) ensure(ctx context.Context, name, kind, image string, specOf func(string) domain.ContainerSpec, startHint string) (string, error) {
	policy := "missing"
	if ref, ok := strings.CutSuffix(image, "#pull"); ok {
		image, policy = ref, "always"
	}
	pinned, err := r.Engine.ResolveImage(ctx, image, policy, nil)
	if err != nil && policy == "always" {
		// no registry to reach: the image the server has stays
		r.warn("upgrade.pull", "cannot pull "+image+", the server's image stays: "+err.Error())
		pinned, err = r.Engine.ResolveImage(ctx, image, "missing", nil)
	}
	if err != nil {
		return "", err
	}
	spec := specOf(pinned)
	labels := map[string]string{
		domain.LabelKind: kind, domain.LabelSchema: "1", domain.LabelManagedBy: "true",
		domain.LabelHash: (&domain.Service{Name: name, Spec: spec, Replicas: 1}).Hash(),
	}
	existing, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelKind: kind}})
	if err != nil {
		return "", err
	}
	var keep *engine.Container
	for i, c := range existing {
		if c.Hash == labels[domain.LabelHash] && keep == nil {
			keep = &existing[i]
			continue
		}
		r.ev.Info(events.Log, "replacing "+c.Name, map[string]any{"line": "remove " + c.Name})
		if err := r.Engine.Remove(ctx, c.ID); err != nil {
			return "", err
		}
	}
	if keep != nil {
		if keep.State != "running" {
			return pinned, r.Engine.Start(ctx, keep.ID)
		}
		return pinned, nil
	}
	id, err := r.Engine.Create(ctx, name, spec, labels)
	if err != nil {
		return "", err
	}
	if err := r.Engine.Start(ctx, id); err != nil {
		return "", errs.Newf("server.start_failed", errs.ExitInternal, "%s cannot start", name).WithCause(err).WithHint("%s", startHint)
	}
	r.ev.Info(events.Log, name+" installed", map[string]any{"line": name + " " + pinned})
	return pinned, nil
}

func (r *runner) removeKind(ctx context.Context, kind string) error {
	cs, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelKind: kind}})
	if err != nil {
		return err
	}
	for _, c := range cs {
		if err := r.Engine.Remove(ctx, c.ID); err != nil {
			return err
		}
	}
	return nil
}

// The server-local registry (ADR-0009): loopback only, reached by the CLI through an SSH tunnel.
const (
	RegistryContainer    = "dockflow-registry"
	DefaultRegistryImage = "registry:3"
	// RegistryAddr is where it listens, on the server; images are named after it.
	RegistryAddr   = "127.0.0.1:5959"
	registryVolume = "dockflow-registry-data"
)

func registrySpec(image string) domain.ContainerSpec {
	return domain.ContainerSpec{
		Image:   image,
		Env:     []string{"OTEL_TRACES_EXPORTER=none", "REGISTRY_STORAGE_DELETE_ENABLED=true"},
		Restart: "unless-stopped",
		Ports:   []domain.Port{{HostIP: "127.0.0.1", HostPort: "5959", ContainerPort: 5000, Protocol: "tcp"}},
		Mounts:  []domain.Mount{{Type: "volume", Source: registryVolume, Target: "/var/lib/registry"}},
		Logging: &domain.Logging{Driver: "json-file", Options: map[string]string{"max-size": "10m", "max-file": "3"}},
	}
}

// acmeEmail is what an ACME account's contact looks like.
var acmeEmail = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// switchConfig is the switch's configuration for a server's settings and routes.
func switchConfig(srv *state.Server, routes []proxy.Route) proxy.Config {
	c := proxy.Config{Edge: proxy.EdgeBuiltin, Routes: routes}
	if srv != nil && srv.Edge != "" {
		c.Edge, c.TrustedProxies, c.ACMEEmail, c.ACMECA = srv.Edge, srv.TrustedProxies, srv.ACMEEmail, srv.ACMECA
	}
	if c.Edge == proxy.EdgeCloudflare {
		c.TrustedProxies = srv.CloudflareRanges
	}
	return c
}

func splitListen(listen string) (string, string, error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "", "", errs.Usage("--switch-listen %q is not an address and a port", listen)
	}
	if _, err := netip.ParseAddr(host); err != nil {
		return "", "", errs.Usage("--switch-listen %q: the host must be an IP address", listen)
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return "", "", errs.Usage("--switch-listen %q: the port is not valid", listen)
	}
	return host, port, nil
}

func switchSpec(image, edge, listen string) domain.ContainerSpec {
	ports := []domain.Port{
		{HostPort: "80", ContainerPort: 80, Protocol: "tcp"},
		{HostPort: "443", ContainerPort: 443, Protocol: "tcp"},
		{HostPort: "443", ContainerPort: 443, Protocol: "udp"},
	}
	if edge == proxy.EdgeExternal {
		host, port, _ := splitListen(listen)
		ports = []domain.Port{{HostIP: host, HostPort: port, ContainerPort: proxy.ExternalPort, Protocol: "tcp"}}
	}
	return domain.ContainerSpec{
		Image:   image,
		Command: []string{"caddy", "run", "--resume"},
		Env:     []string{"CADDY_ADMIN=unix/" + SwitchAdminDir + "/admin.sock"},
		Restart: "unless-stopped",
		Ports:   ports,
		Mounts: []domain.Mount{
			{Type: "volume", Source: switchDataVolume, Target: "/data"},
			{Type: "volume", Source: switchConfigVolume, Target: "/config"},
			{Type: "volume", Source: SwitchAdminVolume, Target: SwitchAdminDir},
		},
		Logging: &domain.Logging{Driver: "json-file", Options: map[string]string{"max-size": "10m", "max-file": "3"}},
	}
}
