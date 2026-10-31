package planner

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
)

// networkDrift tells how a network that exists differs from what the Compose file gives for it,
// "" when it does not. Only what the file sets is compared: Docker adds its own defaults, a
// subnet it chose or options of the driver, that the file does not contradict. What the current
// release's file set and this one no longer does, prev, is a removal the network still holds.
func networkDrift(want, got domain.Network, prev *domain.Network) string {
	var diffs []string
	differ := func(what string, want, got any) {
		diffs = append(diffs, fmt.Sprintf("%s is %v on the server, %v in compose.yml", what, got, want))
	}
	if d := or(want.Driver, "bridge"); d != got.Driver {
		differ("driver", d, got.Driver)
	}
	if want.Internal != got.Internal {
		differ("internal", want.Internal, got.Internal)
	}
	if want.EnableIPv6 != nil && got.EnableIPv6 != nil && *want.EnableIPv6 != *got.EnableIPv6 {
		differ("enable_ipv6", *want.EnableIPv6, *got.EnableIPv6)
	}
	diffs = append(diffs, missing("driver_opts", want.DriverOpts, got.DriverOpts)...)
	diffs = append(diffs, missing("labels", want.Labels, got.Labels)...)
	if prev != nil {
		diffs = append(diffs, removed("driver_opts", prev.DriverOpts, want.DriverOpts, got.DriverOpts)...)
		diffs = append(diffs, removed("labels", prev.Labels, want.Labels, got.Labels)...)
		if p, w := prev.IPAM, want.IPAM; p != nil && len(p.Pools) > 0 && (w == nil || len(w.Pools) == 0) && got.IPAM != nil {
			for _, pp := range p.Pools {
				if slices.ContainsFunc(got.IPAM.Pools, func(q domain.IPAMPool) bool { return holds(q, pp) }) {
					diffs = append(diffs, fmt.Sprintf("ipam.config was removed from compose.yml, the server still has %s", pool(pp)))
				}
			}
		}
	}
	if w := want.IPAM; w != nil {
		g := got.IPAM
		if g == nil {
			g = &domain.IPAM{}
		}
		if w.Driver != "" && w.Driver != or(g.Driver, "default") {
			differ("ipam.driver", w.Driver, or(g.Driver, "default"))
		}
		diffs = append(diffs, missing("ipam.options", w.Options, g.Options)...)
		for _, p := range w.Pools {
			if !slices.ContainsFunc(g.Pools, func(q domain.IPAMPool) bool { return holds(q, p) }) {
				differ("ipam.config", pool(p), poolList(g.Pools))
			}
		}
	}
	return strings.Join(diffs, "; ")
}

// volumeDrift tells how a volume that exists differs from what the Compose file gives for it, ""
// when it does not. Docker keeps a volume's options as they were given, so a removed option is
// seen without prev; a removed label is seen with it.
func volumeDrift(want, got domain.Volume, prev *domain.Volume) string {
	var diffs []string
	if d := or(want.Driver, "local"); d != or(got.Driver, "local") {
		diffs = append(diffs, fmt.Sprintf("driver is %s on the server, %s in compose.yml", or(got.Driver, "local"), d))
	}
	if !maps.Equal(want.DriverOpts, got.DriverOpts) && (len(want.DriverOpts) > 0 || len(got.DriverOpts) > 0) {
		diffs = append(diffs, fmt.Sprintf("driver_opts are %v on the server, %v in compose.yml", got.DriverOpts, want.DriverOpts))
	}
	diffs = append(diffs, missing("labels", want.Labels, got.Labels)...)
	if prev != nil {
		diffs = append(diffs, removed("labels", prev.Labels, want.Labels, got.Labels)...)
	}
	return strings.Join(diffs, "; ")
}

// removed lists the entries the previous file set, this one does not, and the server still holds.
func removed(what string, prev, want, got map[string]string) []string {
	var out []string
	for _, k := range slices.Sorted(maps.Keys(prev)) {
		if _, still := want[k]; still {
			continue
		}
		if _, held := got[k]; held {
			out = append(out, fmt.Sprintf("%s.%s was removed from compose.yml, the server still has it", what, k))
		}
	}
	return out
}

// released returns the element of the current release named name, nil when it had none.
func released[T any](list []T, name string, nameOf func(T) string) *T {
	for i := range list {
		if nameOf(list[i]) == name {
			return &list[i]
		}
	}
	return nil
}

// missing lists the entries of want that got lacks or holds with another value.
func missing(what string, want, got map[string]string) []string {
	var out []string
	for _, k := range slices.Sorted(maps.Keys(want)) {
		if g, ok := got[k]; !ok {
			out = append(out, fmt.Sprintf("%s.%s is not set on the server, %q in compose.yml", what, k, want[k]))
		} else if g != want[k] {
			out = append(out, fmt.Sprintf("%s.%s is %q on the server, %q in compose.yml", what, k, g, want[k]))
		}
	}
	return out
}

// holds tells whether the pool Docker reports is the one the file sets: Docker fills in what the
// file leaves out, a gateway or a range.
func holds(got, want domain.IPAMPool) bool {
	return (want.Subnet == "" || want.Subnet == got.Subnet) &&
		(want.IPRange == "" || want.IPRange == got.IPRange) &&
		(want.Gateway == "" || want.Gateway == got.Gateway)
}

func pool(p domain.IPAMPool) string {
	s := "subnet " + or(p.Subnet, "any")
	if p.IPRange != "" {
		s += ", ip_range " + p.IPRange
	}
	if p.Gateway != "" {
		s += ", gateway " + p.Gateway
	}
	return s
}

func poolList(ps []domain.IPAMPool) string {
	if len(ps) == 0 {
		return "none"
	}
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = pool(p)
	}
	return strings.Join(out, "; ")
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
