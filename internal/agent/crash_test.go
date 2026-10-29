//go:build linux

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// The fault-injection harness (vision goal 4, ADR-0008): a deploy is cut, or one of its changes
// fails, at every change it makes to Docker, to the switch and to the state files in turn. Then
// the watchdog and the next run recover, and the app must be consistent, and deploy again.

const testStack = "shop-production"

// Ways a change goes wrong.
const (
	// cut kills the agent before the change: nothing else it would do runs, deferred cleanups
	// included.
	cut = "cut"
	// refuse fails the change, which does not happen.
	refuse = "refuse"
	// lose makes the change, then fails it, as a call that times out after Docker did it.
	lose = "lose"
)

// proc is one agent process: it counts the changes it makes, and one of them goes wrong.
type proc struct {
	mu    sync.Mutex
	calls int
	at    int
	how   string
	dead  bool
	died  chan struct{}
	trail []string
	// streams are the stdins of the containers and commands it attached to, which Docker closes
	// when it dies; bg are what those run on their own.
	streams []io.Closer
	bg      sync.WaitGroup
}

func newProc(at int, how string) *proc { return &proc{at: at, how: how, died: make(chan struct{})} }

// change makes one change through do, unless it is the one that goes wrong.
func (p *proc) change(what string, do func() error) error {
	p.mu.Lock()
	if p.dead {
		p.mu.Unlock()
		select {} // a dead process does nothing more
	}
	p.calls++
	p.trail = append(p.trail, what)
	wrong := p.calls == p.at
	if wrong && p.how == cut {
		p.dead = true
		close(p.died)
		p.mu.Unlock()
		select {}
	}
	p.mu.Unlock()
	if !wrong {
		return do()
	}
	if p.how == lose {
		_ = do()
	}
	return errs.New("engine.api", errs.ExitInternal, "injected failure of "+what)
}

// look is a read: a dead process makes none.
func (p *proc) look() {
	p.mu.Lock()
	dead := p.dead
	p.mu.Unlock()
	if dead {
		select {}
	}
}

// world is the server: its containers, networks and volumes, and what its switch serves.
type world struct {
	mu         sync.Mutex
	next       int
	containers map[string]*engine.Container
	specs      map[string]domain.ContainerSpec
	networks   map[string]string
	volumes    map[string]bool
	served     proxy.Config
	// bk is what backups see of the server; nil in the tests of deploys.
	bk *backupWorld
}

func (w *world) find(ref string) *engine.Container {
	if c, ok := w.containers[ref]; ok {
		return c
	}
	for _, c := range w.containers {
		if c.Name == ref {
			return c
		}
	}
	return nil
}

func (w *world) add(name string, labels map[string]string, spec domain.ContainerSpec, st string) string {
	w.next++
	id := fmt.Sprintf("c%04d", w.next)
	c := &engine.Container{Labels: labels, Image: spec.Image}
	c.ID, c.Name, c.State = id, name, st
	c.Service, c.Hash, c.OneOff = labels[domain.LabelService], labels[domain.LabelHash], labels[domain.LabelOneOff] == "True"
	c.Release, _ = strconv.Atoi(labels[domain.LabelRelease])
	w.containers[id], w.specs[id] = c, spec
	return id
}

// agent sets the state of a run's container.
func (w *world) agent(run, st string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if c := w.find(RunContainerPrefix + run); c != nil {
		c.State = st
		return
	}
	w.add(RunContainerPrefix+run, map[string]string{domain.LabelKind: domain.KindRun}, domain.ContainerSpec{}, st)
}

// fakeEngine is a process's view of the server's Docker. A method it does not implement panics.
type fakeEngine struct {
	engine.Engine
	w *world
	p *proc
}

func (e *fakeEngine) name(ref string) string {
	e.w.mu.Lock()
	defer e.w.mu.Unlock()
	if c := e.w.find(ref); c != nil {
		return c.Name
	}
	return ref
}

func noSuch(ref string) error {
	return errs.New("engine.api", errs.ExitInternal, "No such container: "+ref)
}

func (e *fakeEngine) Info(context.Context) (engine.Info, error) {
	e.p.look()
	return engine.Info{}, nil
}

