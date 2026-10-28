package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// backupCmd is `dockflow backup` (ADR-0015).
func (a *app) backupCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "backup", Short: "Back up the stateful services with restic, and list their snapshots"}
	var waitLock time.Duration
	var server bool
	run := &cobra.Command{
		Use:   "run [<env>] [<service>]",
		Short: "Back up the services that declare x-dockflow.backup, or one of them, or the server's state",
		Long: "Backs up the services of the current release that declare x-dockflow.backup, or the one given. " +
			"--server backs up the server's state instead, /var/lib/dockflow, to the environment's repository.",
		Args: cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			env, service, err := a.envAndServer(args, server)
			if err != nil {
				return err
			}
			s, err := a.attach(cmd.Context(), env)
			if err != nil {
				return err
			}
			defer s.Close()
			req := s.request(agent.OpBackupRun)
			req.Backup = s.backupRequest(service)
			req.Backup.Server = server
			req.WaitLock = domain.Duration(waitLock)
			_, err = s.runAgent(cmd.Context(), req)
			return err
		},
	}
	run.Flags().DurationVar(&waitLock, "wait-lock", 0, "wait up to this long for a deploy or another run to release the lock, such as 10m")
	run.Flags().BoolVar(&server, "server", false, "back up the server's state, /var/lib/dockflow")
	cmd.AddCommand(run)
	var listServer bool
	list := &cobra.Command{
		Use:   "list [<env>] [<service>]",
		Short: "The environment's snapshots, or the server's with --server, oldest first",
		Args:  cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			env, service, err := a.envAndServer(args, listServer)
			if err != nil {
				return err
			}
			var out struct {
				Snapshots []agent.Snapshot `json:"snapshots"`
			}
			a.quiet()
			s, err := a.attach(cmd.Context(), env)
			if err != nil {
				return err
			}
			defer s.Close()
			req := s.request(agent.OpBackupList)
			req.Backup = s.backupRequest(service)
			req.Backup.Server = listServer
			res, err := s.runAgent(cmd.Context(), req)
			if err != nil {
				if e, ok := errs.As(err); ok {
					// quiet: the event that reported it was not shown
					e.Reported = false
				}
				return err
			}
			if len(res.Results) == 0 {
				return errs.Internal("the agent returned no result")
			}
			if err := json.Unmarshal(res.Results[len(res.Results)-1], &out); err != nil {
				return errs.Internal("cannot read the agent's result: %v", err)
			}
			a.printResult(out, func(w io.Writer) {
				if len(out.Snapshots) == 0 {
					fmt.Fprintln(w, "no snapshot yet: dockflow backup run makes one")
					return
				}
				tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
				fmt.Fprintln(tw, "SNAPSHOT\tTIME\tSERVICE\tRELEASE\tSIZE")
				for _, sn := range out.Snapshots {
					size, what, release := "", sn.Service, strconv.Itoa(sn.Release)
					if sn.Size > 0 {
						size = humanBytes(uint64(sn.Size))
					}
					if sn.Server != "" {
						what, release = "server "+sn.Server, ""
					}
					fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", sn.ID, sn.Time.UTC().Format("2006-01-02 15:04:05Z"), what, release, size)
				}
				tw.Flush()
			})
			return nil
		},
	}
	list.Flags().BoolVar(&listServer, "server", false, "list the snapshots of the server's state")
	cmd.AddCommand(list)
	cmd.AddCommand(a.backupRestoreCmd(), a.backupPruneCmd())
	return cmd
}

