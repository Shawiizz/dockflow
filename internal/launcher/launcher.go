// Package launcher starts the agent on a server and relays its events (ADR-0004).
package launcher

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/state"
)

// keepRuns is how many finished agent containers are kept for `dockflow attach`.
const keepRuns = 10

// Launcher runs agents on one server.
type Launcher struct {
	Engine  engine.Engine
	Info    engine.Info
	Version string
	Events  *events.Emitter
}

// Result is how a run ended, as the agent reported it.
type Result struct {
	events.RunFinishedData
	// Results are the data of the agent's result events.
	Results []json.RawMessage
	// Plan is the plan the agent computed, if any.
	Plan *domain.Plan
}

// Run starts an agent for req and relays its events until it finishes. interrupts delivers
// Ctrl+C: the first asks the agent to stop and roll back, the second detaches.
func (l *Launcher) Run(ctx context.Context, req agent.Request, interrupts <-chan struct{}) (*Result, error) {
	image, err := l.ensureImage(ctx)
	if err != nil {
		return nil, err
	}
	l.prune(ctx)
	labels := map[string]string{
		domain.LabelKind: domain.KindRun, domain.LabelSchema: "1", domain.LabelManagedBy: "true",
		domain.LabelOneOff: "True", "dockflow.op": req.Op,
	}
	if req.Stack != "" {
		labels[domain.LabelProject] = req.Stack
	}
	spec := domain.ContainerSpec{
		Image: image, StdinOpen: true, StdinOnce: true, Restart: "no",
		Mounts: []domain.Mount{
			{Type: "bind", Source: "/var/run/docker.sock", Target: "/var/run/docker.sock"},
			{Type: "bind", Source: state.Root, Target: state.Root, CreateHostPath: true},
			{Type: "volume", Source: agent.SwitchAdminVolume, Target: agent.SwitchAdminDir},
		},
		Logging: &domain.Logging{Driver: "json-file", Options: map[string]string{"max-size": "20m"}},
	}
	name := agent.RunContainerPrefix + req.Run
	id, err := l.Engine.Create(ctx, name, spec, labels)
	if err != nil {
		return nil, err
	}
	att, err := l.Engine.Attach(ctx, id)
	if err != nil {
		return nil, err
	}
	defer att.Close()
	go io.Copy(io.Discard, att.Stderr)
	if err := l.Engine.Start(ctx, id); err != nil {
		return nil, err
	}
	input, err := json.Marshal(req)
	if err != nil {
		return nil, errs.Internal("encode the agent's input: %v", err)
	}
	if _, err := att.Stdin.Write(append(input, '\n')); err != nil {
		return nil, errs.Connect("cannot send the run to the agent").WithCause(err)
	}
	att.Stdin.Close()

	done := make(chan *Result, 1)
	go func() { done <- l.relay(att.Stdout) }()
	asked := false
	for {
		select {
		case res := <-done:
			return l.finish(ctx, id, name, res)
		case <-interrupts:
			if asked {
				return nil, errs.New("run.detached", errs.ExitInterrupted, "detached: the agent finishes its rollback on the server").
					WithHint("follow it with `dockflow attach %s %s`", req.Env, req.Run)
			}
			asked = true
			l.Events.Warn(events.CancelRequested, "stopping: the agent rolls back (Ctrl+C again to detach)", map[string]any{"by": "signal"})
			if err := l.Engine.Kill(context.WithoutCancel(ctx), id, "SIGINT"); err != nil {
				l.Events.Warn(events.Warning, "cannot signal the agent: "+err.Error(), map[string]any{"code": "agent.signal_failed"})
			}
		}
	}
}

// Attach follows the events of a run, from its start.
func (l *Launcher) Attach(ctx context.Context, run string) (*Result, error) {
	name := "dockflow-run-" + run
	c, err := l.Engine.Inspect(ctx, name)
	if err != nil {
		return nil, errs.Newf("run.unknown", errs.ExitUsage, "no run %s on this server", run).
			WithHint("finished runs are kept: the %d most recent", keepRuns)
	}
	logs, err := l.Engine.Logs(ctx, c.ID, true)
	if err != nil {
		return nil, err
	}
	defer logs.Close()
	return l.finish(ctx, c.ID, name, l.relay(logs))
}

// LastRun returns the id of the most recent run of a stack, or "".
func (l *Launcher) LastRun(ctx context.Context, stack string) (string, error) {
	cs, err := l.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelKind: domain.KindRun, domain.LabelProject: stack}})
	if err != nil || len(cs) == 0 {
		return "", err
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].Name > cs[j].Name })
	return strings.TrimPrefix(cs[0].Name, "dockflow-run-"), nil
}

