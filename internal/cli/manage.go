package cli

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/project"
)

// envAndServices reads [<env>] [<service>…]: a first argument naming an environment is one.
func (a *app) envAndServices(args []string) (string, []string) {
	if len(args) == 0 {
		return "", nil
	}
	if raw, _, _ := project.Read(a.dir, ""); raw != nil {
		for _, e := range raw.EnvNames() {
			if e == args[0] {
				return args[0], args[1:]
			}
		}
	}
	return "", args
}

// change runs an agent operation that changes the running services under the lock.
func (a *app) change(cmd *cobra.Command, env, op string, tweak func(*agent.Request)) error {
	s, err := a.attach(cmd.Context(), env)
	if err != nil {
		return err
	}
	defer s.Close()
	req := s.request(op)
	tweak(&req)
	_, err = s.runAgent(cmd.Context(), req)
	return err
}

func (a *app) restartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "restart [<env>] [<service>…]",
		Short: "Restart services with their rollout strategy: routed ones without downtime",
		RunE: func(cmd *cobra.Command, args []string) error {
			env, services := a.envAndServices(args)
			return a.change(cmd, env, agent.OpRestart, func(r *agent.Request) { r.Services = services })
		},
	}
}

func (a *app) stopCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stop [<env>] [<service>…]",
		Short: "Stop services until the next deploy or restart",
		RunE: func(cmd *cobra.Command, args []string) error {
			env, services := a.envAndServices(args)
			return a.change(cmd, env, agent.OpStop, func(r *agent.Request) { r.Services = services })
		},
	}
}

func (a *app) scaleCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "scale [<env>] <service> <replicas>",
		Short: "Change a service's replicas until the next deploy",
		Args:  cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			env := ""
			if len(args) == 3 {
				env, args = args[0], args[1:]
			}
			n, err := strconv.Atoi(args[1])
			if err != nil || n < 1 {
				return errs.Usage("replicas must be a number of at least 1; `dockflow stop` stops a service")
			}
			return a.change(cmd, env, agent.OpScale, func(r *agent.Request) {
				r.Services, r.Replicas = []string{args[0]}, n
			})
		},
	}
}

func (a *app) destroyCmd() *cobra.Command {
	var only []string
	var volumes bool
	cmd := &cobra.Command{
		Use:   "destroy [<env>]",
		Short: "Remove an environment, or some of its services, from the server",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			l, err := a.load(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			env := l.Config.Env
			what := "every container, route and record of " + env
			if len(only) > 0 {
				what = strings.Join(only, ", ") + " of " + env
			}
			switch {
			case volumes && len(only) > 0:
				return errs.Usage("--volumes goes with destroying the whole environment")
			case volumes && !a.interactive() && !a.yes:
				return errs.Usage("--volumes deletes data: confirm with --yes when there is no terminal")
			case volumes && a.interactive():
				fmt.Fprintf(a.stdout, "This deletes %s, and its volumes with their data.\nType %s to confirm: ", what, env)
				var answer string
				fmt.Fscanln(a.stdin, &answer)
				if answer != env {
					return errs.New("run.declined", errs.ExitInterrupted, "nothing was changed")
				}
			case !a.confirm("Destroy " + what + "?"):
				return errs.New("run.declined", errs.ExitInterrupted, "nothing was changed")
			}
			return a.change(cmd, env, agent.OpDestroy, func(r *agent.Request) {
				r.Services, r.Volumes = only, volumes
			})
		},
	}
	cmd.Flags().StringSliceVar(&only, "only", nil, "destroy these services only")
	cmd.Flags().BoolVar(&volumes, "volumes", false, "also delete the environment's volumes and their data")
	return cmd
}