func (a *app) backupRestoreCmd() *cobra.Command {
	var snapshot, from string
	var waitLock time.Duration
	cmd := &cobra.Command{
		Use:   "restore [<env>] <service>",
		Short: "Restore a snapshot of a service, of this environment or another, into what runs now",
		Long: "Restores the latest snapshot of the service, or --snapshot (an id, latest, or a date like 2026-10-27 for the newest " +
			"snapshot taken by then), into the service of the current release, under the environment's lock. A dump is restored " +
			"with the strictest options, so that the first error stops it; volumes are restored with the service stopped, and " +
			"lose the files the snapshot does not have. --from restores another environment's snapshot, read from its repository.",
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			env, service, err := a.envAndService(args)
			if err != nil {
				return err
			}
			s, err := a.attach(cmd.Context(), env)
			if err != nil {
				return err
			}
			defer s.Close()
			req := s.request(agent.OpBackupRestore)
			req.Backup = s.backupRequest(service)
			req.Backup.Snapshot, req.WaitLock = snapshot, domain.Duration(waitLock)
			if from != "" {
				// the other environment's repository and secrets
				fl, err := a.loadProject(cmd.Context(), from, "", true)
				if err != nil {
					return err
				}
				req.Backup.From = fl.Config.Env
				req.Backup.Repository, req.Backup.Password, req.Backup.Env = "", "", nil
				if c := fl.Config.Backups; c != nil {
					req.Backup.Repository, req.Backup.Password, req.Backup.Env = c.Repository, c.Password, c.Env
				}
			}
			what := fmt.Sprintf("%s of %s with the %s snapshot", service, s.loaded.Config.Env, describeSnapshot(snapshot))
			if req.Backup.From != "" {
				what += " of " + req.Backup.From
			}
			switch {
			case a.interactive():
				if !a.confirm("Replace the data of " + what + "?") {
					return errs.New("run.declined", errs.ExitInterrupted, "nothing was changed")
				}
			case !a.yes:
				return errs.Usage("backup restore replaces data: confirm with --yes when there is no terminal")
			}
			_, err = s.runAgent(cmd.Context(), req)
			return err
		},
	}
	cmd.Flags().StringVar(&snapshot, "snapshot", "", "the snapshot: an id, latest, or a date or time (default latest)")
	cmd.Flags().StringVar(&from, "from", "", "restore a snapshot of this environment, like production into staging")
	cmd.Flags().DurationVar(&waitLock, "wait-lock", 0, "wait up to this long for the environment's lock")
	return cmd
}

func describeSnapshot(s string) string {
	switch s {
	case "", "latest":
		return "latest"
	}
	return s
}

func (a *app) backupPruneCmd() *cobra.Command {
	var keep domain.Keep
	var server bool
	cmd := &cobra.Command{
		Use:   "prune [<env>] [<service>]",
		Short: "Apply the services' retention, or the one given, and reclaim the space of the forgotten snapshots",
		Args:  cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			env, service, err := a.envAndServer(args, server)
			if err != nil {
				return err
			}
			s, err := a.attach(cmd.Context(), env)
			if err != nil {
				return err
			}
			defer s.Close()
			req := s.request(agent.OpBackupPrune)
			req.Backup = s.backupRequest(service)
			req.Backup.Server = server
			if !keep.Empty() {
				k := keep
				req.Backup.Keep = &k
			}
			_, err = s.runAgent(cmd.Context(), req)
			return err
		},
	}
	f := cmd.Flags()
	f.BoolVar(&server, "server", false, "prune the snapshots of the server's state")
	f.IntVar(&keep.Last, "keep-last", 0, "keep the n most recent snapshots")
	f.IntVar(&keep.Hourly, "keep-hourly", 0, "keep the most recent snapshot of the n last hours that have one")
	f.IntVar(&keep.Daily, "keep-daily", 0, "keep the most recent snapshot of the n last days that have one")
	f.IntVar(&keep.Weekly, "keep-weekly", 0, "keep the most recent snapshot of the n last weeks that have one")
	f.IntVar(&keep.Monthly, "keep-monthly", 0, "keep the most recent snapshot of the n last months that have one")
	return cmd
}

// envAndService reads [<env>] [<service>].
func (a *app) envAndService(args []string) (string, string, error) {
	env, rest := a.envAndServices(args)
	switch len(rest) {
	case 0:
		return env, "", nil
	case 1:
		return env, rest[0], nil
	}
	return "", "", errs.Usage("give at most one service")
}

// envAndServer reads [<env>] [<service>], with no service when server is set.
func (a *app) envAndServer(args []string, server bool) (string, string, error) {
	env, service, err := a.envAndService(args)
	if err == nil && server && service != "" {
		return "", "", errs.Usage("--server backs up the server's state, not a service: give no service")
	}
	return env, service, err
}

// backupRequest is where the environment's backups go, from dockflow.yml.
func (s *session) backupRequest(service string) *agent.BackupRequest {
	b := &agent.BackupRequest{Service: service}
	if c := s.loaded.Config.Backups; c != nil {
		b.Repository, b.Password, b.Env = c.Repository, c.Password, c.Env
	}
	return b
}