func (e *fakeEngine) Containers(_ context.Context, f engine.Filter) ([]engine.Container, error) {
	e.p.look()
	e.w.mu.Lock()
	defer e.w.mu.Unlock()
	var out []engine.Container
	for _, c := range e.w.containers {
		if !f.All && c.State != "running" {
			continue
		}
		match := true
		for k, v := range f.Labels {
			if got, ok := c.Labels[k]; !ok || (v != "" && got != v) {
				match = false
			}
		}
		if match {
			out = append(out, *c)
		}
	}
	slices.SortFunc(out, func(a, b engine.Container) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

func (e *fakeEngine) Inspect(_ context.Context, id string) (engine.Container, error) {
	e.p.look()
	e.w.mu.Lock()
	defer e.w.mu.Unlock()
	if c := e.w.find(id); c != nil {
		return *c, nil
	}
	return engine.Container{}, noSuch(id)
}

func (e *fakeEngine) Create(_ context.Context, name string, spec domain.ContainerSpec, labels map[string]string) (string, error) {
	var id string
	err := e.p.change("create "+name, func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		if e.w.find(name) != nil {
			return errs.New("engine.api", errs.ExitInternal, "Conflict. The container name "+name+" is already in use")
		}
		id = e.w.add(name, labels, spec, "created")
		e.createdLocked(id, spec)
		return nil
	})
	if err != nil {
		return "", err
	}
	return id, nil
}

func (e *fakeEngine) Start(_ context.Context, id string) error {
	return e.p.change("start "+e.name(id), func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		c := e.w.find(id)
		if c == nil {
			return noSuch(id)
		}
		if c.State == "running" {
			return nil
		}
		for _, port := range e.w.specs[c.ID].Ports {
			for oid, o := range e.w.containers {
				if o.State != "running" || port.HostPort == "" {
					continue
				}
				for _, op := range e.w.specs[oid].Ports {
					if op.HostPort == port.HostPort && op.Protocol == port.Protocol {
						return errs.New(engine.CodePortInUse, errs.ExitInternal, "Bind for 0.0.0.0:"+port.HostPort+" failed: port is already allocated")
					}
				}
			}
		}
		c.State = "running"
		e.startedLocked(c)
		return nil
	})
}

func (e *fakeEngine) Stop(_ context.Context, id string, _ *time.Duration) error {
	return e.p.change("stop "+e.name(id), func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		if c := e.w.find(id); c != nil {
			e.stoppedLocked(c)
			c.State = "exited"
		}
		return nil
	})
}

func (e *fakeEngine) Kill(ctx context.Context, id, _ string) error { return e.Stop(ctx, id, nil) }

func (e *fakeEngine) Remove(_ context.Context, id string) error {
	return e.p.change("remove "+e.name(id), func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		if c := e.w.find(id); c != nil {
			e.removedLocked(c)
			delete(e.w.containers, c.ID)
		}
		return nil
	})
}

func (e *fakeEngine) Rename(_ context.Context, id, name string) error {
	return e.p.change("rename "+e.name(id)+" to "+name, func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		c := e.w.find(id)
		if c == nil {
			return noSuch(id)
		}
		if o := e.w.find(name); o != nil {
			return errs.New("engine.api", errs.ExitInternal, "Conflict. The container name "+name+" is already in use by "+o.ID)
		}
		c.Name = name
		return nil
	})
}

func (e *fakeEngine) WaitHealthy(_ context.Context, id string, _, _ time.Duration) error {
	e.p.look()
	e.w.mu.Lock()
	defer e.w.mu.Unlock()
	if c := e.w.find(id); c != nil && c.State == "running" {
		return nil
	}
	return &engine.HealthError{Container: id, Kind: "exited", Reason: "not running"}
}

func (e *fakeEngine) Wait(_ context.Context, id string) (int, error) {
	e.p.look()
	if h := e.helperOf(id); h != nil {
		return h.wait(), nil
	}
	e.w.mu.Lock()
	defer e.w.mu.Unlock()
	if c := e.w.find(id); c != nil {
		c.State = "exited"
		return 0, nil
	}
	return 0, noSuch(id)
}

func (e *fakeEngine) Logs(context.Context, string, engine.LogOptions) (io.ReadCloser, error) {
	e.p.look()
	return io.NopCloser(strings.NewReader("")), nil
}

