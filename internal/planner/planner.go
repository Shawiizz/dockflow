// Package planner computes plan = f(desired, actual) (ADR-0008). It is pure: no I/O, no clock,
// no randomness.
package planner

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/Shawiizz/dockflow/internal/compose"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Plan returns the actions that turn actual into desired. The services named in restart are
// replaced even when unchanged.
func Plan(desired domain.App, actual domain.Actual, restart ...string) (*domain.Plan, error) {
	force := map[string]bool{}
	for _, name := range restart {
		force[name] = true
	}
	p := &domain.Plan{App: desired.Name, Env: desired.Env}
	add := func(kind, target, reason string, strategy domain.Strategy) {
		p.Actions = append(p.Actions, domain.Action{
			ID: fmt.Sprintf("%02d-%s-%s", len(p.Actions)+1, kind, target), Kind: kind,
			Target: target, Reason: reason, Strategy: strategy,
		})
	}

	stack := desired.Stack
	for _, n := range desired.Networks {
		if project, ok := actual.Networks[n.Name]; ok {
			if !n.External && project != stack {
				// a Swarm stack's or another project's: its containers' settings are not ours
				return nil, errs.Plan("plan.network_foreign", "the network %s exists on the server and does not belong to %s", n.Name, stack).
					WithHint("remove it once nothing uses it (a Swarm stack: docker stack rm), or give the network another name in compose.yml")
			}
			continue
		}
		if n.External {
			return nil, errs.Plan("plan.network_missing", "the external network %s does not exist", n.Name).
				WithHint("create it with `dockflow server network create %s`, or remove `external: true`", n.Name)
		}
		add(domain.ActionCreateNetwork, n.Name, "does not exist", "")
	}
	for _, v := range desired.Volumes {
		if actual.Volumes[v.Name] {
			continue
		}
		if v.External {
			return nil, errs.Plan("plan.volume_missing", "the external volume %s does not exist", v.Name).
				WithHint("create it on the server, or remove `external: true`")
		}
		if d := v.Driver; d != "" && d != "local" && actual.VolumeDrivers != nil && !actual.VolumeDrivers[d] {
			return nil, errs.Plan("plan.volume_driver", "the volume %s needs the volume plugin %s, which the server does not have", v.Name, d).
				WithHint("install it with `dockflow server plugin install <plugin> --alias %s`", d)
		}
		add(domain.ActionCreateVolume, v.Name, "does not exist", "")
	}

	// the port filter follows the release, once it is committed (ADR-0014)
	if !reflect.DeepEqual(normalPorts(desired.PublicPorts), normalPorts(actual.PublicPorts)) {
		add(domain.ActionPorts, "firewall.public_ports", "public ports changed", "")
	}

	// content-addressed: a file that exists has the right content
	for _, f := range desired.Files {
		if actual.Files[f.Path] {
			continue
		}
		kind := domain.ActionCreateConfig
		if f.Secret {
			kind = domain.ActionCreateSecret
		}
		add(kind, f.Path, f.Name+": new content", "")
	}

	for _, u := range desired.Uploads {
		if actual.Uploads[u.Dest] == u.Manifest {
			continue
		}
		reason := "files changed"
		if actual.Uploads[u.Dest] == "" {
			reason = "new upload"
		}
		if u.Plugin != "" {
			reason += ", plugin " + u.Plugin
		}
		add(domain.ActionUpload, u.Dest, reason, "")
	}

	order, err := compose.Order(&desired)
	if err != nil {
		return nil, err
	}
	infra := len(p.Actions)
	routesChanged := false
	for _, name := range order {
		s, _ := desired.Service(name)
		if s.Job != "" {
			continue
		}
		cur, exists := actual.Services[name]
		switch {
		case !exists:
			add(domain.ActionCreateService, name, "new service", s.Strategy)
			p.Summary.Create++
			if len(s.Routes) > 0 {
				routesChanged = true
			}
		case cur.Hash != s.Hash():
			add(domain.ActionUpdateService, name, changeReason(cur.Desired, s), s.Strategy)
			p.Summary.Update++
			if cur.Desired == nil || !reflect.DeepEqual(cur.Desired.Routes, s.Routes) {
				routesChanged = true
			}
		case force[name]:
			add(domain.ActionUpdateService, name, "restart", s.Strategy)
			p.Summary.Update++
		case running(cur) < s.Count():
			add(domain.ActionUpdateService, name, fmt.Sprintf("%d of %d containers running", running(cur), s.Count()), s.Strategy)
			p.Summary.Update++
		default:
			p.Unchanged = append(p.Unchanged, name)
			if cur.Desired == nil || !reflect.DeepEqual(cur.Desired.Routes, s.Routes) {
				routesChanged = true
			}
		}
	}

	var removed []string
	for name := range actual.Services {
		if s, ok := desired.Service(name); !ok || s.Job != "" {
			removed = append(removed, name)
		}
	}
	sort.Strings(removed)
	for _, name := range removed {
		add(domain.ActionRemoveService, name, "no longer in the Compose files", "")
		p.Summary.Remove++
		if cur := actual.Services[name]; cur.Desired == nil || len(cur.Desired.Routes) > 0 {
			routesChanged = true
		}
	}
	if (len(desired.Routes) > 0 || len(actual.Routes) > 0) && !reflect.DeepEqual(desired.Routes, actual.Routes) {
		routesChanged = true
	}
	if routesChanged && (desired.HasRoutes() || hadRoutes(actual)) {
		add(domain.ActionRoutes, desired.Stack, "routes changed", "")
	}
	if actual.Env != nil && actual.Env.Degraded && len(p.Actions) == 0 {
		// a degraded environment is redeployed even when its services look unchanged
		add(domain.ActionRoutes, desired.Stack, "the environment is degraded", "")
	}
	addJobs(p, &desired, order, infra)
	p.Fingerprint = Fingerprint(desired, actual)
	return p, nil
}

