package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"sync"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// appContainers lists the containers of the session's app: services, and with all, stopped ones
// and one-off containers too.
func (s *session) appContainers(ctx context.Context, all bool) ([]engine.Container, error) {
	stack := domain.Stack(s.loaded.Config.App, s.loaded.Config.Env)
	cs, err := s.engine.Containers(ctx, engine.Filter{All: all, Labels: map[string]string{domain.LabelProject: stack}})
	if err != nil {
		return nil, err
	}
	var out []engine.Container
	for _, c := range cs {
		kind := c.Labels[domain.LabelKind]
		if kind == domain.KindRun {
			continue
		}
		if !all && kind != domain.KindService {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

// serving keeps, per service, the containers of its newest running release.
func serving(cs []engine.Container) []engine.Container {
	newest := map[string]int{}
	for _, c := range cs {
		if c.State == "running" && c.Release > newest[c.Service] {
			newest[c.Service] = c.Release
		}
	}
	var out []engine.Container
	for _, c := range cs {
		if c.Labels[domain.LabelKind] == domain.KindService && c.Release == newest[c.Service] {
			out = append(out, c)
		}
	}
	return out
}

func (a *app) psCmd() *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "ps [<env>]",
		Short: "The app's containers",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			a.quiet()
			s, err := a.connect(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			defer s.Close()
			cs, err := s.appContainers(cmd.Context(), all)
			if err != nil {
				return err
			}
			type row struct {
				Name    string `json:"name"`
				Service string `json:"service"`
				Kind    string `json:"kind"`
				Release int    `json:"release"`
				State   string `json:"state"`
				Health  string `json:"health,omitempty"`
				Image   string `json:"image"`
			}
			rows := []row{}
			for _, c := range cs {
				rows = append(rows, row{c.Name, c.Service, c.Labels[domain.LabelKind], c.Release, c.State, c.Health, c.Image})
			}
			a.printResult(rows, func(w io.Writer) {
				tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
				fmt.Fprintln(tw, "NAME\tSERVICE\tRELEASE\tSTATE\tHEALTH")
				for _, r := range rows {
					fmt.Fprintf(tw, "%s\t%s\t%d\t%s\t%s\n", r.Name, r.Service, r.Release, r.State, r.Health)
				}
				tw.Flush()
			})
			return nil
		},
	}
	cmd.Flags().BoolVarP(&all, "all", "a", false, "include stopped containers and one-off ones")
	return cmd
}

// pick asks which container to use, on a terminal.
func (a *app) pick(cs []engine.Container) (engine.Container, error) {
	if len(cs) == 1 {
		return cs[0], nil
	}
	if !a.interactive() {
		return engine.Container{}, errs.Usage("%d containers match; --pick needs a terminal", len(cs))
	}
	for i, c := range cs {
		fmt.Fprintf(a.stdout, "  %d) %s (%s)\n", i+1, c.Name, c.State)
	}
	fmt.Fprintf(a.stdout, "Which one? [1-%d] ", len(cs))
	var answer string
	fmt.Fscanln(a.stdin, &answer)
	n, err := strconv.Atoi(strings.TrimSpace(answer))
	if err != nil || n < 1 || n > len(cs) {
		return engine.Container{}, errs.Usage("no container %q", answer)
	}
	return cs[n-1], nil
}

func (a *app) logsCmd() *cobra.Command {
	var follow, timestamps, all, pickOne, noPrefix bool
	var tail, since string
	cmd := &cobra.Command{
		Use:   "logs [<env>] [<service>]",
		Short: "Service logs",
		Args:  cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			a.quiet()
			ctx := cmd.Context()
			s, err := a.connect(ctx, envArg(args), "")
			if err != nil {
				return err
			}
			defer s.Close()
			cs, err := s.appContainers(ctx, all)
			if err != nil {
				return err
			}
			if !all {
				cs = serving(cs)
			}
			if len(args) > 1 {
				service := args[1]
				if _, ok := s.loaded.App.Service(service); !ok {
					return errs.Usage("no service %s in %s", service, s.loaded.Config.Env)
				}
				var only []engine.Container
				for _, c := range cs {
					if c.Service == service {
						only = append(only, c)
					}
				}
				cs = only
			}
			if len(cs) == 0 {
				return errs.Usage("no container to show the logs of")
			}
			if pickOne {
				c, err := a.pick(cs)
				if err != nil {
					return err
				}
				cs = []engine.Container{c}
			}
			if tail == "" {
				tail = "100"
				if follow {
					tail = "20"
				}
			}
			return a.streamLogs(ctx, s, cs, engine.LogOptions{Follow: follow, Stderr: true, Tail: tail, Since: since, Timestamps: timestamps}, !noPrefix && len(cs) > 1)
		},
	}
	f := cmd.Flags()
	f.BoolVarP(&follow, "follow", "f", false, "keep following the logs")
	f.StringVarP(&tail, "lines", "n", "", "lines per container from the end, or all (default 100, 20 with -f)")
	f.StringVar(&since, "since", "", "only logs since a timestamp (2026-10-26T14:00:00Z) or a duration (10m)")
	f.BoolVar(&timestamps, "timestamps", false, "show timestamps")
	f.BoolVar(&all, "all", false, "include the previous release's and stopped containers")
	f.BoolVar(&pickOne, "pick", false, "choose one container")
	f.BoolVar(&noPrefix, "no-prefix", false, "no container prefix on each line")
	return cmd
}

// streamLogs prints the containers' logs, line by line, with secrets masked.
func (a *app) streamLogs(ctx context.Context, s *session, cs []engine.Container, o engine.LogOptions, prefix bool) error {
	sort.Slice(cs, func(i, j int) bool { return cs[i].Name < cs[j].Name })
	var mu sync.Mutex
	var wg sync.WaitGroup
	errc := make(chan error, len(cs))
	for _, c := range cs {
		r, err := s.engine.Logs(ctx, c.ID, o)
		if err != nil {
			return err
		}
		label := c.Service + "-" + c.Labels[domain.LabelNumber]
		if c.Labels[domain.LabelKind] != domain.KindService {
			label = c.Name
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer r.Close()
			sc := bufio.NewScanner(r)
			sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
			for sc.Scan() {
				line := a.mask(sc.Text())
				mu.Lock()
				switch {
				case a.json:
					b, _ := json.Marshal(map[string]string{"container": c.Name, "service": c.Service, "line": line})
					fmt.Fprintln(a.stdout, string(b))
				case prefix:
					fmt.Fprintf(a.stdout, "%s | %s\n", label, line)
				default:
					fmt.Fprintln(a.stdout, line)
				}
				mu.Unlock()
			}
			if err := sc.Err(); err != nil && ctx.Err() == nil {
				errc <- err
			}
		}()
	}
	wg.Wait()
	close(errc)
	if ctx.Err() != nil {
		return nil
	}
	if err := <-errc; err != nil {
		return errs.Connect("the logs stream was cut").WithCause(err)
	}
	return nil
}