func (e *fakeEngine) Networks(context.Context) (map[string]string, error) {
	e.p.look()
	e.w.mu.Lock()
	defer e.w.mu.Unlock()
	out := map[string]string{}
	for k, v := range e.w.networks {
		out[k] = v
	}
	return out, nil
}

func (e *fakeEngine) CreateNetwork(_ context.Context, n domain.Network, project string) error {
	return e.p.change("create network "+n.Name, func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		e.w.networks[n.Name] = project
		return nil
	})
}

func (e *fakeEngine) Connect(_ context.Context, network, container string, _ []string) error {
	return e.p.change("connect "+container+" to "+network, func() error { return nil })
}

func (e *fakeEngine) Disconnect(_ context.Context, network, container string) error {
	return e.p.change("disconnect "+container+" from "+network, func() error { return nil })
}

func (e *fakeEngine) Volumes(context.Context) (map[string]bool, error) {
	e.p.look()
	e.w.mu.Lock()
	defer e.w.mu.Unlock()
	out := map[string]bool{}
	for k := range e.w.volumes {
		out[k] = true
	}
	return out, nil
}

func (e *fakeEngine) CreateVolume(_ context.Context, v domain.Volume, _ string) error {
	return e.p.change("create volume "+v.Name, func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		e.w.volumes[v.Name] = true
		return nil
	})
}

func (e *fakeEngine) Plugins(context.Context) ([]engine.Plugin, error) { e.p.look(); return nil, nil }

func (e *fakeEngine) HasImage(context.Context, string) (bool, error) { e.p.look(); return true, nil }

func (e *fakeEngine) ResolveImage(_ context.Context, ref, _ string, _ *engine.RegistryAuth) (string, error) {
	e.p.look()
	return ref, nil
}

func (e *fakeEngine) RemoveImage(_ context.Context, ref string) error {
	return e.p.change("remove image "+ref, func() error { return nil })
}

// fakeSwitch is a process's view of the switch's admin API.
type fakeSwitch struct {
	w *world
	p *proc
}

func (s *fakeSwitch) Apply(_ context.Context, c proxy.Config) error {
	return s.p.change("switch", func() error {
		s.w.mu.Lock()
		defer s.w.mu.Unlock()
		s.w.served = c
		return nil
	})
}

func (s *fakeSwitch) Adapt(context.Context, string) (json.RawMessage, error) { return nil, nil }

type discard struct{}

func (discard) Emit(events.Event) {}

type memSink struct {
	mu     sync.Mutex
	events []events.Event
}

func (s *memSink) Emit(e events.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, e)
}

// find returns the events of type typ whose data holds text.
func (s *memSink) find(typ, text string) []events.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []events.Event
	for _, e := range s.events {
		if e.Type == typ && strings.Contains(string(e.Data), text) {
			out = append(out, e)
		}
	}
	return out
}

// harness is one server, with its state directory.
type harness struct {
	t    *testing.T
	root string
	w    *world
	runs int
	// sink receives the events of the processes; none when nil.
	sink events.Sink
}

func newHarness(t *testing.T) *harness {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, root: root, w: &world{
		containers: map[string]*engine.Container{}, specs: map[string]domain.ContainerSpec{},
		networks: map[string]string{}, volumes: map[string]bool{},
	}}
	st, err := state.Open(root, "init")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WriteServer(state.Server{Name: "main", Edge: proxy.EdgeBuiltin, SwitchImage: "caddy@sha256:" + strings.Repeat("c", 64), NoPortFilter: true}); err != nil {
		t.Fatal(err)
	}
	h.w.add(SwitchContainer, map[string]string{domain.LabelKind: domain.KindSwitch}, domain.ContainerSpec{}, "running")
	return h
}

var clock = time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

// process starts an agent process, with its own state store and views of the server.
func (h *harness) process(at int, how string) (*proc, Deps, string) {
	h.runs++
	run := fmt.Sprintf("run%03d", h.runs)
	p := newProc(at, how)
	st, err := state.Open(h.root, run)
	if err != nil {
		h.t.Fatal(err)
	}
	st.Faults = func(path string, write func() error) error {
		return p.change("write "+strings.TrimPrefix(path, h.root+"/"), write)
	}
	var sink events.Sink = discard{}
	if h.sink != nil {
		sink = h.sink
	}
	return p, Deps{
		Engine: &fakeEngine{w: h.w, p: p}, Store: st, Switch: &fakeSwitch{w: h.w, p: p},
		Events: events.NewEmitter(run, sink, nil), Now: func() time.Time { return clock },
	}, run
}

