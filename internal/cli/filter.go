package cli

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/filter"
)

// FilterDir is where the filter's rules are kept on the server, for the boot unit.
const FilterDir = "/etc/dockflow"

// filterCmd is `dockflow filter apply`, run by the agent in a helper container on the host's
// network with the host's root at /host (ADR-0014). Hidden: it is no command for people.
func (a *app) filterCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "filter", Hidden: true}
	cmd.AddCommand(&cobra.Command{
		Use:  "apply",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var fr agent.FilterRequest
			if err := json.Unmarshal([]byte(os.Getenv(agent.FilterEnv)), &fr); err != nil {
				return errs.Internal("the filter's request is not valid: %v", err)
			}
			if err := chrootHost("/host"); err != nil {
				return errs.Internal("enter the host's root: %v", err)
			}
			if err := os.Setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"); err != nil {
				return errs.Internal("set PATH: %v", err)
			}
			if err := os.MkdirAll(FilterDir, 0o700); err != nil {
				return errs.Internal("create %s: %v", FilterDir, err)
			}
			if err := applyFamily("iptables", filepath.Join(FilterDir, "filter.rules"), fr.Rules4); err != nil {
				return err
			}
			if err := applyFamily("ip6tables", filepath.Join(FilterDir, "filter6.rules"), fr.Rules6); err != nil {
				// IPv6 may be off on the server: the IPv4 rules are what matters then. With an
				// IPv6 address, docker-proxy takes the published ports over IPv6 too
				if hasGlobalIPv6() {
					return errs.Newf("filter.ipv6", errs.ExitInternal, "the server has an IPv6 address, but the port filter's IPv6 rules could not be applied: %v", err).
						WithHint("install ip6tables on the server, or turn IPv6 off: the published ports stay reachable over IPv6 otherwise")
				}
				fmt.Fprintln(a.stderr, "ip6tables:", err)
			}
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:  "remove",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := chrootHost("/host"); err != nil {
				return errs.Internal("enter the host's root: %v", err)
			}
			if err := os.Setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"); err != nil {
				return errs.Internal("set PATH: %v", err)
			}
			for _, bin := range []string{"iptables", "ip6tables"} {
				if _, err := exec.LookPath(bin); err != nil {
					continue
				}
				// each may fail when there is nothing to remove
				_ = exec.Command(bin, "-w", "-D", "DOCKER-USER", "-j", filter.Chain).Run()
				_ = exec.Command(bin, "-w", "-D", "INPUT", "-j", filter.InputChain).Run()
				for _, chain := range []string{filter.Chain, filter.InputChain} {
					_ = exec.Command(bin, "-w", "-F", chain).Run()
					_ = exec.Command(bin, "-w", "-X", chain).Run()
				}
			}
			for _, f := range []string{"filter.rules", "filter6.rules"} {
				if err := os.Remove(filepath.Join(FilterDir, f)); err != nil && !os.IsNotExist(err) {
					return errs.Internal("remove %s: %v", f, err)
				}
			}
			return nil
		},
	})
	return cmd
}

// applyFamily keeps the rules in file, for the boot unit, and loads them: DOCKER-USER and the
// filter's chains exist, the chains are replaced atomically, DOCKER-USER jumps to DOCKFLOW-FILTER
// once and INPUT to DOCKFLOW-INPUT once. IPv4 rules that drop something are refused when Docker
// does not jump to DOCKER-USER: with its nftables backend, or without iptables, they would do
// nothing.
func applyFamily(bin, file, rules string) error {
	if err := os.WriteFile(file+".tmp", []byte(rules), 0o600); err != nil {
		return errs.Internal("write %s: %v", file, err)
	}
	if err := os.Rename(file+".tmp", file); err != nil {
		return errs.Internal("write %s: %v", file, err)
	}
	if _, err := exec.LookPath(bin); err != nil {
		return errs.Newf("filter.no_iptables", errs.ExitInternal, "%s is not installed on the server", bin)
	}
	for _, chain := range []string{"DOCKER-USER", filter.Chain, filter.InputChain} {
		if run(bin, "-w", "-n", "-L", chain) != nil {
			if err := run(bin, "-w", "-N", chain); err != nil {
				return err
			}
		}
	}
	restore := exec.Command(bin+"-restore", "-w", "--noflush")
	restore.Stdin = strings.NewReader(rules)
	if out, err := restore.CombinedOutput(); err != nil {
		return errs.Newf("filter.failed", errs.ExitInternal, "%s-restore: %v: %s", bin, err, strings.TrimSpace(string(out)))
	}
	for _, jump := range [][2]string{{"DOCKER-USER", filter.Chain}, {"INPUT", filter.InputChain}} {
		if run(bin, "-w", "-C", jump[0], "-j", jump[1]) != nil {
			if err := run(bin, "-w", "-I", jump[0], "-j", jump[1]); err != nil {
				return err
			}
		}
	}
	// IPv4 only: Docker may leave ip6tables alone ("ip6tables": false), where DOCKFLOW-INPUT is
	// what matters for networks without IPv6
	if bin == "iptables" && strings.Contains(rules, "-j DROP") && run(bin, "-w", "-C", "FORWARD", "-j", "DOCKER-USER") != nil {
		return errs.Newf("filter.inert", errs.ExitInternal, "Docker does not send forwarded traffic through %s's DOCKER-USER chain: the port filter would let everything in", bin).
			WithHint(`Docker's nftables firewall backend, or "iptables": false, leave the filter inert: use Docker's iptables backend, or run server init --no-port-filter and filter the ports yourself`)
	}
	return nil
}

// hasGlobalIPv6 tells whether an interface of the host has a global IPv6 address.
func hasGlobalIPv6() bool {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() == nil && n.IP.IsGlobalUnicast() {
			return true
		}
	}
	return false
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return errs.Newf("filter.failed", errs.ExitInternal, "%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
