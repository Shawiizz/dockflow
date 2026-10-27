package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/provision"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// ServerStatus is what `dockflow server status` shows.
type ServerStatus struct {
	Server     *state.Server    `json:"server"`
	Docker     string           `json:"docker"`
	Components []ComponentState `json:"components"`
	Apps       []AppState       `json:"apps"`
	DiskFree   uint64           `json:"disk_free,omitempty"`
	DiskTotal  uint64           `json:"disk_total,omitempty"`
}

// ComponentState is one of Dockflow's own containers.
type ComponentState struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Image string `json:"image,omitempty"`
}

// AppState is one app environment of the server.
type AppState struct {
	Stack    string `json:"stack"`
	Release  int    `json:"release,omitempty"`
	Version  string `json:"version,omitempty"`
	Degraded bool   `json:"degraded,omitempty"`
	Running  int    `json:"running"`
	Total    int    `json:"total"`
}

// serverStatus describes the whole server: its settings, Dockflow's containers, every app
// environment.
func (r *runner) serverStatus(ctx context.Context) events.RunFinishedData {
	srv, err := r.Store.Server()
	if err != nil {
		return failed(err)
	}
	st := ServerStatus{Server: srv, Components: []ComponentState{}, Apps: []AppState{}}
	if info, err := r.Engine.Info(ctx); err == nil {
		st.Docker = info.EngineVersion
	}
	st.DiskFree, st.DiskTotal = diskUsage(r.Store.Root())
	for _, c := range []struct{ name, kind string }{
		{SwitchContainer, domain.KindSwitch}, {RegistryContainer, domain.KindRegistry}, {WatchdogContainer, domain.KindWatchdog},
	} {
		cs, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelKind: c.kind}})
		if err != nil {
			return failed(err)
		}
		cst := ComponentState{Name: c.name, State: "absent"}
		if len(cs) > 0 {
			cst.State, cst.Image = cs[0].State, cs[0].Image
			if h := cs[0].Health; h != "" && h != "none" && cs[0].State == "running" {
				cst.State += " (" + h + ")"
			}
		}
		st.Components = append(st.Components, cst)
	}
	stacks, err := r.Store.Stacks()
	if err != nil {
		return failed(err)
	}
	for _, stack := range stacks {
		app, err := r.Store.App(stack)
		if err != nil {
			return failed(err)
		}
		as := AppState{Stack: stack}
		env, err := app.Env()
		if err != nil || env == nil {
			// destroyed: only its lock file is left
			continue
		}
		as.Release, as.Degraded = env.Current, env.Degraded
		if rel, err := app.Release(env.Current); err == nil && rel != nil {
			as.Version = rel.Version
		}
		cs, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelProject: stack, domain.LabelKind: domain.KindService}})
		if err != nil {
			return failed(err)
		}
		for _, c := range cs {
			as.Total++
			if c.State == "running" && c.Health != "unhealthy" {
				as.Running++
			}
		}
		st.Apps = append(st.Apps, as)
	}
	r.result(st)
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// Check is one finding of `dockflow server check`.
type Check struct {
	Name string `json:"name"`
	// Level is ok, warn or fail.
	Level  string `json:"level"`
	Detail string `json:"detail"`
	Hint   string `json:"hint,omitempty"`
}

