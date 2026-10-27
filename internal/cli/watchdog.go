package cli

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/engine/docker"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/state"
)

// watchdogCmd is the watchdog's entry point in its container (ADR-0010): it runs until stopped,
// and writes events on stdout, which `docker logs dockflow-watchdog` shows.
func (a *app) watchdogCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "watchdog",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ev := events.NewEmitter("watchdog", events.NewJSONSink(os.Stdout), events.NewMasker())
			ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			defer cancel()
			eng, err := docker.New(nil)
			if err != nil {
				return err
			}
			defer eng.Close()
			store, err := state.Open(state.Root, "watchdog")
			if err != nil {
				return err
			}
			w := &agent.Watchdog{Engine: eng, Store: store, Events: ev}
			w.Run(ctx, agent.WatchdogInterval)
			return nil
		},
	}
}
