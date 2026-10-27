package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"go.yaml.in/yaml/v3"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/launcher"
	"github.com/Shawiizz/dockflow/internal/project"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
	"github.com/Shawiizz/dockflow/internal/version"
)

// quiet keeps a read command's output to its document: only warnings and errors are shown,
// and nothing but the document with --json.
func (a *app) quiet() {
	var sink events.Sink = events.SinkFunc(func(e events.Event) {
		if e.Level == events.Warn || e.Level == events.Error {
			if e.Type != events.RunFinished {
				a.human.Emit(e)
			}
		}
	})
	if a.json {
		sink = events.SinkFunc(func(events.Event) {})
	}
	a.emitter = events.NewEmitter(launcher.NewRunID(timeNow()), sink, a.emitter.Masker())
}

// read runs a read-only agent operation and decodes its result into v.
func (a *app) read(cmd *cobra.Command, env, op string, v any, tweak func(*agent.Request)) (*session, error) {
	a.quiet()
	s, err := a.connect(cmd.Context(), env, "")
	if err != nil {
		return nil, err
	}
	req := s.request(op)
	if tweak != nil {
		tweak(&req)
	}
	res, err := s.runAgent(cmd.Context(), req)
	if err != nil {
		s.Close()
		// quiet: the event that reported it was not shown
		if e, ok := errs.As(err); ok {
			e.Reported = false
		}
		return nil, err
	}
	if len(res.Results) == 0 {
		s.Close()
		return nil, errs.Internal("the agent returned no result")
	}
	if err := json.Unmarshal(res.Results[len(res.Results)-1], v); err != nil {
		s.Close()
		return nil, errs.Internal("cannot read the agent's result: %v", err)
	}
	return s, nil
}

func (a *app) statusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status [<env>]",
		Short: "Current release, services and containers; without <env>, every environment",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			envs := args
			if len(envs) == 0 {
				raw, _, err := project.Read(a.dir, "")
				if raw == nil {
					return err
				}
				envs = raw.EnvNames()
			}
			var all []agent.Status
			for _, env := range envs {
				var st agent.Status
				s, err := a.read(cmd, env, agent.OpStatus, &st, nil)
				if err != nil {
					return err
				}
				s.Close()
				all = append(all, st)
			}
			var doc any = all
			if len(args) == 1 {
				doc = all[0]
			}
			a.printResult(doc, func(w io.Writer) {
				for i, st := range all {
					if i > 0 {
						fmt.Fprintln(w)
					}
					renderStatus(w, st)
				}
			})
			return nil
		},
	}
}

func (a *app) listCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "list", Short: "List environments, services and images"}
	cmd.AddCommand(a.listImagesCmd(), &cobra.Command{
		Use:   "envs",
		Short: "The environments of dockflow.yml",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			raw, _, err := project.Read(a.dir, "")
			if raw == nil {
				return err
			}
			type envDoc struct {
				Name      string `json:"name"`
				TagSuffix string `json:"tag_suffix"`
			}
			var list []envDoc
			for _, e := range raw.EnvNames() {
				list = append(list, envDoc{Name: e, TagSuffix: raw.TagSuffix(e)})
			}
			a.printResult(list, func(w io.Writer) {
				tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
				fmt.Fprintln(tw, "ENVIRONMENT\tCI TAGS")
				for _, e := range list {
					tags := "x.y.z"
					if e.TagSuffix != "" {
						tags = "x.y.z-" + e.TagSuffix
					}
					fmt.Fprintf(tw, "%s\t%s\n", e.Name, tags)
				}
				tw.Flush()
			})
			return nil
		},
	}, &cobra.Command{
		Use:   "services [<env>]",
		Short: "The services of an environment, as Dockflow will deploy them",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			l, err := a.load(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			a.printResult(l.App.Services, func(w io.Writer) {
				tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
				fmt.Fprintln(tw, "SERVICE\tIMAGE\tREPLICAS\tSTRATEGY\tROUTES")
				for _, s := range l.App.Services {
					fmt.Fprintf(tw, "%s\t%s\t%d\t%s\t%s\n", s.Name, s.Spec.Image, s.Replicas, s.Strategy, strings.Join(routeList(s.Routes), " "))
				}
				tw.Flush()
			})
			return nil
		},
	})
	return cmd
}

