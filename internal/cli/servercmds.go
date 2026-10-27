package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/launcher"
	"github.com/Shawiizz/dockflow/internal/proxy"
)

// serverStatusCmd is `dockflow server status`: the server as a whole.
func (a *app) serverStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status [<env>]",
		Short: "The server's settings, Dockflow's containers, every app environment, the disk",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var st agent.ServerStatus
			s, err := a.read(cmd, envArg(args), agent.OpServerStatus, &st, func(r *agent.Request) { r.Stack = "" })
			if err != nil {
				return err
			}
			defer s.Close()
			a.printResult(st, func(w io.Writer) { renderServerStatus(w, st) })
			return nil
		},
	}
}

func renderServerStatus(w io.Writer, st agent.ServerStatus) {
	if st.Server == nil {
		fmt.Fprintln(w, "server init has not run on this server")
	} else {
		srv := st.Server
		edge := srv.Edge
		if edge == proxy.EdgeExternal {
			edge += " on " + srv.SwitchListen
		}
		filter := "on"
		if srv.NoPortFilter {
			filter = "off"
		}
		fmt.Fprintf(w, "%s: Docker %s, edge %s, port filter %s, Dockflow %s\n", srv.Name, st.Docker, edge, filter, srv.DockflowVersion)
	}
	if st.DiskTotal > 0 {
		fmt.Fprintf(w, "disk: %s free of %s\n", humanBytes(st.DiskFree), humanBytes(st.DiskTotal))
	}
	fmt.Fprintln(w)
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "COMPONENT\tSTATE\tIMAGE")
	for _, c := range st.Components {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", c.Name, c.State, c.Image)
	}
	tw.Flush()
	if len(st.Apps) == 0 {
		return
	}
	fmt.Fprintln(w)
	tw = tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ENVIRONMENT\tRELEASE\tVERSION\tCONTAINERS")
	for _, app := range st.Apps {
		state := fmt.Sprintf("%d/%d running", app.Running, app.Total)
		if app.Degraded {
			state += ", DEGRADED"
		}
		fmt.Fprintf(tw, "%s\t%d\t%s\t%s\n", app.Stack, app.Release, app.Version, state)
	}
	tw.Flush()
}

// serverCheckCmd is `dockflow server check`: what Dockflow needs on the server.
func (a *app) serverCheckCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "check [<env>]",
		Short: "Check what Dockflow needs on the server: Docker, the secrets' tmpfs, the state, ports 80 and 443, the disk",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := a.connect(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			defer s.Close()
			a.quiet()
			req := s.request(agent.OpServerCheck)
			req.Stack = ""
			res, runErr := s.runAgent(cmd.Context(), req)
			var out struct {
				Checks []agent.Check `json:"checks"`
			}
			if res != nil && len(res.Results) > 0 {
				_ = json.Unmarshal(res.Results[len(res.Results)-1], &out)
			}
			if len(out.Checks) == 0 {
				return runErr
			}
			a.printResult(out, func(w io.Writer) {
				tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
				for _, c := range out.Checks {
					mark := map[string]string{"ok": "✓", "warn": "!", "fail": "✗"}[c.Level]
					line := fmt.Sprintf("%s %s\t%s", mark, c.Name, c.Detail)
					if c.Hint != "" && c.Level != "ok" {
						line += " (" + c.Hint + ")"
					}
					fmt.Fprintln(tw, line)
				}
				tw.Flush()
			})
			if runErr != nil {
				if e, ok := errs.As(runErr); ok {
					e.Reported = true
				}
			}
			return runErr
		},
	}
}

// serverEdgeCmd is `dockflow server edge`: server init with a new edge, the rest kept.
func (a *app) serverEdgeCmd() *cobra.Command {
	var listen string
	var trusted []string
	cmd := &cobra.Command{
		Use:   "edge [<env>] <builtin|cloudflare|external|none>",
		Short: "Change how traffic reaches the server's switch; every other setting stays",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			env, edge := "", args[0]
			if len(args) == 2 {
				env, edge = args[0], args[1]
			}
			res, err := a.serverChange(cmd, env, func(r *agent.Request) {
				r.Op, r.Edge, r.SwitchListen = agent.OpServerInit, edge, listen
				if cmd.Flags().Changed("trusted-proxy") {
					r.TrustedProxies = trusted
				}
			})
			if err == nil && !a.json {
				fmt.Fprintf(a.stdout, "✓ %s\n", describeServerRaw(res))
			}
			return err
		},
	}
	cmd.Flags().StringVar(&listen, "switch-listen", "", "with external: the address the switch listens on (default: the server's, or 127.0.0.1:8080)")
	cmd.Flags().StringSliceVar(&trusted, "trusted-proxy", nil, "with external: CIDRs whose X-Forwarded-For is trusted")
	return cmd
}

