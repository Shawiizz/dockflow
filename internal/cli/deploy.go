package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/launcher"
)

var timeNow = time.Now

func (a *app) planCmd() *cobra.Command {
	var render, noBuild bool
	cmd := &cobra.Command{
		Use:   "plan [<env>]",
		Short: "Print what a deploy would change",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := a.connect(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			defer s.Close()
			a.warnings(s)
			if !noBuild {
				if err := s.ship(cmd.Context(), nil); err != nil {
					return err
				}
			}
			req := s.request(agent.OpPlan)
			req.Desired = &s.loaded.App
			if _, err = s.runAgent(cmd.Context(), req); err != nil {
				return err
			}
			if render {
				// the services as they will be sent to the server, before images are pinned
				b, _ := json.MarshalIndent(s.loaded.App.Services, "", "  ")
				fmt.Fprintln(a.stdout, a.mask(string(b)))
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&render, "render", false, "also print the service specs that would be sent")
	cmd.Flags().BoolVar(&noBuild, "no-build", false, "plan without building: built services show as changed")
	return cmd
}

func (a *app) warnings(s *session) {
	for _, w := range s.loaded.Warnings {
		a.emitter.Warn(events.Warning, w, map[string]any{"code": "compose.warning", "detail": w})
	}
}

func (a *app) deployCmd() *cobra.Command {
	var versionFlag string
	var noRollback, force bool
	var waitLock time.Duration
	cmd := &cobra.Command{
		Use:   "deploy [<env>]",
		Short: "Plan, confirm and apply",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			env := envArg(args)
			if env == "" {
				var err error
				if env, err = a.envFromTag(); err != nil {
					return err
				}
			}
			s, err := a.connect(cmd.Context(), env, versionFlag)
			if err != nil {
				return err
			}
			defer s.Close()
			a.warnings(s)
			ctx := cmd.Context()
			if err := s.ship(ctx, nil); err != nil {
				return err
			}
			fingerprint := ""
			if a.interactive() {
				// show the plan, then apply exactly that plan once confirmed
				planReq := s.request(agent.OpPlan)
				planReq.Desired = &s.loaded.App
				res, err := s.runAgent(ctx, planReq)
				if err != nil {
					return err
				}
				if res.Plan == nil {
					return nil
				}
				fingerprint = res.Plan.Fingerprint
				if !a.confirm(fmt.Sprintf("Deploy %s to %s?", s.loaded.Version, s.loaded.Config.Env)) {
					return errs.New("run.declined", errs.ExitInterrupted, "nothing was changed")
				}
				s.run = launcher.NewRunID(timeNow())
			}
			req := s.request(agent.OpDeploy)
			req.Desired = &s.loaded.App
			req.Fingerprint = fingerprint
			req.NoRollback = noRollback
			req.Force = force
			req.WaitLock = domain.Duration(waitLock)
			_, err = s.runAgent(ctx, req)
			return err
		},
	}
	f := cmd.Flags()
	f.StringVar(&versionFlag, "version", "", "the version label of the release (default: the git commit)")
	f.BoolVar(&noRollback, "no-rollback", false, "leave a failed deploy in place instead of rolling back")
	f.BoolVar(&force, "force", false, "deploy despite a manual lock")
	f.DurationVar(&waitLock, "wait-lock", 0, "wait up to this long for another run's lock instead of failing")
	return cmd
}

// interactive tells whether a command may show a plan and ask before changing a server.
func (a *app) interactive() bool {
	return !a.yes && !a.json && isTerminal(a.stdin) && isTerminal(os.Stdout)
}

func (a *app) rollbackCmd() *cobra.Command {
	var to string
	cmd := &cobra.Command{
		Use:   "rollback [<env>]",
		Short: "Re-apply a recorded release, by default the previous one",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := a.connect(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			defer s.Close()
			req := s.request(agent.OpRollback)
			if to != "" {
				seq, err := strconv.Atoi(to)
				if err != nil || seq < 1 {
					return errs.Usage("--to takes a release number, not %q", to)
				}
				req.Target = seq
			}
			_, err = s.runAgent(cmd.Context(), req)
			return err
		},
	}
	cmd.Flags().StringVar(&to, "to", "", "the release to restore (see `dockflow releases`)")
	return cmd
}

func (a *app) attachCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "attach [<env>] [<run-id>]",
		Short: "Follow a run in progress, or replay a finished one",
		Args:  cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := a.connect(cmd.Context(), envArg(args), "")
			if err != nil {
				return err
			}
			defer s.Close()
			run := ""
			if len(args) > 1 {
				run = args[1]
			} else if run, err = s.launcher.LastRun(cmd.Context(), domain.Stack(s.loaded.Config.App, s.loaded.Config.Env)); err != nil {
				return err
			} else if run == "" {
				return errs.Usage("no run of %s on this server", s.loaded.Config.Env)
			}
			res, err := s.launcher.Attach(cmd.Context(), run)
			if err != nil {
				return err
			}
			if !a.json {
				a.human.finish(res.RunFinishedData)
			}
			if res.ExitCode != 0 {
				return &errs.Error{Code: errCode(res.Error), Exit: res.ExitCode, Message: errMessage(res.Error), Hint: errHint(res.Error), Reported: true}
			}
			return nil
		},
	}
}
