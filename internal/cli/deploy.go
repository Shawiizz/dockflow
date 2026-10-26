package cli

import (
	"context"
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
	var only []string
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
			if err := checkOnly(s, only); err != nil {
				return err
			}
			if !noBuild {
				if err := s.deliver(cmd.Context(), only, false); err != nil {
					return err
				}
			}
			if err := s.prepareUploads(); err != nil {
				return err
			}
			req := s.request(agent.OpPlan)
			req.Desired = &s.loaded.App
			req.Only = only
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
	cmd.Flags().StringSliceVar(&only, "only", nil, "plan these services only: the others stay as the current release has them")
	return cmd
}

func (a *app) warnings(s *session) {
	for _, w := range s.loaded.Warnings {
		a.emitter.Warn(events.Warning, w, map[string]any{"code": "compose.warning", "detail": w})
	}
}

func (a *app) deployCmd() *cobra.Command {
	var versionFlag string
	var noRollback, force, skipBuild bool
	var waitLock time.Duration
	var only []string
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
			if err := checkOnly(s, only); err != nil {
				return err
			}
			hookList, err := s.hooks()
			if err != nil {
				return err
			}
			hk := s.hookRunner()
			// with --skip-build nothing is built: the build hooks do not run either
			if !skipBuild {
				if err := hk.Run(ctx, domain.HookBeforeBuild, hookList); err != nil {
					return err
				}
			}
			if err := s.deliver(ctx, only, skipBuild); err != nil {
				return err
			}
			if !skipBuild {
				if err := hk.Run(ctx, domain.HookAfterBuild, hookList); err != nil {
					return err
				}
			}
			if err := s.prepareUploads(); err != nil {
				return err
			}
			// local and host hooks run here, around the agent's run, which must not depend on
			// this connection (ADR-0022)
			if err := hk.Run(ctx, domain.HookBeforeDeploy, hookList); err != nil {
				return err
			}
			fingerprint := ""
			if a.interactive() {
				// show the plan, then apply exactly that plan once confirmed
				planReq := s.request(agent.OpPlan)
				planReq.Desired = &s.loaded.App
				planReq.Only = only
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
			req.Only = only
			req.Fingerprint = fingerprint
			req.NoRollback = noRollback
			req.Force = force
			req.WaitLock = domain.Duration(waitLock)
			req.Hooks = execHooks(hookList)
			if err := s.sendUploads(ctx, &req); err != nil {
				return err
			}
			res, err := s.runAgent(ctx, req)
			if err != nil {
				if res != nil && res.ExitCode != errs.ExitLocked {
					if herr := hk.Run(context.WithoutCancel(ctx), domain.HookAfterFailure, hookList); herr != nil {
						a.emitter.Warn(events.Warning, herr.Error(), map[string]any{"code": "hook.failed"})
					}
				}
				return err
			}
			if res.ReleaseSeq == 0 {
				return nil
			}
			if herr := hk.Run(ctx, domain.HookAfterDeploy, hookList); herr != nil {
				// the release is committed: a fatal after_deploy hook restores the previous one
				a.emitter.Warn(events.RollbackStarted, herr.Error()+": rolling back", map[string]any{"reason": herr.Error()})
				s.run = launcher.NewRunID(timeNow())
				back := s.request(agent.OpRollback)
				if _, rerr := s.runAgent(ctx, back); rerr != nil {
					return rerr
				}
				return herr
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&versionFlag, "version", "", "the version label of the release (default: the git commit)")
	f.BoolVar(&noRollback, "no-rollback", false, "leave a failed deploy in place instead of rolling back")
	f.BoolVar(&force, "force", false, "deploy despite a manual lock")
	f.DurationVar(&waitLock, "wait-lock", 0, "wait up to this long for another run's lock instead of failing")
	f.StringSliceVar(&only, "only", nil, "deploy these services only: the others stay as the current release has them")
	f.BoolVar(&skipBuild, "skip-build", false, "use the images `dockflow build --push` pushed for this version instead of building")
	return cmd
}

// checkOnly refuses an --only that names a service the app does not have, before anything is
// built.
func checkOnly(s *session, only []string) error {
	for _, name := range only {
		if _, ok := s.loaded.App.Service(name); !ok {
			return errs.Usage("--only: no service %s in compose.yml", name)
		}
	}
	return nil
}

// interactive tells whether a command may show a plan and ask before changing a server.
func (a *app) interactive() bool {
	return !a.yes && !a.json && isTerminal(a.stdin) && isTerminal(os.Stdout)
}

func (a *app) rollbackCmd() *cobra.Command {
	var to, service string
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
				// a number is a release; anything else, a version label
				if seq, err := strconv.Atoi(to); err == nil {
					if seq < 1 {
						return errs.Usage("--to takes a release number or a version, not %q", to)
					}
					req.Target = seq
				} else {
					req.TargetVersion = to
				}
			}
			if service != "" {
				req.Services = []string{service}
			}
			_, err = s.runAgent(cmd.Context(), req)
			return err
		},
	}
	cmd.Flags().StringVar(&to, "to", "", "the release to restore: its number in dockflow releases, or a version (the newest release of it)")
	cmd.Flags().StringVar(&service, "service", "", "restore this service only, as the release has it; the others stay as they are")
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