// serverUpgradeCmd is `dockflow server upgrade`: the switch and the registry pulled again, and
// the watchdog on this CLI's agent.
func (a *app) serverUpgradeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "upgrade [<env>]",
		Short: "Pull the switch's and the registry's images again, and run the watchdog of this version",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			res, err := a.serverChange(cmd, envArg(args), func(r *agent.Request) { r.Op, r.Upgrade = agent.OpServerInit, true })
			if err == nil && !a.json {
				fmt.Fprintf(a.stdout, "✓ upgraded (%s)\n", describeServerRaw(res))
			}
			return err
		},
	}
}

// serverUninstallCmd is `dockflow server uninstall`.
func (a *app) serverUninstallCmd() *cobra.Command {
	var volumes bool
	cmd := &cobra.Command{
		Use:   "uninstall [<env>]",
		Short: "Remove Dockflow from the server: every app environment, the switch, the registry, the watchdog, the filter, the state",
		Long: "Removes every app environment of the server (their containers, networks, secrets and records; with " +
			"--volumes, their volumes and data), the switch with its certificates, the registry with its images, the " +
			"watchdog, the shared networks, the port filter's rules and /var/lib/dockflow. The deploy user, Docker, " +
			"other containers and Docker's volume plugins stay.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := a.connect(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			name := s.target.Server.Name
			s.Close()
			switch {
			case a.interactive():
				what := "every app environment of " + name + ", and Dockflow itself"
				if volumes {
					what += ", with their volumes and data"
				}
				fmt.Fprintf(a.stdout, "This removes %s.\nType %s to confirm: ", what, name)
				var answer string
				fmt.Fscanln(a.stdin, &answer)
				if answer != name {
					return errs.New("run.declined", errs.ExitInterrupted, "nothing was changed")
				}
			case !a.yes:
				return errs.Usage("server uninstall removes every app of the server: confirm with --yes when there is no terminal")
			}
			s, err = a.connect(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			defer s.Close()
			req := s.request(agent.OpServerUninstall)
			req.Stack, req.Volumes = "", volumes
			res, err := s.runAgent(cmd.Context(), req)
			if err != nil {
				return err
			}
			// the agents' containers, this one's included, and the switch's admin volume they
			// mount, which no agent can remove while it runs
			ctx := context.WithoutCancel(cmd.Context())
			if c, err := s.engine.Inspect(ctx, agent.RunContainerPrefix+req.Run); err == nil {
				_, _ = s.engine.Wait(ctx, c.ID)
			}
			runs, _ := s.engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelKind: domain.KindRun}})
			for _, c := range runs {
				if c.State != "running" {
					_ = s.engine.Remove(ctx, c.ID)
				}
			}
			if err := s.engine.RemoveVolume(ctx, agent.SwitchAdminVolume); err != nil {
				a.emitter.Warn(events.Warning, err.Error(), map[string]any{"code": "uninstall.volume"})
			}
			if !a.json {
				var out struct {
					Environments []string `json:"environments"`
				}
				if len(res.Results) > 0 {
					_ = json.Unmarshal(res.Results[len(res.Results)-1], &out)
				}
				fmt.Fprintf(a.stdout, "✓ Dockflow removed from %s (%d environments)\n", name, len(out.Environments))
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&volumes, "volumes", false, "also delete the volumes of the app environments, with their data")
	return cmd
}

// describeServerRaw sums up the settings in an agent's server.init result.
func describeServerRaw(raw json.RawMessage) string {
	return describeServer(&launcher.Result{Results: []json.RawMessage{raw}})
}

// probeCmd is `dockflow probe <port>…`, run by the agent in a helper container on the host's
// network: it tells which ports are free to listen on. Hidden.
func (a *app) probeCmd() *cobra.Command {
	return &cobra.Command{
		Use: "probe", Hidden: true, Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			out := map[string]string{}
			for _, p := range args {
				l, err := net.Listen("tcp", ":"+p)
				if err != nil {
					out[p] = "in use"
					continue
				}
				_ = l.Close()
				out[p] = "free"
			}
			return json.NewEncoder(os.Stdout).Encode(out)
		},
	}
}