func (a *app) listImagesCmd() *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "images [<env>]",
		Short: "The app's images on the server; -a for every image",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			a.quiet()
			s, err := a.connect(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			defer s.Close()
			imgs, err := s.engine.Images(cmd.Context())
			if err != nil {
				return err
			}
			imgs = imagesOf(imgs, s.loaded.Config.App, all)
			a.printResult(imgs, func(w io.Writer) { renderImages(w, imgs) })
			return nil
		},
	}
	cmd.Flags().BoolVarP(&all, "all", "a", false, "every image of the server")
	return cmd
}

func routeList(rs []domain.Route) []string {
	var out []string
	for _, r := range rs {
		for _, d := range r.Domains {
			out = append(out, d+r.Path)
		}
	}
	return out
}

func renderStatus(w io.Writer, st agent.Status) {
	fmt.Fprintf(w, "%s %s\n", st.App, st.Env)
	if st.Current == nil {
		fmt.Fprintln(w, "  never deployed")
	} else {
		c := st.Current
		fmt.Fprintf(w, "  release %d, version %s, deployed %s by %s\n", c.Seq, c.Version, c.FinishedAt, c.CreatedBy.User)
	}
	if st.State != nil && st.State.Degraded {
		fmt.Fprintln(w, "  DEGRADED: the last deploy failed and was not rolled back")
	}
	if st.Lock != nil {
		fmt.Fprintf(w, "  locked by %s since %s: %s\n", st.Lock.By, st.Lock.Since.Format("2006-01-02 15:04"), st.Lock.Message)
	}
	for _, r := range st.Watchdog {
		what := "restarted, unhealthy"
		if r.Reason == "boot" {
			what = "started again after a reboot"
		}
		fmt.Fprintf(w, "  watchdog: %s %s on %s\n", r.Container, what, r.At.Local().Format("2006-01-02 15:04"))
	}
	if len(st.Services) == 0 {
		return
	}
	fmt.Fprintln(w)
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "SERVICE\tRUNNING\tRELEASE\tSTRATEGY\tROUTES")
	for _, svc := range st.Services {
		fmt.Fprintf(tw, "%s\t%d/%d\t%d\t%s\t%s\n", svc.Name, svc.Running, svc.Desired, svc.Release, svc.Strategy, strings.Join(svc.Domains, " "))
	}
	tw.Flush()
}

type releasesResult struct {
	State    *domain.EnvRecord      `json:"state"`
	Releases []agent.ReleaseSummary `json:"releases"`
}

func (a *app) releasesCmd() *cobra.Command {
	var n int
	var withStats bool
	cmd := &cobra.Command{
		Use:   "releases [<env>]",
		Short: "Release history",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var r releasesResult
			s, err := a.read(cmd, envArg(args), agent.OpReleases, &r, nil)
			if err != nil {
				return err
			}
			defer s.Close()
			st := stats(r.Releases)
			if n > 0 && len(r.Releases) > n {
				r.Releases = r.Releases[:n]
			}
			var doc any = r
			if withStats {
				doc = map[string]any{"state": r.State, "releases": r.Releases, "stats": st}
			}
			a.printResult(doc, func(w io.Writer) {
				tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
				fmt.Fprintln(tw, "SEQ\tVERSION\tSTATUS\tCREATED\tBY\t")
				for _, rel := range r.Releases {
					mark := ""
					if r.State != nil && rel.Seq == r.State.Current {
						mark = "← current"
					}
					status := rel.Status
					if rel.RollbackOf > 0 {
						status += fmt.Sprintf(" (rollback to %d)", rel.RollbackOf)
					}
					if rel.Op != "" && rel.Op != agent.OpDeploy && rel.Op != agent.OpRollback {
						status += " (" + rel.Op + ")"
					}
					fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%s\t%s\n", rel.Seq, rel.Version, status, rel.CreatedAt, rel.CreatedBy.User, mark)
				}
				tw.Flush()
				if withStats {
					renderStats(w, st)
				}
			})
			return nil
		},
	}
	cmd.Flags().IntVarP(&n, "count", "n", 0, "show the n most recent releases")
	cmd.Flags().BoolVar(&withStats, "stats", false, "add durations and the success rate")
	return cmd
}

