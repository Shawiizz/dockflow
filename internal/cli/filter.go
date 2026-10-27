package cli

import (
	"encoding/json"
	"fmt"
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
			// IPv6 may be off on the server: the IPv4 rules are what matters then
			if err := applyFamily("ip6tables", filepath.Join(FilterDir, "filter6.rules"), fr.Rules6); err != nil {
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
				_ = exec.Command(bin, "-w", "-F", filter.Chain).Run()
				_ = exec.Command(bin, "-w", "-X", filter.Chain).Run()
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
// filter's chain exist, the chain is replaced atomically, and DOCKER-USER jumps to it once.
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
	for _, chain := range []string{"DOCKER-USER", filter.Chain} {
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
	if run(bin, "-w", "-C", "DOCKER-USER", "-j", filter.Chain) != nil {
		return run(bin, "-w", "-I", "DOCKER-USER", "-j", filter.Chain)
	}
	return nil
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return errs.Newf("filter.failed", errs.ExitInternal, "%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
