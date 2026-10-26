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

// Plan returns the actions that turn actual into desired.
func Plan(desired domain.App, actual domain.Actual) (*domain.Plan, error) {
	p := &domain.Plan{App: desired.Name, Env: desired.Env}
	add := func(kind, target, reason string, strategy domain.Strategy) {
		p.Actions = append(p.Actions, domain.Action{
			ID: fmt.Sprintf("%02d-%s-%s", len(p.Actions)+1, kind, target), Kind: kind,
			Target: target, Reason: reason, Strategy: strategy,
		})
	}

	for _, n := range desired.Networks {
		if actual.Networks[n.Name] {
			continue
		}
		if n.External {
			return nil, errs.Plan("plan.network_missing", "the external network %s does not exist", n.Name).
				WithHint("create it on the server, or remove `external: true`")
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
		add(domain.ActionCreateVolume, v.Name, "does not exist", "")
	}

	order, err := compose.Order(&desired)
	if err != nil {
		return nil, err
	}
	routesChanged := false
	for _, name := range order {
		s, _ := desired.Service(name)
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
		case running(cur) < s.Replicas:
			add(domain.ActionUpdateService, name, fmt.Sprintf("%d of %d containers running", running(cur), s.Replicas), s.Strategy)
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
		if _, ok := desired.Service(name); !ok {
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
	if routesChanged && (desired.HasRoutes() || hadRoutes(actual)) {
		add(domain.ActionRoutes, desired.Stack, "routes changed", "")
	}
	if actual.Env != nil && actual.Env.Degraded && len(p.Actions) == 0 {
		// a degraded environment is redeployed even when its services look unchanged
		add(domain.ActionRoutes, desired.Stack, "the environment is degraded", "")
	}
	p.Fingerprint = Fingerprint(desired, actual)
	return p, nil
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
		Actual   []svc
		Current  int
	}{d, desired.Networks, desired.Volumes, a, current})
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}