func (a *app) versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version [<env>]",
		Short: "The deployed version; without <env>, the CLI's",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				a.printResult(map[string]string{"version": version.Version}, func(w io.Writer) {
					fmt.Fprintf(w, "dockflow %s\n", version.Version)
				})
				return nil
			}
			var st agent.Status
			s, err := a.read(cmd, args[0], agent.OpStatus, &st, nil)
			if err != nil {
				return err
			}
			defer s.Close()
			if st.Current == nil {
				return errs.Newf("env.never_deployed", errs.ExitPlan, "%s was never deployed", st.Env)
			}
			a.printResult(map[string]any{"version": st.Current.Version, "release": st.Current.Seq}, func(w io.Writer) {
				fmt.Fprintln(w, st.Current.Version)
			})
			return nil
		},
	}
}

func (a *app) lockCmd() *cobra.Command {
	var message string
	var force bool
	cmd := &cobra.Command{
		Use:       "lock status|acquire|release [<env>]",
		Short:     "Hold an environment's lock by hand, for a maintenance window",
		Args:      cobra.RangeArgs(1, 2),
		ValidArgs: []string{"status", "acquire", "release"},
		RunE: func(cmd *cobra.Command, args []string) error {
			op := map[string]string{"status": agent.OpLockStatus, "acquire": agent.OpLockAcquire, "release": agent.OpLockRelease}[args[0]]
			if op == "" {
				return errs.Usage("lock takes status, acquire or release, not %q", args[0])
			}
			var v map[string]any
			s, err := a.read(cmd, envArg(args[1:]), op, &v, func(r *agent.Request) {
				r.Force = force
				r.Lock = &domain.LockInfo{Message: message}
			})
			if err != nil {
				return err
			}
			defer s.Close()
			a.printResult(v, func(w io.Writer) {
				switch args[0] {
				case "acquire":
					fmt.Fprintf(w, "%s is locked: deploys are refused until `dockflow lock release`\n", s.loaded.Config.Env)
				case "release":
					fmt.Fprintf(w, "%s is unlocked\n", s.loaded.Config.Env)
				default:
					if m, ok := v["manual"].(map[string]any); ok && m != nil {
						fmt.Fprintf(w, "locked by %v since %v: %v\n", m["by"], m["since"], m["message"])
					} else {
						fmt.Fprintln(w, "not locked")
					}
				}
			})
			return nil
		},
	}
	cmd.Flags().StringVarP(&message, "message", "m", "", "why the environment is locked")
	cmd.Flags().BoolVar(&force, "force", false, "take over or release someone else's manual lock")
	return cmd
}

func (a *app) validateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "validate [<env>]",
		Short: "Check everything that can be checked without a server",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			l, err := a.load(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			a.printResult(map[string]any{"valid": true, "env": l.Config.Env, "warnings": l.Warnings}, func(w io.Writer) {
				for _, warn := range l.Warnings {
					fmt.Fprintf(w, "! %s\n", warn)
				}
				fmt.Fprintf(w, "%s: valid, %d services\n", l.Config.Env, len(l.App.Services))
			})
			return nil
		},
	}
}

