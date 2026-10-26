// Package filter writes the published-port filter (ADR-0014): an iptables chain, DOCKFLOW-FILTER,
// that DOCKER-USER jumps to, and that drops new connections from outside to the ports Docker
// publishes, except those allowed. It does no I/O: the rules are applied by `dockflow filter
// apply`, in a helper container, and by a systemd unit at boot.
package filter

import (
	"fmt"
	"net/netip"
	"sort"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Chain is the filter's own chain; DOCKER-USER jumps to it.
const Chain = "DOCKFLOW-FILTER"

// Allow is one allowed port, with where it comes from.
type Allow struct {
	domain.PublicPort
	// Why says who opened it: an app environment, the switch, SSH.
	Why string `json:"why"`
}

// Rules returns the iptables-restore input of the filter for one family (4 or 6), for
// `iptables-restore --noflush`: only DOCKFLOW-FILTER is declared, so only it is replaced.
func Rules(allowed []Allow, family int) (string, error) {
	var b strings.Builder
	b.WriteString("*filter\n:" + Chain + " - [0:0]\n")
	add := func(rule string) { b.WriteString("-A " + Chain + " " + rule + "\n") }
	// containers' own traffic, and the replies to connections already allowed
	add("-i docker0 -j RETURN")
	add("-i br-+ -j RETURN")
	add("-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN")
	sorted := append([]Allow(nil), allowed...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Port < sorted[j].Port })
	for _, a := range sorted {
		if a.Port < 1 || a.Port > 65535 {
			return "", errs.Config("%s: port %d is not a port", a.Why, a.Port)
		}
		protocols := []string{"tcp", "udp"}
		switch a.Protocol {
		case "":
		case "tcp", "udp":
			protocols = []string{a.Protocol}
		default:
			return "", errs.Config("%s: protocol %q is not tcp or udp", a.Why, a.Protocol)
		}
		sources := []string{""}
		if len(a.From) > 0 {
			sources = nil
			for _, f := range a.From {
				p, err := prefix(f)
				if err != nil {
					return "", errs.Config("%s: from %q is not an address or a CIDR", a.Why, f)
				}
				if (p.Addr().Is4() && family == 4) || (p.Addr().Is6() && family == 6) {
					sources = append(sources, "-s "+p.String()+" ")
				}
			}
			if len(sources) == 0 {
				// no source of this family: nothing to allow here
				continue
			}
		}
		for _, proto := range protocols {
			for _, src := range sources {
				// the original destination: Docker's DNAT has replaced the port by the container's
				add(fmt.Sprintf("%s-p %s -m conntrack --ctorigdstport %d -m comment --comment %q -j RETURN", src, proto, a.Port, comment(a.Why)))
			}
		}
	}
	// a new connection, from outside, to a port Docker publishes
	add("-m conntrack --ctstate NEW -m conntrack --ctstate DNAT -j DROP")
	b.WriteString("COMMIT\n")
	return b.String(), nil
}

func prefix(s string) (netip.Prefix, error) {
	if strings.Contains(s, "/") {
		p, err := netip.ParsePrefix(s)
		return p.Masked(), err
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, err
	}
	return netip.PrefixFrom(a, a.BitLen()), nil
}

// comment keeps an iptables comment printable and short.
func comment(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' {
			return '-'
		}
		return r
	}, s)
	if len(s) > 200 {
		s = s[:200]
	}
	return "dockflow: " + s
}
