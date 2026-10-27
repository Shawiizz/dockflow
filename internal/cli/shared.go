package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// serverChange runs a server-wide operation on env's server, showing its events, and returns
// the agent's result.
func (a *app) serverChange(cmd *cobra.Command, env string, tweak func(*agent.Request)) (json.RawMessage, error) {
	s, err := a.attach(cmd.Context(), env)
	if err != nil {
		return nil, err
	}
	defer s.Close()
	req := s.request("")
	req.Stack = ""
	tweak(&req)
	res, err := s.runAgent(cmd.Context(), req)
	if err != nil {
		return nil, err
	}
	if len(res.Results) == 0 {
		return nil, nil
	}
	return res.Results[len(res.Results)-1], nil
}

// networkCmd is `dockflow server network` (ADR-0018).
func (a *app) networkCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "network", Short: "Networks shared between the apps of a server"}
	envName := func(args []string) (string, string) {
		if len(args) == 2 {
			return args[0], args[1]
		}
		return "", args[0]
	}
	for _, c := range []struct{ use, short, op, done string }{
		{"create [<env>] <name>", "Create a network apps join as an external network", agent.OpNetworkCreate, "created"},
		{"remove [<env>] <name>", "Remove a shared network no container uses", agent.OpNetworkRemove, "removed"},
	} {
		c := c
		cmd.AddCommand(&cobra.Command{
			Use: c.use, Short: c.short, Args: cobra.RangeArgs(1, 2),
			RunE: func(cmd *cobra.Command, args []string) error {
				env, name := envName(args)
				if _, err := a.serverChange(cmd, env, func(r *agent.Request) { r.Op, r.Name = c.op, name }); err != nil {
					return err
				}
				if !a.json {
					fmt.Fprintf(a.stdout, "✓ shared network %s %s\n", name, c.done)
				}
				return nil
			},
		})
	}
	cmd.AddCommand(&cobra.Command{
		Use: "list [<env>]", Short: "The shared networks, and the containers on each", Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var out struct {
				Networks []engine.NetworkInfo `json:"networks"`
			}
			s, err := a.read(cmd, envArg(args), agent.OpNetworkList, &out, func(r *agent.Request) { r.Stack = "" })
			if err != nil {
				return err
			}
			defer s.Close()
			a.printResult(out, func(w io.Writer) {
				tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
				fmt.Fprintln(tw, "NETWORK\tCONTAINERS")
				for _, n := range out.Networks {
					fmt.Fprintf(tw, "%s\t%s\n", n.Name, strings.Join(n.Containers, " "))
				}
				tw.Flush()
			})
			return nil
		},
	})
	return cmd
}

// volumePluginCmd is `dockflow server plugin`: Docker managed plugins, such as volume drivers,
// not Dockflow's own plugins (ADR-0018).
func (a *app) volumePluginCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "plugin", Short: "Docker volume plugins of a server (not Dockflow plugins)"}
	var alias string
	install := &cobra.Command{
		Use:   "install [<env>] <plugin> [<key>=<value>…]",
		Short: "Install and enable a Docker plugin, granting the privileges it asks for",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var names, settings []string
			for _, arg := range args {
				if strings.Contains(arg, "=") {
					settings = append(settings, arg)
				} else {
					names = append(names, arg)
				}
			}
			env, ref := "", ""
			switch len(names) {
			case 1:
				ref = names[0]
			case 2:
				env, ref = names[0], names[1]
			default:
				return errs.Usage("give the plugin, and optionally the environment before it")
			}
			// a setting can hold a credential
			for _, s := range settings {
				_, v, _ := strings.Cut(s, "=")
				a.emitter.Masker().Add(v)
			}
			raw, err := a.serverChange(cmd, env, func(r *agent.Request) {
				r.Op, r.Name, r.Alias, r.Settings = agent.OpPluginInstall, ref, alias, settings
			})
			if err != nil {
				return err
			}
			var out struct {
				Plugin     string   `json:"plugin"`
				Privileges []string `json:"privileges"`
			}
			_ = json.Unmarshal(raw, &out)
			if !a.json {
				fmt.Fprintf(a.stdout, "✓ plugin %s installed as %s\n", ref, out.Plugin)
				for _, p := range out.Privileges {
					fmt.Fprintf(a.stdout, "  granted %s\n", p)
				}
			}
			return nil
		},
	}
	install.Flags().StringVar(&alias, "alias", "", "the plugin's name on the server, which Compose volumes give as their driver (default: the plugin)")
	cmd.AddCommand(install)
	cmd.AddCommand(&cobra.Command{
		Use: "remove [<env>] <plugin>", Short: "Disable and remove a plugin no volume uses", Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			env, name := "", args[0]
			if len(args) == 2 {
				env, name = args[0], args[1]
			}
			if _, err := a.serverChange(cmd, env, func(r *agent.Request) { r.Op, r.Name = agent.OpPluginRemove, name }); err != nil {
				return err
			}
			if !a.json {
				fmt.Fprintf(a.stdout, "✓ plugin %s removed\n", name)
			}
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use: "list [<env>]", Short: "The Docker plugins of the server", Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var out struct {
				Plugins []engine.Plugin `json:"plugins"`
			}
			s, err := a.read(cmd, envArg(args), agent.OpPluginList, &out, func(r *agent.Request) { r.Stack = "" })
			if err != nil {
				return err
			}
			defer s.Close()
			a.printResult(out, func(w io.Writer) {
				tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
				fmt.Fprintln(tw, "PLUGIN\tENABLED\tTYPES\tREFERENCE")
				for _, p := range out.Plugins {
					fmt.Fprintf(tw, "%s\t%v\t%s\t%s\n", p.Name, p.Enabled, strings.Join(p.Types, " "), p.Reference)
				}
				tw.Flush()
			})
			return nil
		},
	})
	return cmd
}