func (a *app) configCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "config", Short: "The resolved configuration"}
	cmd.AddCommand(&cobra.Command{
		Use:   "show [<env>]",
		Short: "The resolved configuration and services, secrets masked",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			l, err := a.load(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			doc := map[string]any{
				"app": l.Config.App, "env": l.Config.Env, "version": l.Version,
				"settings": map[string]any{"releases": map[string]int{"keep": l.Config.Keep}, "on_failure": l.Config.OnFailure},
				"secrets":  l.Secrets.Describe(), "services": l.App.Services, "networks": l.App.Networks, "volumes": l.App.Volumes,
				"files": l.App.Files,
			}
			// plugins expanded: their uploads and hooks are listed with the project's own
			if len(l.Config.Uploads) > 0 {
				type upload struct {
					Src    string `json:"src"`
					Dest   string `json:"dest"`
					Plugin string `json:"plugin,omitempty"`
				}
				var ups []upload
				for _, u := range l.Config.Uploads {
					ups = append(ups, upload{u.Src, u.Dest, u.Plugin})
				}
				doc["uploads"] = ups
			}
			if len(l.Config.Hooks) > 0 {
				doc["hooks"] = l.Config.Hooks
			}
			b, _ := json.MarshalIndent(doc, "", "  ")
			if !a.json {
				// YAML for people, as the files it comes from; through JSON for the field names
				var v any
				if err := json.Unmarshal(b, &v); err != nil {
					return errs.Internal("encode the configuration: %v", err)
				}
				var buf bytes.Buffer
				enc := yaml.NewEncoder(&buf)
				enc.SetIndent(2)
				if err := enc.Encode(v); err != nil {
					return errs.Internal("encode the configuration: %v", err)
				}
				b = buf.Bytes()
			}
			fmt.Fprintln(a.stdout, strings.TrimRight(a.mask(string(b)), "\n"))
			return nil
		},
	})
	return cmd
}

