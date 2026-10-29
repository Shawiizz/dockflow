// Package filter writes the published-port filter (ADR-0014): iptables chains that drop new
// connections from outside to the ports Docker publishes, except those allowed. DOCKFLOW-FILTER,
// which DOCKER-USER jumps to, sees what Docker translates to a container; DOCKFLOW-INPUT, which
// INPUT jumps to, sees what docker-proxy receives on the host, as it does over IPv6 for a network
// without IPv6. It does no I/O: the rules are applied by `dockflow filter apply`, in a helper
// container, and by a systemd unit at boot.
package filter

import (
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Chain is the filter's chain for forwarded traffic; DOCKER-USER jumps to it.
const Chain = "DOCKFLOW-FILTER"

// InputChain is the filter's chain for traffic to the host's own sockets; INPUT jumps to it.
const InputChain = "DOCKFLOW-INPUT"

// MetadataAddress is the address of the cloud providers' metadata service, per family: every
// major provider serves it on 169.254.169.254, and AWS on fd00:ec2::254 too.
var MetadataAddress = map[int]string{4: "169.254.169.254", 6: "fd00:ec2::254"}

// Allow is one allowed port, with where it comes from.
type Allow struct {
	domain.PublicPort
	// Why says who opened it: an app environment, the switch, SSH.
	Why string `json:"why"`
}

// rule is one allowed port, protocol and source of a family, as iptables matches.
type rule struct {
	src, proto, why string
	port            int
}

// Rules returns the iptables-restore input of the filter for one family (4 or 6), for
// `iptables-restore --noflush`: only the filter's chains are declared, so only they are
// replaced. published are the host ports containers publish, whose connections docker-proxy
// may receive on the host itself: DOCKFLOW-INPUT drops those not allowed. With noMetadata,
// containers on Docker's bridges cannot reach the cloud provider's metadata service.
func Rules(allowed []Allow, published []domain.Port, family int, noMetadata bool) (string, error) {
	allows, err := expand(allowed, family)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("*filter\n:" + Chain + " - [0:0]\n:" + InputChain + " - [0:0]\n")
	add := func(chain, rule string) { b.WriteString("-A " + chain + " " + rule + "\n") }

	if noMetadata {
		// it serves the user-data, which holds the server's host key (server cloud-init); routed
		// off the host on most clouds, served by the host itself on some
		for _, chain := range []string{Chain, InputChain} {
			for _, br := range []string{"docker0", "br-+"} {
				add(chain, fmt.Sprintf("-i %s -d %s -j DROP", br, MetadataAddress[family]))
			}
		}
	}
	// forwarded: containers' own traffic, and the replies to connections already allowed
	add(Chain, "-i docker0 -j RETURN")
	add(Chain, "-i br-+ -j RETURN")
	add(Chain, "-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN")
	// a new connection routed from outside to a container's own address, not through a
	// published port: what a neighbour on the same network could send
	add(Chain, "-o docker0 -m conntrack --ctstate NEW -m conntrack ! --ctstate DNAT -j DROP")
	add(Chain, "-o br-+ -m conntrack --ctstate NEW -m conntrack ! --ctstate DNAT -j DROP")
	for _, a := range allows {
		// the original destination: Docker's DNAT has replaced the port by the container's
		add(Chain, fmt.Sprintf("%s-p %s -m conntrack --ctorigdstport %d -m comment --comment %q -j RETURN", a.src, a.proto, a.port, comment(a.why)))
	}
	// a new connection, from outside, to a port Docker publishes
	add(Chain, "-m conntrack --ctstate NEW -m conntrack --ctstate DNAT -j DROP")

	// to the host: only the ports containers publish, the host's own services are left alone
	drops := hostPorts(published, family)
	if len(drops) > 0 {
		add(InputChain, "-i lo -j RETURN")
		add(InputChain, "-i docker0 -j RETURN")
		add(InputChain, "-i br-+ -j RETURN")
		for _, a := range allows {
			add(InputChain, fmt.Sprintf("%s-p %s --dport %d -m comment --comment %q -j RETURN", a.src, a.proto, a.port, comment(a.why)))
		}
		for _, d := range drops {
			add(InputChain, fmt.Sprintf("-p %s --dport %s -m conntrack --ctstate NEW -j DROP", d.proto, d.ports))
		}
	}
	b.WriteString("COMMIT\n")
	return b.String(), nil
}

// expand checks the allowed ports and returns their rules for family, sorted by port.
func expand(allowed []Allow, family int) ([]rule, error) {
	sorted := append([]Allow(nil), allowed...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Port < sorted[j].Port })
	var out []rule
	for _, a := range sorted {
		if a.Port < 1 || a.Port > 65535 {
			return nil, errs.Config("%s: port %d is not a port", a.Why, a.Port)
		}
		protocols := []string{"tcp", "udp"}
		switch a.Protocol {
		case "":
		case "tcp", "udp":
			protocols = []string{a.Protocol}
		default:
			return nil, errs.Config("%s: protocol %q is not tcp or udp", a.Why, a.Protocol)
		}
		sources := []string{""}
		if len(a.From) > 0 {
			sources = nil
			for _, f := range a.From {
				p, err := prefix(f)
				if err != nil {
					return nil, errs.Config("%s: from %q is not an address or a CIDR", a.Why, f)
				}
				if (p.Addr().Is4() && family == 4) || (p.Addr().Is6() && family == 6) {
					sources = append(sources, "-s "+p.String()+" ")
				}
			}
			// no source of this family: nothing to allow here
		}
		for _, proto := range protocols {
			for _, src := range sources {
				out = append(out, rule{src: src, proto: proto, port: a.Port, why: a.Why})
			}
		}
	}
	return out, nil
}