func (a *app) pruneCmd() *cobra.Command {
	var p agent.PruneRequest
	cmd := &cobra.Command{
		Use:   "prune [<env>]",
		Short: "Remove unused Docker objects from the server, never what Dockflow keeps",
		Long:  "Without a kind, removes stopped containers, untagged images and networks that Dockflow does not manage, and runs the registry's garbage collection. Images of the releases in retention and app volumes are always kept; --volumes removes unused anonymous volumes only.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !p.Containers && !p.Images && !p.Volumes && !p.Networks && !p.Registry {
				p.Containers, p.Images, p.Networks, p.Registry = true, true, true, true
			}
			if p.AllImages {
				p.Images = true
			}
			var rep agent.PruneReport
			s, err := a.read(cmd, envArg(args), agent.OpPrune, &rep, func(r *agent.Request) { r.Prune = &p })
			if err != nil {
				return err
			}
			defer s.Close()
			a.printResult(rep, func(w io.Writer) {
				fmt.Fprintf(w, "removed %d containers, %d images (%s), %d volumes, %d networks\n",
					len(rep.Containers), len(rep.Images), humanBytes(uint64(rep.Reclaimed)), len(rep.Volumes), len(rep.Networks))
			})
			return nil
		},
	}
	f := cmd.Flags()
	f.BoolVar(&p.Containers, "containers", false, "stopped containers")
	f.BoolVar(&p.Images, "images", false, "untagged images")
	f.BoolVarP(&p.AllImages, "all", "a", false, "every unused image, not only untagged ones")
	f.BoolVar(&p.Volumes, "volumes", false, "unused anonymous volumes")
	f.BoolVar(&p.Networks, "networks", false, "unused networks")
	f.BoolVar(&p.Registry, "registry", false, "the layers of the server's registry that no kept release uses; run it outside deploys")
	return cmd
}

func (a *app) cancelCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cancel [<env>]",
		Short: "Ask the running agent to stop and roll back, and follow it",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.attach(ctx, envArg(args))
			if err != nil {
				return err
			}
			defer s.Close()
			stack := domain.Stack(s.loaded.Config.App, s.loaded.Config.Env)
			cs, err := s.engine.Containers(ctx, engine.Filter{Labels: map[string]string{domain.LabelKind: domain.KindRun, domain.LabelProject: stack}})
			if err != nil {
				return err
			}
			if len(cs) == 0 {
				return errs.Usage("no run of %s is in progress", s.loaded.Config.Env)
			}
			c := cs[0]
			if err := s.engine.Kill(ctx, c.ID, "SIGINT"); err != nil {
				return err
			}
			res, err := s.launcher.Attach(ctx, strings.TrimPrefix(c.Name, agent.RunContainerPrefix))
			if err != nil {
				return err
			}
			if !a.json {
				a.human.finish(res.RunFinishedData)
			}
			if res.ExitCode != 0 && res.ExitCode != errs.ExitInterrupted {
				return &errs.Error{Code: errCode(res.Error), Exit: res.ExitCode, Message: errMessage(res.Error), Reported: true}
			}
			return nil
		},
	}
}

func (a *app) detailsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "details [<env>]",
		Short: "Every service of the current release: image, ports, networks, mounts, resources",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var rel domain.Release
			s, err := a.read(cmd, envArg(args), agent.OpDetails, &rel, nil)
			if err != nil {
				return err
			}
			defer s.Close()
			a.printResult(rel, func(w io.Writer) { renderDetails(w, &rel, a.mask) })
			return nil
		},
	}
}

