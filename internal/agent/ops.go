package agent

import (
	"context"
	"fmt"
	"maps"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
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

// recover makes the environment consistent before a run plans, under the lock. env.json is the
// commit point (state-v1.md): a commit an agent did not finish is completed, and the current
// release is restored after a run that did not finish: an agent that died, or a failed run left
// in place (on_failure: fail). Each step can be cut and done again: a release is marked
// abandoned last.
func (r *runner) recover(ctx context.Context) error {
	if err := r.removeJobs(ctx); err != nil {
		return err
	}
	if err := r.settle(); err != nil {
		return err
	}
	env, err := r.app.Env()
	if err != nil {
		return err
	}
	abandoned, inPlace, err := r.unfinished(env)
	if err != nil {
		return err
	}
	o, err := observe(ctx, r.Engine, r.app, r.stack)
	if err != nil {
		return err
	}
	fixes, stopped := r.fixes(o)
	table, err := r.Store.SwitchRoutes()
	if err != nil {
		return err
	}
	stale := !sameUpstreams(table[r.stack], r.currentRoutes(o, fixes))
	pending := env != nil && env.LastSeq > env.Current
	if len(abandoned) == 0 && len(o.leftovers) == 0 && !stale && (!stopped || !pending) {
		return nil
	}
	current := 0
	if env != nil {
		current = env.Current
	}
	for _, rel := range abandoned {
		r.warn("run.abandoned", fmt.Sprintf("release %d was abandoned by run %s: restoring release %d", rel.Seq, rel.Run, current))
	}
	if inPlace != nil && (len(o.leftovers) > 0 || stopped) {
		r.warn("run.unfinished", fmt.Sprintf("release %d failed and was left in place: restoring release %d", inPlace.Seq, current))
	}
	// nothing changes in a state that a newer Dockflow wrote
	if err := r.app.Writable(); err != nil {
		return err
	}
	if err := r.restore(ctx, o, fixes); err != nil {
		return err
	}
	for _, rel := range abandoned {
		now := r.Now().UTC()
		rel.Status, rel.FinishedAt = domain.StatusAbandoned, &now
		rel.Serving, rel.Hashes = nil, nil
		rel.Error = &domain.ReleaseError{Code: "run.abandoned", Message: fmt.Sprintf("the agent stopped before the run finished; release %d was restored", current)}
		if err := r.app.WriteRelease(rel); err != nil {
			return err
		}
	}
	return nil
}

// unfinished returns the releases a run left applying, which no run holds since the lock is
// held, and the latest release when it failed and was left in place. A release marked active
// that env.json does not name is one whose agent, of a version before env.json was the commit
// point, died during its commit: it is abandoned too.
func (r *runner) unfinished(env *domain.EnvRecord) (abandoned []*domain.Release, inPlace *domain.Release, err error) {
	current := 0
	if env != nil {
		current = env.Current
	}
	seqs, err := r.app.Releases()
	if err != nil {
		return nil, nil, err
	}
	for _, seq := range seqs {
		if seq <= current {
			continue
		}
		rel, err := r.app.Release(seq)
		if err != nil {
			return nil, nil, err
		}
		if rel == nil {
			continue
		}
		switch rel.Status {
		case domain.StatusApplying, domain.StatusActive:
			abandoned = append(abandoned, rel)
		case domain.StatusFailed:
			if env != nil && seq == env.LastSeq {
				inPlace = rel
			}
		}
	}
	return abandoned, inPlace, nil
}

// fix is a container of the current release, and the name it must have.
type fix struct {
	c      engine.Container
	proper string
}

// fixes lists the containers of the current release with their names, and tells whether one is
// stopped.
func (r *runner) fixes(o *observed) ([]fix, bool) {
	var out []fix
	stopped := false
	for _, name := range slices.Sorted(maps.Keys(o.serving)) {
		var s *domain.Service
		if o.current != nil {
			s, _ = o.current.Desired.Service(name)
		}
		for _, c := range o.serving[name] {
			proper := c.Name
			if s != nil {
				proper = containerName(r.stack, s, c.Release, max(number(c), 1))
			}
			out = append(out, fix{c: c, proper: proper})
			stopped = stopped || (c.State != "running" && c.State != "restarting")
		}
	}
	return out, stopped
}

// currentRoutes are the routes of the current release, served by its containers.
func (r *runner) currentRoutes(o *observed, fixes []fix) []proxy.Route {
	if o.current == nil {
		return nil
	}
	serving := map[string][]string{}
	for _, f := range fixes {
		serving[f.c.Service] = append(serving[f.c.Service], f.proper)
	}
	return routesFor(r.stack, &o.current.Desired, serving)
}

// sameUpstreams tells whether two sets of routes send each route to the same containers.
func sameUpstreams(a, b []proxy.Route) bool {
	key := func(rs []proxy.Route) map[string]string {
		m := map[string]string{}
		for _, rt := range rs {
			m[rt.Service+" "+strings.Join(rt.Domains, ",")+rt.Path] = strings.Join(slices.Sorted(slices.Values(rt.Upstreams)), ",")
		}
		return m
	}
	return maps.Equal(key(a), key(b))
}

// restore brings back the current release: the containers of other releases go, its own get
// their names back and run, and the switch points at them. A routed service keeps serving: its
// leftovers go once the routes have moved.
func (r *runner) restore(ctx context.Context, o *observed, fixes []fix) error {
	need := map[string]bool{}
	for _, f := range fixes {
		need[f.proper] = true
	}
	remove := func(c engine.Container) error {
		r.warn("run.leftover", fmt.Sprintf("removing %s, left by an unfinished run", c.Name))
		return r.Engine.Remove(ctx, c.ID)
	}
	var later []engine.Container
	for _, c := range o.leftovers {
		var s *domain.Service
		if o.current != nil {
			s, _ = o.current.Desired.Service(c.Service)
		}
		// those in the way go first: holding a name, or the host ports of a stop-first service
		if s != nil && len(s.Routes) > 0 && s.Strategy != domain.StrategyStopFirst && !need[c.Name] {
			later = append(later, c)
			continue
		}
		if err := remove(c); err != nil {
			return err
		}
	}
	var started, names []string
	for _, f := range fixes {
		if f.c.Name != f.proper {
			if err := r.Engine.Rename(ctx, f.c.ID, f.proper); err != nil {
				return err
			}
		}
		if f.c.State != "running" && f.c.State != "restarting" {
			r.warn("run.restarted", "starting "+f.proper+", stopped by an unfinished run")
			if err := r.Engine.Start(ctx, f.c.ID); err != nil {
				return err
			}
			started, names = append(started, f.c.ID), append(names, f.proper)
		}
	}
	for i, err := range r.waitAll(ctx, started) {
		if err != nil {
			r.warn("run.restarted", fmt.Sprintf("%s is running again, but not healthy: %v", names[i], err))
		}
	}
	if o.current != nil {
		// an interrupted upload may have changed some files: put the current ones back
		for _, u := range o.current.Desired.Uploads {
			if _, _, err := r.applyUpload(ctx, u, u.Manifest, u.Mirror); err != nil {
				return err
			}
		}
		r.forgetBaselines()
	}
	if err := r.applyRoutes(ctx, r.currentRoutes(o, fixes)); err != nil {
		return err
	}
	for _, c := range later {
		if err := remove(c); err != nil {
			return err
		}
	}
	return nil
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
		image = r.upgraded(ctx, image, r.req.RegistryImage, DefaultRegistryImage)
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
		image = r.upgraded(ctx, image, r.req.SwitchImage, DefaultSwitchImage)
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

// upgraded is the image to run. With server upgrade, an image of the default's repository moves
// to def, the image this version pins; another one, chosen with --switch-image or
// --registry-image, is pulled again by its tag. An image the run names stays, and so does the
// server's when def cannot be pulled.
func (r *runner) upgraded(ctx context.Context, image, given, def string) string {
	if !r.req.Upgrade || given != "" {
		return image
	}
	if sameRepository(image, def) {
		if image == def {
			return image
		}
		if _, err := r.Engine.ResolveImage(ctx, def, "missing", nil); err != nil {
			r.warn("upgrade.pull", "cannot pull "+def+", the server's image stays: "+err.Error())
			return image
		}
		return def
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
	RegistryContainer = "dockflow-registry"
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