type hostPort struct{ proto, ports string }

// hostPorts are the published host ports bound on an address of family that is not loopback,
// as iptables --dport takes them, without duplicates. A port without a fixed host port is left
// out: IPv4Only binds it to IPv4, where DOCKFLOW-FILTER sees it.
func hostPorts(published []domain.Port, family int) []hostPort {
	seen := map[hostPort]bool{}
	var out []hostPort
	for _, p := range published {
		if p.HostPort == "" || !onFamily(p.HostIP, family) {
			continue
		}
		lo, hi, ok := strings.Cut(p.HostPort, "-")
		from, err1 := strconv.Atoi(lo)
		to := from
		var err2 error
		if ok {
			to, err2 = strconv.Atoi(hi)
		}
		if err1 != nil || err2 != nil || from < 1 || to > 65535 || to < from {
			continue
		}
		ports := strconv.Itoa(from)
		if to != from {
			ports += ":" + strconv.Itoa(to)
		}
		protocols := []string{p.Protocol}
		if p.Protocol == "" {
			protocols = []string{"tcp"}
		}
		for _, proto := range protocols {
			h := hostPort{proto, ports}
			if !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ports != out[j].ports {
			return out[i].ports < out[j].ports
		}
		return out[i].proto < out[j].proto
	})
	return out
}

// onFamily tells whether a port published on hostIP is bound on a non-loopback address of
// family. Docker binds a port without a host IP on 0.0.0.0 and on [::].
func onFamily(hostIP string, family int) bool {
	if hostIP == "" {
		return true
	}
	a, err := netip.ParseAddr(hostIP)
	if err != nil || a.IsLoopback() {
		return false
	}
	return (family == 4 && a.Unmap().Is4()) || (family == 6 && a.Is6() && !a.Is4In6())
}

// IPv4Only binds the ports published without a host IP and without a host port to 0.0.0.0.
// Docker would pick a random port on [::] too, which the filter cannot know in advance, and
// docker-proxy would receive it on the host, where DOCKFLOW-FILTER does not see it. Such a port
// is never listed under firewall.public_ports, so the filter drops it from outside over IPv4
// anyway: nothing reachable is lost.
func IPv4Only(ports []domain.Port) []domain.Port {
	var out []domain.Port
	for i, p := range ports {
		if p.HostIP == "" && p.HostPort == "" {
			if out == nil {
				out = append([]domain.Port(nil), ports...)
			}
			out[i].HostIP = "0.0.0.0"
		}
	}
	if out == nil {
		return ports
	}
	return out
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