func renderDetails(w io.Writer, rel *domain.Release, mask func(string) string) {
	fmt.Fprintf(w, "%s %s, release %d (%s)\n", rel.App, rel.Env, rel.Seq, rel.Version)
	for _, s := range rel.Desired.Services {
		kind := string(s.Strategy)
		if s.Job != "" {
			kind = "job, " + s.Job
		}
		state := fmt.Sprintf("%d replicas", s.Replicas)
		if s.Stopped {
			state = "stopped"
		}
		fmt.Fprintf(w, "\n%s (%s, %s, release %d)\n", s.Name, kind, state, rel.Serving[s.Name])
		fmt.Fprintf(w, "  image     %s\n", s.Spec.Image)
		for _, rt := range s.Routes {
			fmt.Fprintf(w, "  route     %s%s → :%d (tls %v)\n", strings.Join(rt.Domains, ","), rt.Path, rt.Port, rt.TLS)
		}
		for _, p := range s.Spec.Ports {
			host := p.HostPort
			if p.HostIP != "" {
				host = p.HostIP + ":" + host
			}
			fmt.Fprintf(w, "  port      %s → %d/%s\n", host, p.ContainerPort, p.Protocol)
		}
		for _, n := range s.Spec.Networks {
			fmt.Fprintf(w, "  network   %s (%s)\n", n.Network, strings.Join(n.Aliases, ", "))
		}
		for _, m := range s.Spec.Mounts {
			ro := ""
			if m.ReadOnly {
				ro = " (read-only)"
			}
			fmt.Fprintf(w, "  mount     %s %s → %s%s\n", m.Type, m.Source, m.Target, ro)
		}
		if r := s.Spec.Resources; r.MemoryLimit > 0 || r.CPUs > 0 {
			fmt.Fprintf(w, "  limits    memory %s, cpus %g\n", humanBytes(uint64(r.MemoryLimit)), r.CPUs)
		}
		fmt.Fprintf(w, "  restart   %s\n", s.Spec.Restart)
		if len(s.Spec.Env) > 0 {
			fmt.Fprintf(w, "  env       %s\n", mask(strings.Join(envKeys(s.Spec.Env), " ")))
		}
	}
}

// envKeys shows environment variables by name only: their values may be secrets.
func envKeys(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		out = append(out, k)
	}
	return out
}

func humanBytes(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// finding is one problem diagnose found.
type finding struct {
	Container string `json:"container,omitempty"`
	Service   string `json:"service,omitempty"`
	Problem   string `json:"problem"`
	Detail    string `json:"detail"`
}

func (a *app) diagnoseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "diagnose [<env>]",
		Short: "Why containers don't run: exits, crash loops, failed health checks, OOM kills, ports in use, disk space",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			var st agent.Status
			s, err := a.read(cmd, envArg(args), agent.OpStatus, &st, nil)
			if err != nil {
				return err
			}
			defer s.Close()
			findings := []finding{}
			add := func(c engine.Container, problem, detail string) {
				findings = append(findings, finding{Container: c.Name, Service: c.Service, Problem: problem, Detail: a.mask(detail)})
			}
			cs, err := s.appContainers(ctx, true)
			if err != nil {
				return err
			}
			for _, c := range serving(cs) {
				in, err := s.engine.Inspect(ctx, c.ID)
				if err != nil {
					continue
				}
				switch {
				case in.OOMKilled:
					add(in, "oom_killed", "killed for lack of memory; raise its memory limit or the server's memory")
				case strings.Contains(in.Error, "port is already allocated") || strings.Contains(in.Error, "address already in use"):
					add(in, "port_in_use", in.Error)
				case in.State == "exited" || in.State == "dead":
					add(in, "exited", fmt.Sprintf("exited with code %d; see `dockflow logs %s`", in.ExitCode, in.Service))
				case in.State == "restarting" || in.RestartCount > 2:
					add(in, "crash_loop", fmt.Sprintf("restarted %d times, last exit code %d", in.RestartCount, in.ExitCode))
				case in.Health == "unhealthy":
					add(in, "unhealthy", fmt.Sprintf("%d failed health checks; last output: %s", in.FailingStreak, in.HealthLog))
				}
			}
			for _, svc := range st.Services {
				if svc.Running < svc.Desired {
					findings = append(findings, finding{Service: svc.Name, Problem: "missing_containers",
						Detail: fmt.Sprintf("%d of %d containers run", svc.Running, svc.Desired)})
				}
			}
			// low in absolute terms, or a small share of a small disk: 12 GiB free of 250 is room
			if st.DiskTotal > 0 && (st.DiskFree < 2<<30 || (st.DiskFree*20 < st.DiskTotal && st.DiskFree < 10<<30)) {
				findings = append(findings, finding{Problem: "disk_space",
					Detail: fmt.Sprintf("%s free of %s; `dockflow prune` removes unused images", humanBytes(st.DiskFree), humanBytes(st.DiskTotal))})
			}
			a.printResult(map[string]any{"findings": findings, "disk_free": st.DiskFree, "disk_total": st.DiskTotal}, func(w io.Writer) {
				if len(findings) == 0 {
					fmt.Fprintf(w, "No problem found: every service runs its containers (%s free on disk).\n", humanBytes(st.DiskFree))
					return
				}
				for _, f := range findings {
					who := f.Container
					if who == "" {
						who = f.Service
					}
					if who == "" {
						who = "server"
					}
					fmt.Fprintf(w, "✗ %s: %s: %s\n", who, strings.ReplaceAll(f.Problem, "_", " "), f.Detail)
				}
			})
			if len(findings) > 0 {
				return &errs.Error{Code: "diagnose.findings", Exit: errs.ExitDegraded, Message: fmt.Sprintf("%d problems", len(findings)), Reported: true}
			}
			return nil
		},
	}
}