// do runs one request in an agent container; the result is nil when the agent died.
func (h *harness) do(req Request, at int, how string) (*events.RunFinishedData, *proc) {
	p, d, run := h.process(at, how)
	req.Run, req.App, req.Env, req.Stack, req.Server, req.DockflowVersion = run, "shop", "production", testStack, "main", "test"
	h.w.agent(run, "running")
	done := make(chan events.RunFinishedData, 1)
	go func() { done <- Run(context.Background(), d, req) }()
	select {
	case res := <-done:
		h.w.agent(run, "exited")
		return &res, p
	case <-p.died:
		// the kernel ends the process: its container stops, its connections close, and its
		// locks are released
		h.w.agent(run, "exited")
		p.settle(h.t)
		releaseLocks(h.t, h.root)
		return nil, p
	}
}

func (h *harness) deploy(app domain.App, at int, how string) (*events.RunFinishedData, *proc) {
	return h.do(Request{Op: OpDeploy, Desired: &app, Keep: 10}, at, how)
}

// releaseLocks does what the kernel does for a process that died: it releases its locks.
func releaseLocks(t *testing.T, root string) {
	fds, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range fds {
		target, err := os.Readlink("/proc/self/fd/" + e.Name())
		if err != nil || !strings.HasPrefix(target, root+"/") {
			continue
		}
		if base := filepath.Base(target); base == "lock" || base == "server.lock" {
			fd, _ := strconv.Atoi(e.Name())
			_ = syscall.Flock(fd, syscall.LOCK_UN)
		}
	}
}

// recoverNow does what the next run does first, under the lock.
func (h *harness) recoverNow() error {
	_, d, run := h.process(0, "")
	r := &runner{Deps: d, req: Request{Op: OpDeploy, Run: run, Stack: testStack}, ev: d.Events, stack: testStack, start: clock}
	app, err := d.Store.App(testStack)
	if err != nil {
		return err
	}
	r.app = app
	l, err := r.lock(context.Background())
	if err != nil {
		return err
	}
	defer r.unlock(l)
	return r.recover(context.Background())
}

func (h *harness) watchdog() {
	_, d, _ := h.process(0, "")
	w := &Watchdog{Engine: d.Engine, Store: d.Store, Switch: d.Switch, Events: d.Events, Now: d.Now}
	w.Tick(context.Background())
}

// refApp is the reference app: a routed web service (switch), a database with a fixed name and
// a host port (stop-first), a worker (start-first), and a migration (a before job).
func refApp(v string) domain.App {
	network := testStack + "_default"
	on := func(alias string) []domain.Attachment {
		return []domain.Attachment{{Network: network, Aliases: []string{alias}}}
	}
	image := func(name string) string {
		return "registry.test/" + name + ":" + v + "@sha256:" + strings.Repeat(v, 64)[:64]
	}
	env := []string{"VERSION=" + v}
	return domain.App{
		Name: "shop", Env: "production", Stack: testStack,
		Networks: []domain.Network{{Key: "default", Name: network}},
		Volumes:  []domain.Volume{{Key: "pgdata", Name: testStack + "_pgdata"}},
		Services: []domain.Service{
			{
				Name: "db", Strategy: domain.StrategyStopFirst, Replicas: 1, Stateful: true, ContainerName: "shop-db",
				Spec: domain.ContainerSpec{
					Image: image("postgres"), Env: env, Networks: on("db"), Restart: "unless-stopped",
					Ports:  []domain.Port{{HostIP: "127.0.0.1", HostPort: "5432", ContainerPort: 5432, Protocol: "tcp"}},
					Mounts: []domain.Mount{{Type: "volume", Source: testStack + "_pgdata", Target: "/var/lib/postgresql/data"}},
				},
			},
			{
				Name: "migrate", Job: "before", Replicas: 1, Strategy: domain.StrategyStartFirst,
				DependsOn: []domain.Dependency{{Service: "db", Condition: "service_healthy"}},
				Spec:      domain.ContainerSpec{Image: image("web"), Command: []string{"migrate"}, Env: env, Networks: on("migrate"), Restart: "no"},
			},
			{
				Name: "web", Strategy: domain.StrategySwitch, Replicas: 2,
				DependsOn: []domain.Dependency{{Service: "migrate", Condition: "service_completed_successfully"}},
				Routes:    []domain.Route{{Domains: []string{"shop.test"}, Path: "/", Port: 3000, TLS: true}},
				Spec:      domain.ContainerSpec{Image: image("web"), Env: env, Networks: on("web"), Restart: "unless-stopped"},
			},
			{
				Name: "worker", Strategy: domain.StrategyStartFirst, Replicas: 1,
				Spec: domain.ContainerSpec{Image: image("web"), Command: []string{"work"}, Env: env, Networks: on("worker"), Restart: "unless-stopped"},
			},
		},
	}
}

