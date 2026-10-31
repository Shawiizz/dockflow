package cli

import (
	"fmt"
	"io"
	"net/netip"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/proxy"
)

func (a *app) maintenanceCmd() *cobra.Command {
	var page string
	var allow []string
	cmd := &cobra.Command{
		Use:   "maintenance on|off [<env>]",
		Short: "Answer an environment's domains with a maintenance page, without stopping it",
		Long: "on answers every route of the environment with a 503 maintenance page, until `dockflow maintenance off`. " +
			"The services keep running, and deploys keep the maintenance page up. --allow lets some addresses through, to check the app before opening it again.",
		Args:      cobra.RangeArgs(1, 2),
		ValidArgs: []string{"on", "off"},
		RunE: func(cmd *cobra.Command, args []string) error {
			op := map[string]string{"on": agent.OpMaintenanceOn, "off": agent.OpMaintenanceOff}[args[0]]
			if op == "" {
				return errs.Usage("maintenance takes on or off, not %q", args[0])
			}
			if op == agent.OpMaintenanceOff && (page != "" || len(allow) > 0) {
				return errs.Usage("--page and --allow go with `maintenance on`")
			}
			m, err := maintenanceOf(page, allow)
			if err != nil {
				return err
			}
			var v struct {
				Maintenance *proxy.Maintenance `json:"maintenance"`
			}
			s, err := a.read(cmd, envArg(args[1:]), op, &v, func(r *agent.Request) { r.Maintenance = m })
			if err != nil {
				return err
			}
			defer s.Close()
			a.printResult(v, func(w io.Writer) {
				env := s.loaded.Config.Env
				switch {
				case v.Maintenance == nil:
					fmt.Fprintf(w, "%s is open\n", env)
				case len(v.Maintenance.Allow) > 0:
					fmt.Fprintf(w, "%s is under maintenance, except for %s, until `dockflow maintenance off`\n", env, strings.Join(v.Maintenance.Allow, ", "))
				default:
					fmt.Fprintf(w, "%s is under maintenance until `dockflow maintenance off`\n", env)
				}
			})
			return nil
		},
	}
	cmd.Flags().StringVar(&page, "page", "", "an HTML file to show instead of Dockflow's maintenance page")
	cmd.Flags().StringSliceVar(&allow, "allow", nil, "addresses or CIDR ranges that still reach the app, like 203.0.113.7 or 10.0.0.0/8")
	return cmd
}

// maintenanceOf reads the page and checks the addresses of maintenance on.
func maintenanceOf(page string, allow []string) (*proxy.Maintenance, error) {
	m := &proxy.Maintenance{}
	for _, a := range allow {
		a = strings.TrimSpace(a)
		if _, err := netip.ParsePrefix(a); err != nil {
			if _, err := netip.ParseAddr(a); err != nil {
				return nil, errs.Usage("--allow takes addresses or CIDR ranges, not %q", a)
			}
		}
		m.Allow = append(m.Allow, a)
	}
	if page != "" {
		b, err := os.ReadFile(page)
		if err != nil {
			return nil, errs.Usage("cannot read the maintenance page: %v", err)
		}
		if len(b) > proxy.MaxMaintenancePage {
			return nil, errs.Usage("%s is larger than %d KiB, the largest maintenance page", page, proxy.MaxMaintenancePage>>10)
		}
		m.Page = string(b)
	}
	return m, nil
}