func (l *Launcher) relay(r io.Reader) *Result {
	res := &Result{}
	finished := false
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var ev events.Event
		if line[0] != '{' || json.Unmarshal(line, &ev) != nil || ev.Type == "" {
			l.Events.Debug(events.Log, string(line), map[string]any{"line": string(line)})
			continue
		}
		switch ev.Type {
		case events.RunFinished:
			finished = true
			if err := json.Unmarshal(ev.Data, &res.RunFinishedData); err != nil {
				res.RunFinishedData = events.RunFinishedData{Outcome: events.OutcomeFailed, ExitCode: errs.ExitInternal,
					Error: &events.ErrorData{Code: "agent.protocol", Message: "the agent's last event cannot be read: " + err.Error()}}
			}
		case events.Result:
			res.Results = append(res.Results, ev.Data)
		case events.PlanComputed:
			var p domain.Plan
			if json.Unmarshal(ev.Data, &p) == nil {
				res.Plan = &p
			}
		}
		l.Events.Forward(ev)
	}
	if !finished {
		res.ExitCode = -1
	}
	return res
}

func (l *Launcher) finish(ctx context.Context, id, name string, res *Result) (*Result, error) {
	if res.ExitCode != -1 {
		return res, nil
	}
	code, _ := l.Engine.Wait(context.WithoutCancel(ctx), id)
	return nil, errs.Newf("agent.died", errs.ExitInternal, "the agent %s stopped before finishing (exit code %d)", name, code).
		WithHint("the next run finds the unfinished release and restores the environment")
}

// prune removes finished agent containers beyond the most recent ones.
func (l *Launcher) prune(ctx context.Context) {
	cs, err := l.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelKind: domain.KindRun}})
	if err != nil {
		return
	}
	var finished []engine.Container
	for _, c := range cs {
		if c.State == "exited" || c.State == "dead" || c.State == "created" {
			finished = append(finished, c)
		}
	}
	sort.Slice(finished, func(i, j int) bool { return finished[i].Name > finished[j].Name })
	for i, c := range finished {
		if i >= keepRuns {
			_ = l.Engine.Remove(ctx, c.ID) // the next run tries again
		}
	}
}

// ensureImage imports the agent image when the server does not have it (ADR-0004).
func (l *Launcher) ensureImage(ctx context.Context) (string, error) {
	path, err := AgentBinary(l.Info.Arch)
	if err != nil {
		return "", err
	}
	bin, err := os.ReadFile(path)
	if err != nil {
		return "", errs.Internal("cannot read the agent binary %s: %v", path, err)
	}
	ref := "dockflow/agent:" + l.Version
	if l.Version == "dev" || l.Version == "" {
		sum := sha256.Sum256(bin)
		ref = "dockflow/agent:dev-" + hex.EncodeToString(sum[:])[:12]
	}
	ok, err := l.Engine.HasImage(ctx, ref)
	if err != nil || ok {
		return ref, err
	}
	l.Events.Info(events.Log, "installing the agent image "+ref, map[string]any{"line": "import " + ref})
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	tw.WriteHeader(&tar.Header{Name: "tmp/", Typeflag: tar.TypeDir, Mode: 0o1777})
	tw.WriteHeader(&tar.Header{Name: "dockflow", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(bin))})
	tw.Write(bin)
	tw.Close()
	changes := []string{
		`ENTRYPOINT ["/dockflow", "agent"]`,
		"LABEL dockflow.kind=agent",
		"ENV TMPDIR=/tmp",
	}
	if err := l.Engine.ImportImage(ctx, &buf, ref, changes); err != nil {
		return "", err
	}
	return ref, nil
}

// AgentBinary returns the path of the Linux binary to run as the agent on a server of the given
// architecture: DOCKFLOW_AGENT_BINARY, or this binary when it matches.
func AgentBinary(arch string) (string, error) {
	if p := os.Getenv("DOCKFLOW_AGENT_BINARY"); p != "" {
		return p, nil
	}
	if runtime.GOOS == "linux" && runtime.GOARCH == arch {
		return os.Executable()
	}
	return "", errs.Newf("agent.no_binary", errs.ExitConnect, "this dockflow binary is for %s/%s; the server runs linux/%s", runtime.GOOS, runtime.GOARCH, arch).
		WithHint("set DOCKFLOW_AGENT_BINARY to the path of the dockflow binary for linux/%s", arch)
}