// check asserts that the environment is consistent, and returns its current release. Loose
// checks only that the current release serves: what the next run tidies (statuses, leftover
// containers) is not looked at.
func (h *harness) check(label string, loose bool) *domain.Release {
	t := h.t
	t.Helper()
	fail := func(format string, args ...any) {
		t.Helper()
		t.Errorf("%s: %s", label, fmt.Sprintf(format, args...))
	}
	st, err := state.Open(h.root, "check")
	if err != nil {
		t.Fatal(err)
	}
	app, err := st.App(testStack)
	if err != nil {
		t.Fatal(err)
	}
	env, err := app.Env()
	if err != nil || env == nil || env.Current == 0 {
		fail("no current release (%v, %v)", env, err)
		return nil
	}
	cur, err := app.Release(env.Current)
	if err != nil || cur == nil {
		fail("release %d cannot be read: %v", env.Current, err)
		return nil
	}
	if !loose {
		if cur.Status != domain.StatusActive {
			fail("the current release %d is %s", cur.Seq, cur.Status)
		}
		seqs, _ := app.Releases()
		for _, seq := range seqs {
			rel, _ := app.Release(seq)
			if rel != nil && seq != env.Current && (rel.Status == domain.StatusActive || rel.Status == domain.StatusApplying) {
				fail("release %d is %s, while %d is current", seq, rel.Status, env.Current)
			}
		}
		if env.Previous > 0 {
			if prev, _ := app.Release(env.Previous); prev != nil && prev.Status != domain.StatusSuperseded {
				fail("the previous release %d is %s", prev.Seq, prev.Status)
			}
		}
	}

	h.w.mu.Lock()
	defer h.w.mu.Unlock()
	names := map[string][]string{}
	for _, c := range h.w.containers {
		if c.Labels[domain.LabelProject] != testStack {
			continue
		}
		s, ok := cur.Desired.Service(c.Service)
		serves := ok && s.Job == "" && c.Labels[domain.LabelKind] == domain.KindService && c.Release == cur.Serving[c.Service]
		if !serves {
			if !loose {
				fail("%s (%s, release %d, %s) is left over", c.Name, c.Labels[domain.LabelKind], c.Release, c.State)
			}
			continue
		}
		if c.State != "running" {
			fail("%s serves %s and is %s", c.Name, c.Service, c.State)
		}
		n, _ := strconv.Atoi(c.Labels[domain.LabelNumber])
		if want := containerName(testStack, s, c.Release, n); c.Name != want {
			fail("%s should be named %s", c.Name, want)
		}
		names[c.Service] = append(names[c.Service], c.Name)
	}
	for _, s := range cur.Desired.Services {
		if s.Job == "" && len(names[s.Name]) != s.Count() {
			fail("%s runs %d containers of release %d, not %d", s.Name, len(names[s.Name]), cur.Serving[s.Name], s.Count())
		}
	}
	routed := 0
	for _, rt := range h.w.served.Routes {
		if rt.Stack != testStack {
			continue
		}
		routed++
		got, want := slices.Sorted(slices.Values(rt.Upstreams)), slices.Sorted(slices.Values(names[rt.Service]))
		if !slices.Equal(got, want) {
			fail("the switch sends %s to %v, not to %v", rt.Service, got, want)
		}
	}
	if routed == 0 {
		fail("the switch serves no route of the app")
	}
	if !loose {
		table, _ := st.SwitchRoutes()
		if len(table[testStack]) != routed {
			fail("the recorded routes (%d) are not what the switch serves (%d)", len(table[testStack]), routed)
		}
		for _, rt := range table[testStack] {
			if got, want := slices.Sorted(slices.Values(rt.Upstreams)), slices.Sorted(slices.Values(names[rt.Service])); !slices.Equal(got, want) {
				fail("the recorded routes send %s to %v, not to %v", rt.Service, got, want)
			}
		}
	}
	return cur
}

