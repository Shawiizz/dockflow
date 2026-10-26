package cli

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/engine/docker"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/proxy/caddy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// agentCmd is the agent's entry point, inside its container on the server (ADR-0004). It reads
// one request on stdin and writes events on stdout.
func (a *app) agentCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "agent",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			input, err := io.ReadAll(io.LimitReader(a.stdin, 256<<20))
			if err != nil {
				return errs.Internal("read the request: %v", err)
			}
			var req agent.Request
			if err := json.Unmarshal(input, &req); err != nil {
				return errs.Internal("the request is not valid JSON: %v", err)
			}
			ev := events.NewEmitter(req.Run, events.NewJSONSink(os.Stdout), events.NewMasker(req.Mask...))

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sigs := make(chan os.Signal, 1)
			signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
			go func() {
				<-sigs
				cancel()
			}()

			eng, err := docker.New(nil)
			if err != nil {
				return finishWith(ev, err)
			}
			defer eng.Close()
			store, err := state.Open(state.Root, req.Run)
			if err != nil {
				return finishWith(ev, err)
			}
			res := agent.Run(ctx, agent.Deps{
				Engine: eng, Store: store, Events: ev,
				Switch: caddy.New(caddy.Dir),
			}, req)
			if res.ExitCode != 0 {
				return &errs.Error{Code: "run.failed", Exit: res.ExitCode, Message: "run failed", Reported: true}
			}
			return nil
		},
	}
}

func finishWith(ev *events.Emitter, err error) error {
	e, ok := errs.As(err)
	exit := errs.ExitCode(err)
	data := events.RunFinishedData{Outcome: events.OutcomeFailed, ExitCode: exit}
	if ok {
		data.Error = &events.ErrorData{Code: e.Code, Message: e.Error(), Hint: e.Hint}
	}
	ev.Errorf(events.RunFinished, err.Error(), data)
	return &errs.Error{Code: "run.failed", Exit: exit, Message: err.Error(), Reported: true}
}