// releaseStats summarises a release history.
type releaseStats struct {
	Releases    int     `json:"releases"`
	Succeeded   int     `json:"succeeded"`
	Failed      int     `json:"failed"`
	SuccessRate float64 `json:"success_rate"`
	AvgSeconds  float64 `json:"average_duration_seconds"`
	MaxSeconds  float64 `json:"longest_duration_seconds"`
}

func stats(list []agent.ReleaseSummary) releaseStats {
	st := releaseStats{Releases: len(list)}
	var total float64
	n := 0
	for _, r := range list {
		switch r.Status {
		case domain.StatusActive, domain.StatusSuperseded:
			st.Succeeded++
		case domain.StatusFailed, domain.StatusRolledBack, domain.StatusAbandoned:
			st.Failed++
		}
		start, err1 := time.Parse(time.RFC3339, r.CreatedAt)
		end, err2 := time.Parse(time.RFC3339, r.FinishedAt)
		if err1 == nil && err2 == nil {
			d := end.Sub(start).Seconds()
			total += d
			n++
			if d > st.MaxSeconds {
				st.MaxSeconds = d
			}
		}
	}
	if done := st.Succeeded + st.Failed; done > 0 {
		st.SuccessRate = float64(st.Succeeded) / float64(done)
	}
	if n > 0 {
		st.AvgSeconds = total / float64(n)
	}
	return st
}

func renderStats(w io.Writer, st releaseStats) {
	fmt.Fprintf(w, "\n%d releases: %d succeeded, %d failed (%.0f%% success), %.0fs on average, %.0fs at most\n",
		st.Releases, st.Succeeded, st.Failed, st.SuccessRate*100, st.AvgSeconds, st.MaxSeconds)
}

// imagesOf lists the images of the server that belong to app, or all of them.
func imagesOf(imgs []engine.Image, app string, all bool) []engine.Image {
	if all {
		return imgs
	}
	var out []engine.Image
	for _, img := range imgs {
		for _, ref := range append(append([]string(nil), img.Tags...), img.Digests...) {
			if strings.HasPrefix(ref, agent.RegistryAddr+"/"+app+"/") || strings.Contains(ref, "/"+app+"/") {
				out = append(out, img)
				break
			}
		}
	}
	return out
}

func renderImages(w io.Writer, imgs []engine.Image) {
	sort.Slice(imgs, func(i, j int) bool { return imgs[i].Created > imgs[j].Created })
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "IMAGE\tID\tSIZE\tCREATED")
	for _, img := range imgs {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", imageLabel(img), shortID(img.ID), humanBytes(uint64(img.Size)), time.Unix(img.Created, 0).UTC().Format("2006-01-02 15:04"))
	}
	tw.Flush()
}

func imageLabel(img engine.Image) string {
	if len(img.Tags) > 0 {
		return img.Tags[0]
	}
	if len(img.Digests) > 0 {
		return img.Digests[0]
	}
	return "<none>"
}

func shortID(id string) string {
	id = strings.TrimPrefix(id, "sha256:")
	if len(id) > 12 {
		return id[:12]
	}
	return id
}