// servedBy asserts that every service of the current release is served by release seq.
func servedBy(t *testing.T, label string, cur *domain.Release, seq int) {
	t.Helper()
	if cur == nil {
		return
	}
	for _, s := range cur.Desired.Services {
		if s.Job == "" && cur.Serving[s.Name] != seq {
			t.Errorf("%s: %s is served by release %d, not %d", label, s.Name, cur.Serving[s.Name], seq)
		}
	}
}

func TestDeployGoesWrongAtEveryChange(t *testing.T) {
	for _, how := range []string{cut, refuse, lose} {
		tried := 0
		for at := 1; at < 500; at++ {
			h := newHarness(t)
			if res, _ := h.deploy(refApp("1"), 0, ""); res == nil || res.Outcome != events.OutcomeSuccess {
				t.Fatalf("the first deploy failed: %+v", res)
			}
			h.check("after the first deploy", false)

			res, p := h.deploy(refApp("2"), at, how)
			if p.calls < at {
				break // the deploy made fewer changes: each one went wrong in turn
			}
			tried++
			label := fmt.Sprintf("%s at change %d (%s)", how, at, p.trail[at-1])
			outcome := "died"
			if res != nil {
				outcome = res.Outcome
			}
			label += ", " + outcome

			switch {
			case res == nil:
				// the watchdog finds the release of a dead agent, and recovers it at once
				h.watchdog()
				cur := h.check(label+", after the watchdog", false)
				if cur != nil {
					servedBy(t, label, cur, cur.Seq)
				}
			case res.Outcome == events.OutcomeSuccess:
				servedBy(t, label, h.check(label+", right after", true), 2)
			case res.ExitCode == errs.ExitDegraded:
				// the rollback failed too: the next run repairs
			default:
				// a failed deploy rolled back: release 1 serves again, before any other run
				if cur := h.check(label+", right after", true); cur != nil && cur.Seq != 1 {
					t.Errorf("%s: release %d is current after a failed deploy", label, cur.Seq)
				}
			}

			if err := h.recoverNow(); err != nil {
				t.Errorf("%s: the next run cannot recover: %v", label, err)
			}
			cur := h.check(label+", after the next run's recovery", false)
			if cur != nil && res != nil {
				want := 1
				if res.Outcome == events.OutcomeSuccess {
					want = 2
				}
				if cur.Seq != want {
					t.Errorf("%s: release %d is current, not %d", label, cur.Seq, want)
				}
			}

			res, _ = h.deploy(refApp("3"), 0, "")
			if res == nil || res.Outcome != events.OutcomeSuccess {
				t.Errorf("%s: the next deploy failed: %+v", label, res)
				continue
			}
			servedBy(t, label+", next deploy", h.check(label+", after the next deploy", false), res.ReleaseSeq)
		}
		if tried < 20 {
			t.Errorf("%s: only %d changes tried", how, tried)
		}
	}
}

// A release that cannot be recorded as live rolls back before the run reports its failure; a
// write that fails after its rename went through committed the release, which is live.
func TestCommitWriteThatFails(t *testing.T) {
	probe := newHarness(t)
	probe.deploy(refApp("1"), 0, "")
	_, p := probe.deploy(refApp("2"), 0, "")
	at := 0
	for i, what := range p.trail {
		if what == "write apps/"+testStack+"/env.json" {
			at = i + 1 // the last one is the commit
		}
	}

	h := newHarness(t)
	h.deploy(refApp("1"), 0, "")
	res, _ := h.deploy(refApp("2"), at, refuse)
	if res.Outcome != events.OutcomeRolledBack || res.ExitCode != errs.ExitRolledBack || res.Error == nil || res.Error.Code != "state.commit_failed" {
		t.Fatalf("a commit that cannot be written must roll back, with state.commit_failed: %+v %+v", res, res.Error)
	}
	if cur := h.check("refused commit", false); cur != nil && cur.Seq != 1 {
		t.Fatalf("release %d is current after a commit that failed", cur.Seq)
	}
	st, _ := state.Open(h.root, "check")
	app, _ := st.App(testStack)
	if rel, _ := app.Release(2); rel == nil || rel.Status != domain.StatusRolledBack || rel.Error == nil || rel.Error.Code != "state.commit_failed" {
		t.Fatalf("the release must end rolled_back with state.commit_failed: %+v", rel)
	}

	h = newHarness(t)
	h.deploy(refApp("1"), 0, "")
	res, _ = h.deploy(refApp("2"), at, lose)
	if res.Outcome != events.OutcomeSuccess {
		t.Fatalf("a commit whose rename went through is live: %+v %+v", res, res.Error)
	}
	servedBy(t, "lost commit", h.check("lost commit", false), 2)
}

