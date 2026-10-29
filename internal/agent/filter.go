package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/filter"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// FilterEnv carries a FilterRequest to `dockflow filter apply`.
const FilterEnv = "DOCKFLOW_FILTER"

// FilterRequest is what the filter helper applies: the rules of each family.
type FilterRequest struct {
	Rules4 string `json:"rules4"`
	Rules6 string `json:"rules6"`
}

// allowed lists what the filter lets in: SSH, the switch's public ports, and the public ports of
// the current release of every app environment on the server. published lists the host ports the
// switch and those releases publish.
func (r *runner) allowed(srv *state.Server) (allowed []filter.Allow, published []domain.Port, err error) {
	ssh := srv.SSHPort
	if ssh == 0 {
		ssh = 22
	}
	out := []filter.Allow{{PublicPort: domain.PublicPort{Port: ssh, Protocol: "tcp"}, Why: "SSH"}}
	switch srv.Edge {
	case proxy.EdgeExternal:
		if host, port, err := splitListen(srv.SwitchListen); err == nil && !strings.HasPrefix(host, "127.") && host != "::1" {
			p, _ := strconv.Atoi(port)
			out = append(out, filter.Allow{PublicPort: domain.PublicPort{Port: p, Protocol: "tcp"}, Why: "the switch"})
		}
	case proxy.EdgeNone:
	case proxy.EdgeCloudflare:
		// Cloudflare's proxies only: anything else reaching the origin bypasses Cloudflare
		out = append(out,
			filter.Allow{PublicPort: domain.PublicPort{Port: 80, Protocol: "tcp", From: srv.CloudflareRanges}, Why: "the switch, from Cloudflare"},
			filter.Allow{PublicPort: domain.PublicPort{Port: 443, From: srv.CloudflareRanges}, Why: "the switch, from Cloudflare"})
	default:
		out = append(out,
			filter.Allow{PublicPort: domain.PublicPort{Port: 80, Protocol: "tcp"}, Why: "the switch"},
			filter.Allow{PublicPort: domain.PublicPort{Port: 443}, Why: "the switch"})
	}
	if srv.Edge != proxy.EdgeNone {
		published = append(published, switchSpec("", srv.Edge, srv.SwitchListen).Ports...)
	}
	stacks, err := r.Store.Stacks()
	if err != nil {
		return nil, nil, err
	}
	for _, stack := range stacks {
		app, err := r.Store.App(stack)
		if err != nil {
			return nil, nil, err
		}
		env, err := app.Env()
		if err != nil || env == nil || env.Current == 0 {
			continue
		}
		rel, err := app.Release(env.Current)
		if err != nil || rel == nil {
			continue
		}
		for _, p := range rel.Desired.PublicPorts {
			out = append(out, filter.Allow{PublicPort: p, Why: stack})
		}
		for _, s := range rel.Desired.Services {
			published = append(published, s.Spec.Ports...)
		}
	}
	return out, published, nil
}

// syncFilter applies the filter when what it lets in changed (ADR-0014): a helper container on
// the host's network writes /etc/dockflow/filter*.rules and loads them with the host's iptables.
func (r *runner) syncFilter(ctx context.Context) error {
	srv, err := r.Store.Server()
	if err != nil || srv == nil || srv.NoPortFilter {
		return err
	}
	allowed, published, err := r.allowed(srv)
	if err != nil {
		return err
	}
	var fr FilterRequest
	if fr.Rules4, err = filter.Rules(allowed, published, 4); err != nil {
		return err
	}
	if fr.Rules6, err = filter.Rules(allowed, published, 6); err != nil {
		return err
	}
	sum := sha256.Sum256([]byte(fr.Rules4 + fr.Rules6))
	digest := hex.EncodeToString(sum[:])
	if digest == srv.FilterRules {
		return nil
	}
	if err := r.runFilter(ctx, fr); err != nil {
		return err
	}
	ports := make([]string, 0, len(allowed))
	for _, a := range allowed {
		ports = append(ports, strconv.Itoa(a.Port))
	}
	r.ev.Info(events.FilterApplied, "port filter: "+strings.Join(ports, ", ")+" let in", map[string]any{"ports": allowed})
	srv.FilterRules = digest
	return r.Store.WriteServer(*srv)
}

// filtered is the spec a service's container is created with: with the port filter, a port
// published on a random host port is bound to IPv4 only (filter.IPv4Only).
func (r *runner) filtered(spec domain.ContainerSpec) domain.ContainerSpec {
	if srv, err := r.Store.Server(); err == nil && srv != nil && !srv.NoPortFilter {
		spec.Ports = filter.IPv4Only(spec.Ports)
	}
	return spec
}

// clearFilter empties the filter's chains: nothing is dropped any more.
func (r *runner) clearFilter(ctx context.Context) error {
	empty := "*filter\n:" + filter.Chain + " - [0:0]\n:" + filter.InputChain + " - [0:0]\nCOMMIT\n"
	return r.runFilter(ctx, FilterRequest{Rules4: empty, Rules6: empty})
}

// runFilter runs `dockflow filter apply` in a helper container on the host's network.
func (r *runner) runFilter(ctx context.Context, fr FilterRequest) error {
	b, _ := json.Marshal(fr)
	if _, err := r.runHelper(ctx, "filter", []string{"filter", "apply"}, []string{FilterEnv + "=" + string(b)}, true); err != nil {
		return errs.Newf("filter.failed", errs.ExitInternal, "the port filter could not be applied: %s", err.Error()).
			WithHint("check that iptables works on the server, or run server init --no-port-filter")
	}
	return nil
}

// runHelper runs the Dockflow binary with args in a short helper container on the host's
// network; with hostRoot, as root of the host, whose root it mounts at /host (ADR-0014). It
// returns the helper's output, or an error with its last line.
func (r *runner) runHelper(ctx context.Context, name string, args, env []string, hostRoot bool) (string, error) {
	spec := domain.ContainerSpec{
		Image: r.req.AgentImage, Entrypoint: append([]string{"/dockflow"}, args...),
		Env: env, Restart: "no", NetworkMode: "host",
	}
	if hostRoot {
		spec.CapAdd = []string{"NET_ADMIN", "NET_RAW", "SYS_CHROOT"}
		// the host's own tools, run in a chroot: the agent's image holds the binary only
		spec.Mounts = []domain.Mount{{Type: "bind", Source: "/", Target: "/host"}}
	}
	labels := map[string]string{
		domain.LabelKind: domain.KindHelper, domain.LabelSchema: "1", domain.LabelManagedBy: "true", domain.LabelOneOff: "True",
	}
	id, err := r.Engine.Create(ctx, "dockflow-"+name+"-"+r.req.Run, spec, labels)
	if err != nil {
		return "", err
	}
	defer func() { _ = r.Engine.Remove(context.WithoutCancel(ctx), id) }()
	if err := r.Engine.Start(ctx, id); err != nil {
		return "", err
	}
	code, err := r.Engine.Wait(ctx, id)
	if err != nil {
		return "", err
	}
	var out []byte
	if logs, _ := r.Engine.Logs(context.WithoutCancel(ctx), id, engine.LogOptions{Stderr: true}); logs != nil {
		out, _ = io.ReadAll(logs)
		logs.Close()
	}
	if code != 0 {
		return string(out), errs.Internal("%s", lastLine(string(out)))
	}
	return string(out), nil
}