// addJobs inserts the jobs of a plan that changes something, in depends_on order (ADR-0010):
// a before job right after the actions of the services it depends on, so a migration runs once
// its database is up, and before the services that depend on it; after jobs at the end.
func addJobs(p *domain.Plan, desired *domain.App, order []string, infra int) {
	if len(p.Actions) == infra {
		return
	}
	rest := p.Actions[infra:]
	acted := map[string]int{} // service → index of its action in rest
	for i, a := range rest {
		if a.Kind == domain.ActionCreateService || a.Kind == domain.ActionUpdateService {
			acted[a.Target] = i
		}
	}
	// at is where a before job goes in rest: after every action it depends on
	at := map[string]int{}
	var after func(name string) int
	after = func(name string) int {
		if i, ok := at[name]; ok {
			return i
		}
		s, _ := desired.Service(name)
		pos := 0
		if i, ok := acted[name]; ok && s.Job == "" {
			pos = i + 1
		}
		for _, d := range s.DependsOn {
			if dp := after(d.Service); dp > pos {
				pos = dp
			}
		}
		at[name] = pos
		return pos
	}
	before := map[int][]domain.Action{}
	var afterJobs []domain.Action
	for _, name := range order {
		s, _ := desired.Service(name)
		a := domain.Action{Kind: domain.ActionJob, Target: name, Reason: "job, " + s.Job + " the services"}
		switch s.Job {
		case domain.JobBefore:
			pos := after(name)
			before[pos] = append(before[pos], a)
		case domain.JobAfter:
			afterJobs = append(afterJobs, a)
		}
	}
	if len(before)+len(afterJobs) == 0 {
		return
	}
	actions := append([]domain.Action{}, p.Actions[:infra]...)
	for i := 0; i <= len(rest); i++ {
		actions = append(actions, before[i]...)
		if i < len(rest) {
			actions = append(actions, rest[i])
		}
	}
	actions = append(actions, afterJobs...)
	for i := range actions {
		actions[i].ID = fmt.Sprintf("%02d-%s-%s", i+1, actions[i].Kind, actions[i].Target)
	}
	p.Actions = actions
}

func running(s domain.ActualService) int {
	n := 0
	for _, c := range s.Containers {
		if c.State == "running" && c.Health != "unhealthy" {
			n++
		}
	}
	return n
}

func hadRoutes(a domain.Actual) bool {
	if len(a.Routes) > 0 {
		return true
	}
	for _, s := range a.Services {
		if s.Desired != nil && len(s.Desired.Routes) > 0 {
			return true
		}
	}
	return false
}

// changeReason names the fields that differ between the recorded and the desired service.
func changeReason(old, new *domain.Service) string {
	if old == nil {
		return "configuration changed"
	}
	var fields []string
	if old.Replicas != new.Replicas {
		fields = append(fields, fmt.Sprintf("replicas %d → %d", old.Replicas, new.Replicas))
	}
	if old.Stopped != new.Stopped {
		fields = append(fields, map[bool]string{true: "stopped", false: "started again"}[new.Stopped])
	}
	if old.Spec.Image != new.Spec.Image {
		fields = append(fields, "image "+shortImage(old.Spec.Image)+" → "+shortImage(new.Spec.Image))
	}
	if old.ContainerName != new.ContainerName {
		fields = append(fields, "container_name")
	}
	a, b := specFields(old.Spec), specFields(new.Spec)
	var keys []string
	for k := range b {
		keys = append(keys, k)
	}
	for k := range a {
		if _, ok := b[k]; !ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		if k == "image" {
			continue
		}
		if string(a[k]) != string(b[k]) {
			fields = append(fields, k)
		}
	}
	if len(fields) == 0 {
		return "configuration changed"
	}
	return strings.Join(dedupe(fields), ", ")
}

func specFields(s domain.ContainerSpec) map[string]json.RawMessage {
	b, _ := json.Marshal(s)
	var m map[string]json.RawMessage
	_ = json.Unmarshal(b, &m)
	return m
}

func shortImage(ref string) string {
	if i := strings.Index(ref, "@sha256:"); i >= 0 && len(ref) > i+20 {
		return ref[:i+20]
	}
	return ref
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

// normalPorts makes a list of public ports comparable: nil and empty alike.
func normalPorts(p []domain.PublicPort) []domain.PublicPort {
	if len(p) == 0 {
		return nil
	}
	return p
}

// Fingerprint identifies the inputs a plan was computed from: a saved plan applies only to the
// same desired state and the same actual state (ADR-0008).
func Fingerprint(desired domain.App, actual domain.Actual) string {
	type svc struct {
		Name    string
		Hash    string
		Routes  []domain.Route
		Release int
		IDs     []string
	}
	var d, a []svc
	for _, s := range desired.Services {
		d = append(d, svc{Name: s.Name, Hash: s.Hash(), Routes: s.Routes})
	}
	names := make([]string, 0, len(actual.Services))
	for n := range actual.Services {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		s := actual.Services[n]
		var ids []string
		for _, c := range s.Containers {
			ids = append(ids, c.ID)
		}
		sort.Strings(ids)
		a = append(a, svc{Name: n, Hash: s.Hash, Release: s.Release, IDs: ids})
	}
	current := 0
	if actual.Env != nil {
		current = actual.Env.Current
	}
	b, _ := json.Marshal(struct {
		Desired  []svc
		Networks []domain.Network
		Volumes  []domain.Volume
		Uploads  []domain.Upload
		Actual   []svc
		Current  int
		Applied  map[string]string
	}{d, desired.Networks, desired.Volumes, desired.Uploads, a, current, actual.Uploads})
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}