// The watchdog recovers a run only once its agent container has stopped and the lock is free.
func TestWatchdogWaitsForTheRun(t *testing.T) {
	h := newHarness(t)
	h.deploy(refApp("1"), 0, "")
	_, p := h.deploy(refApp("2"), 0, "")
	at := slices.Index(p.trail, "switch") + 1

	h = newHarness(t)
	h.deploy(refApp("1"), 0, "")
	res, p := h.deploy(refApp("2"), at, cut)
	if res != nil {
		t.Fatalf("the deploy must have been cut: %+v", res)
	}
	run := fmt.Sprintf("run%03d", h.runs)
	before := func() int {
		h.w.mu.Lock()
		defer h.w.mu.Unlock()
		return len(h.w.containers)
	}
	n := before()

	h.w.agent(run, "running")
	h.watchdog()
	if before() != n {
		t.Fatal("the watchdog must leave a run whose agent container runs alone")
	}
	h.w.agent(run, "exited")
	st, _ := state.Open(h.root, "holder")
	app, _ := st.App(testStack)
	l, err := app.Lock(domain.LockInfo{Run: "holder", Op: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	h.watchdog()
	if before() != n {
		t.Fatal("the watchdog must not act while a run holds the lock")
	}
	l.Release()
	h.watchdog()
	if cur := h.check("cut at "+p.trail[at-1]+", after the watchdog", false); cur != nil && cur.Seq != 1 {
		t.Fatalf("release %d is current", cur.Seq)
	}
}

// on_failure: fail leaves a failed release in place, which the watchdog leaves alone; the plan
// says that the next run rolls it back, and the next run does.
func TestFailedReleaseLeftInPlace(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) }))
	defer srv.Close()
	h := newHarness(t)
	sink := &memSink{}
	h.sink = sink
	h.deploy(refApp("1"), 0, "")
	app := refApp("2")
	res, _ := h.do(Request{Op: OpDeploy, Desired: &app, Keep: 10, OnFailure: "fail", Endpoints: []domain.Endpoint{{
		Name: "home", URL: srv.URL, Method: http.MethodGet, ExpectedStatus: 200, Timeout: domain.Duration(time.Second), Retries: 1,
	}}}, 0, "")
	if res.ExitCode != errs.ExitDegraded {
		t.Fatalf("a failed check with on_failure: fail must leave the release in place: %+v", res)
	}
	inPlace := func() bool {
		h.w.mu.Lock()
		defer h.w.mu.Unlock()
		for _, rt := range h.w.served.Routes {
			if rt.Service == "web" && slices.Contains(rt.Upstreams, testStack+"-web-2-1") {
				return true
			}
		}
		return false
	}
	if !inPlace() {
		t.Fatal("the failed release must keep serving")
	}
	h.watchdog()
	if !inPlace() {
		t.Fatal("the watchdog must leave a failed release in place")
	}

	next := refApp("3")
	if res, _ := h.do(Request{Op: OpPlan, Desired: &next}, 0, ""); res.Outcome != events.OutcomeSuccess {
		t.Fatalf("plan: %+v %+v", res, res.Error)
	}
	if len(sink.find(events.Warning, `"run.unfinished"`)) == 0 || len(sink.find(events.PlanComputed, "first rolls it back to release 1")) == 0 {
		t.Fatal("the plan must say that the next run rolls the failed release back")
	}

	if err := h.recoverNow(); err != nil {
		t.Fatal(err)
	}
	if cur := h.check("after the next run", false); cur != nil && cur.Seq != 1 {
		t.Fatalf("release %d is current", cur.Seq)
	}
}