// serverCheck checks what Dockflow needs on the server: Docker, the secrets' tmpfs, the state
// directory, the ports of the switch, the disk, and Dockflow's own containers.
func (r *runner) serverCheck(ctx context.Context) events.RunFinishedData {
	var checks []Check
	add := func(name, level, detail, hint string) {
		checks = append(checks, Check{Name: name, Level: level, Detail: detail, Hint: hint})
	}
	info, err := r.Engine.Info(ctx)
	if err != nil {
		return failed(err)
	}
	major, _ := strconv.Atoi(strings.SplitN(info.EngineVersion, ".", 2)[0])
	if major >= provision.MinDocker {
		add("docker", "ok", "Docker "+info.EngineVersion+" on "+info.OS+", "+info.Arch, "")
	} else {
		add("docker", "fail", "Docker "+info.EngineVersion+" is older than "+strconv.Itoa(provision.MinDocker), "upgrade Docker Engine")
	}
	if ok, err := onTmpfs(domain.SecretsRoot[:len("/run/dockflow")]); err == nil && ok {
		add("secrets", "ok", "/run/dockflow is a tmpfs", "")
	} else {
		add("secrets", "warn", "/run/dockflow is not a tmpfs: apps with Compose secrets cannot deploy", "mount a tmpfs on /run/dockflow (systemd mounts one on /run)")
	}
	if st, err := os.Stat(r.Store.Root()); err == nil && st.Mode().Perm() == 0o700 {
		add("state", "ok", r.Store.Root()+" is root's only", "")
	} else {
		add("state", "fail", r.Store.Root()+" is not 0700", "chmod 700 "+r.Store.Root())
	}
	free, total := diskUsage(r.Store.Root())
	switch {
	case total == 0:
	case free < 2<<30 || (free*20 < total && free < 10<<30):
		add("disk", "warn", fmt.Sprintf("%s free of %s", humanSize(free), humanSize(total)), "run dockflow prune")
	default:
		add("disk", "ok", fmt.Sprintf("%s free of %s", humanSize(free), humanSize(total)), "")
	}
	srv, err := r.Store.Server()
	if err != nil {
		return failed(err)
	}
	if srv == nil {
		add("server", "warn", "server init has not run on this server", "run dockflow server init")
	}
	running := map[string]bool{}
	for _, kind := range []string{domain.KindSwitch, domain.KindRegistry, domain.KindWatchdog} {
		cs, err := r.Engine.Containers(ctx, engine.Filter{Labels: map[string]string{domain.LabelKind: kind}})
		if err != nil {
			return failed(err)
		}
		running[kind] = len(cs) > 0
	}
	if srv != nil {
		want := []struct {
			kind, name string
			on         bool
		}{
			{domain.KindSwitch, "switch", srv.Edge != proxy.EdgeNone},
			{domain.KindRegistry, "registry", srv.RegistryImage != ""},
			{domain.KindWatchdog, "watchdog", srv.WatchdogImage != ""},
		}
		for _, w := range want {
			switch {
			case w.on && running[w.kind]:
				add(w.name, "ok", "running", "")
			case w.on:
				add(w.name, "fail", "not running", "run dockflow server init <env> to start it again")
			}
		}
		if srv.NoPortFilter {
			add("filter", "warn", "off: every port Docker publishes on a public address is open", "run server init --no-port-filter=false")
		} else if srv.FilterRules != "" {
			add("filter", "ok", "applied", "")
		} else {
			add("filter", "warn", "never applied", "run dockflow server init <env>")
		}
	}
	// the switch's ports, when the edge needs them and the switch does not hold them yet
	if (srv == nil || srv.Edge == proxy.EdgeBuiltin || srv.Edge == proxy.EdgeCloudflare) && !running[domain.KindSwitch] {
		out, err := r.runHelper(ctx, "probe", []string{"probe", "80", "443"}, nil, false)
		var ports map[string]string
		if err == nil && json.Unmarshal([]byte(lastLine(out)), &ports) == nil {
			for _, p := range []string{"80", "443"} {
				if ports[p] == "free" {
					add("port "+p, "ok", "free for the switch", "")
				} else {
					add("port "+p, "fail", "held by another program", "stop it, or use --edge external behind it")
				}
			}
		}
	}
	r.result(map[string]any{"checks": checks})
	for _, c := range checks {
		if c.Level == "fail" {
			return events.RunFinishedData{Outcome: events.OutcomeFailed, ExitCode: errs.ExitDegraded,
				Error: &events.ErrorData{Code: "check.failed", Message: c.Name + ": " + c.Detail, Hint: c.Hint}}
		}
	}
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

func humanSize(n uint64) string {
	const gib = 1 << 30
	if n >= gib {
		return fmt.Sprintf("%.1f GiB", float64(n)/gib)
	}
	return fmt.Sprintf("%d MiB", n>>20)
}

// uninstall removes Dockflow from the server: every app environment (their volumes with
// Volumes), the switch, the registry, the watchdog, the shared networks, the port filter and the
// state. The deploy user, Docker and the volume plugins stay.
func (r *runner) uninstall(ctx context.Context) events.RunFinishedData {
	ctx = context.WithoutCancel(ctx)
	sl, err := r.Store.LockServer()
	if err != nil {
		return failed(err)
	}
	defer sl.Release()
	stacks, err := r.Store.Stacks()
	if err != nil {
		return failed(err)
	}
	// every environment's lock first: none may be deploying
	var locks []*state.Lock
	defer func() {
		for _, l := range locks {
			l.Release()
		}
	}()
	for _, stack := range stacks {
		app, err := r.Store.App(stack)
		if err != nil {
			return failed(err)
		}
		l, err := app.Lock(domain.LockInfo{Run: r.req.Run, Op: r.req.Op, By: by(r.req.Author), Since: r.Now().UTC()})
		if err != nil {
			return failed(errs.Newf("lock.held", errs.ExitLocked, "%s: %s", stack, err.Error()))
		}
		locks = append(locks, l)
	}
	removed := map[string]int{}
	nets, err := r.Engine.Networks(ctx)
	if err != nil {
		return failed(err)
	}
	for _, stack := range stacks {
		app, _ := r.Store.App(stack)
		cs, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelProject: stack}})
		if err != nil {
			return failed(err)
		}
		for _, c := range cs {
			if c.Labels[domain.LabelKind] == domain.KindRun {
				continue
			}
			if err := r.Engine.Remove(ctx, c.ID); err != nil {
				return failed(err)
			}
			removed["containers"]++
		}
		if r.req.Volumes {
			if env, err := app.Env(); err == nil && env != nil {
				for _, seq := range []int{env.Current, env.Previous} {
					rel, err := app.Release(seq)
					if err != nil || rel == nil {
						continue
					}
					for _, v := range rel.Desired.Volumes {
						if !v.External {
							if err := r.Engine.RemoveVolume(ctx, v.Name); err == nil {
								removed["volumes"]++
							}
						}
					}
				}
			}
		}
		os.RemoveAll(filepath.Join(domain.SecretsRoot, stack))
		r.ev.Info(events.Log, stack+" removed", map[string]any{"line": "remove " + stack})
	}
	for _, kind := range []string{domain.KindSwitch, domain.KindRegistry, domain.KindWatchdog} {
		if err := r.removeKind(ctx, kind); err != nil {
			return failed(err)
		}
	}
	// the networks once no container of Dockflow's, the switch included, is on them
	for _, stack := range stacks {
		for name, project := range nets {
			if project == stack {
				if err := r.Engine.RemoveNetwork(ctx, name); err != nil {
					r.warn("uninstall.network", err.Error())
				} else {
					removed["networks"]++
				}
			}
		}
	}
	// the switch's admin volume is the agents' too: the CLI removes it once this one is done
	systemVolumes := []string{switchDataVolume, switchConfigVolume, registryVolume}
	if r.req.Volumes {
		// the backups go with the data, and only then
		systemVolumes = append(systemVolumes, BackupsVolume, BackupsCacheVolume)
	}
	for _, v := range systemVolumes {
		if err := r.Engine.RemoveVolume(ctx, v); err != nil && (v != BackupsVolume && v != BackupsCacheVolume) {
			r.warn("uninstall.volume", err.Error())
		}
	}
	if shared, err := r.Engine.LabeledNetworks(ctx, domain.LabelShared); err == nil {
		for _, n := range shared {
			if err := r.Engine.RemoveNetwork(ctx, n.Name); err != nil {
				r.warn("uninstall.network", err.Error())
			} else {
				removed["networks"]++
			}
		}
	}
	if srv, _ := r.Store.Server(); srv != nil && !srv.NoPortFilter {
		if _, err := r.runHelper(ctx, "filter", []string{"filter", "remove"}, nil, true); err != nil {
			r.warn("uninstall.filter", "the port filter could not be removed: "+err.Error())
		}
	}
	// the state, but the server lock this run holds, and without --volumes the backups'
	// passwords: the backups stay, and stay readable
	entries, _ := os.ReadDir(r.Store.Root())
	for _, e := range entries {
		if e.Name() == "server.lock" || (e.Name() == "backups" && !r.req.Volumes) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(r.Store.Root(), e.Name())); err != nil {
			return failed(errs.Internal("remove %s: %v", e.Name(), err))
		}
	}
	os.RemoveAll(domain.SecretsRoot)
	var summary []string
	for _, k := range []string{"containers", "networks", "volumes"} {
		summary = append(summary, fmt.Sprintf("%d %s", removed[k], k))
	}
	stacksOut := append([]string{}, stacks...)
	sort.Strings(stacksOut)
	r.ev.Info(events.Log, "Dockflow removed: "+strings.Join(summary, ", "), map[string]any{"line": "uninstall"})
	r.result(map[string]any{"environments": stacksOut, "containers": removed["containers"], "networks": removed["networks"], "volumes": removed["volumes"]})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}