func (a *app) serverCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "server", Short: "Manage servers"}
	var edge, switchImage, registryImage, switchListen string
	var trusted []string
	var noRegistry, noFilter, noWatchdog bool
	var pf provisionFlags
	initCmd := &cobra.Command{
		Use:   "init [<env> | <admin>@<host>[:port]]",
		Short: "Prepare a server: Docker, the deploy user and its key, the switch, the registry and the watchdog",
		Long: "With <admin>@<host>, connects as root or as a user with passwordless sudo, installs Docker when it is " +
			"missing (Debian, Ubuntu), creates the deploy user with a key generated on this machine, then installs " +
			"the switch and the registry as that user, and prints the connection string for your CI. The server's " +
			"host key must be known: --host-key, or your known_hosts. Every step can be run again.\n\n" +
			"Without an argument, outside a project, prepares the server it runs on, as root: the same steps, with " +
			"the address, the SSH port and the host key read on the server.\n\n" +
			"With an environment, installs or updates the switch and the registry on its server, reached as for a deploy.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			// an option not given keeps what the server has: running it again only updates
			flags := cmd.Flags()
			on := func(name string, off bool) *bool {
				if !flags.Changed(name) {
					return nil
				}
				v := !off
				return &v
			}
			provisioning := (len(args) == 0 && !inProject(a.dir)) || (len(args) == 1 && strings.Contains(args[0], "@"))
			if provisioning && a.interactive() && !flags.Changed("edge") && !pf.nginx {
				var err error
				if edge, pf.nginx, err = a.askEdge(); err != nil {
					return err
				}
			}
			if pf.nginx && edge == "" {
				// nginx in front of the switch
				edge = proxy.EdgeExternal
			}
			init := func(req *agent.Request) {
				req.Edge, req.SwitchImage, req.SwitchListen, req.RegistryImage = edge, switchImage, switchListen, registryImage
				if flags.Changed("trusted-proxy") {
					req.TrustedProxies = trusted
				}
				req.Registry = on("no-registry", noRegistry)
				req.PortFilter = on("no-port-filter", noFilter)
				req.Watchdog = on("no-watchdog", noWatchdog)
			}
			pf.noFilter = noFilter
			if len(args) == 0 && !inProject(a.dir) {
				return a.provisionHere(cmd.Context(), pf, init)
			}
			if pf.host != "" || pf.port != 0 {
				return errs.Usage("--host and --port are for server init without an argument, on the server itself")
			}
			if len(args) == 1 && strings.Contains(args[0], "@") {
				return a.provisionServer(cmd.Context(), args[0], pf, init)
			}
			s, err := a.connect(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			defer s.Close()
			req := s.request(agent.OpServerInit)
			req.Stack = ""
			init(&req)
			req.SSHPort = s.target.Server.Port
			res, err := s.runAgent(cmd.Context(), req)
			if err == nil && !a.json {
				fmt.Fprintf(a.stdout, "✓ %s is ready (%s)\n", s.target.Server.Name, describeServer(res))
			}
			return err
		},
	}
	initCmd.Flags().StringVar(&edge, "edge", "", "how traffic reaches the switch: builtin, cloudflare, external or none (default: the server's, or builtin)")
	initCmd.Flags().StringVar(&switchListen, "switch-listen", "", "with --edge external: the address the switch listens on (default 127.0.0.1:8080)")
	initCmd.Flags().StringSliceVar(&trusted, "trusted-proxy", nil, "with --edge external: CIDRs whose X-Forwarded-For is trusted (default: private ranges)")
	initCmd.Flags().StringVar(&switchImage, "switch-image", "", "the Caddy image of the switch (default caddy:2, pinned by digest)")
	initCmd.Flags().BoolVar(&noRegistry, "no-registry", false, "no server-local registry: every built image goes to registry.url")
	initCmd.Flags().StringVar(&registryImage, "registry-image", "", "the image of the server-local registry (default registry:3, pinned by digest)")
	initCmd.Flags().BoolVar(&noFilter, "no-port-filter", false, "no published-port filter: every port Docker publishes on a public address is open")
	initCmd.Flags().BoolVar(&noWatchdog, "no-watchdog", false, "no watchdog: unhealthy containers are not restarted, and apps with Compose secrets wait for a deploy after a reboot")
	f := initCmd.Flags()
	f.StringVarP(&pf.key, "key", "k", "", "with <admin>@<host>: the administrator's private key (default: ssh-agent, ~/.ssh)")
	f.StringVar(&pf.passwordFile, "password-file", "", "with <admin>@<host>: a file holding the administrator's password")
	f.StringVar(&pf.hostKey, "host-key", "", "with <admin>@<host>: the server's host key fingerprint (SHA256:…), when known_hosts does not have it")
	f.StringVar(&pf.user, "user", "", "when preparing a server: the deploy user to create (default dockflow)")
	f.StringVar(&pf.deployKey, "deploy-key", "", "when preparing a server: use this private key for the deploy user instead of generating one")
	f.StringVar(&pf.name, "name", "", "when preparing a server: its name in the connection string (default main)")
	f.BoolVar(&pf.skipDocker, "skip-docker-install", false, "when preparing a server: refuse one without Docker instead of installing it")
	f.BoolVar(&pf.noHarden, "no-hardening", false, "when preparing a server: leave SSH, fail2ban, security updates and time synchronisation as they are")
	f.BoolVar(&pf.nginx, "nginx", false, "when preparing a server: install nginx in front of the switch (edge external by default), with the sudo rules of the nginx plugin")
	f.StringSliceVar(&pf.from, "from", nil, "when preparing a server: the source addresses or CIDRs the deploy key accepts (from= of authorized_keys)")
	f.StringVar(&pf.host, "host", "", "on the server itself: the address or domain name the CI reaches it at (default: its public address)")
	f.IntVar(&pf.port, "port", 0, "on the server itself: the SSH port the CI uses (default: the Port of sshd_config, or 22)")
	cmd.AddCommand(initCmd, a.connectionCmd(), a.networkCmd(), a.volumePluginCmd(), a.cloudInitCmd())
	return cmd
}

// describeServer sums up the settings server init left on a server.
func describeServer(res *launcher.Result) string {
	var srv state.Server
	if res != nil && len(res.Results) > 0 {
		_ = json.Unmarshal(res.Results[len(res.Results)-1], &srv)
	}
	parts := []string{"edge: " + srv.Edge}
	if srv.Edge == proxy.EdgeExternal {
		parts[0] += " on " + srv.SwitchListen
	}
	if srv.RegistryImage == "" {
		parts = append(parts, "no registry")
	}
	if srv.NoPortFilter {
		parts = append(parts, "no port filter")
	}
	if srv.NoWatchdog {
		parts = append(parts, "no watchdog")
	}
	return strings.Join(parts, ", ")
}
