// Package cli is the dockflow command line (docs/design/spec/cli-v1.md).
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/launcher"
)

// app holds the global options and the output of one invocation.
type app struct {
	dir        string
	json       bool
	verbose    bool
	noColor    bool
	yes        bool
	connection string
	// branch replaces the branch git or the CI reports (deploy --branch).
	branch string

	stdout, stderr io.Writer
	stdin          *os.File
	emitter        *events.Emitter
	human          *human
	interrupts     chan struct{}
	// agentRunning routes Ctrl+C to the agent (rollback, then detach) instead of cancelling.
	agentRunning atomic.Bool
}

// Main runs the command line and returns the exit code.
func Main(args []string) int {
	a := &app{stdout: os.Stdout, stderr: os.Stderr, stdin: os.Stdin, interrupts: make(chan struct{}, 2)}
	root := a.root()
	root.SetArgs(args)

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	go func() {
		for range sigs {
			if !a.agentRunning.Load() {
				stop()
				continue
			}
			select {
			case a.interrupts <- struct{}{}:
			default:
			}
		}
	}()

	err := root.ExecuteContext(ctx)
	if err == nil {
		return errs.ExitOK
	}
	var e *errs.Error
	if errors.As(err, &e) && e.Code == "command.exit" {
		return e.Exit
	}
	if !errors.As(err, &e) {
		// cobra's own errors: unknown command, bad flag
		fmt.Fprintf(a.stderr, "error: %v\n", err)
		return errs.ExitUsage
	}
	a.report(e)
	return e.Exit
}

func (a *app) report(e *errs.Error) {
	if a.json {
		if e.Reported {
			return
		}
		b, _ := json.Marshal(map[string]any{"error": events.ErrorData{Code: e.Code, Message: a.mask(e.Error()), Hint: e.Hint}, "exit_code": e.Exit})
		fmt.Fprintln(a.stdout, string(b))
		return
	}
	fmt.Fprintf(a.stderr, "error: %s\n", a.mask(e.Error()))
	if e.Hint != "" {
		fmt.Fprintf(a.stderr, "hint: %s\n", a.mask(e.Hint))
	}
}

func (a *app) mask(s string) string {
	if a.emitter == nil {
		return s
	}
	return a.emitter.Masker().Mask(s)
}

func (a *app) root() *cobra.Command {
	root := &cobra.Command{
		Use:           "dockflow",
		Short:         "Deploy Docker Compose apps to your own servers, with zero downtime",
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRun: func(cmd *cobra.Command, _ []string) {
			a.setup()
		},
	}
	f := root.PersistentFlags()
	f.StringVarP(&a.dir, "dir", "C", ".", "the project directory")
	f.BoolVar(&a.json, "json", false, "machine-readable output")
	f.BoolVarP(&a.verbose, "verbose", "v", false, "show debug events")
	f.BoolVar(&a.noColor, "no-color", false, "no colours")
	f.BoolVarP(&a.yes, "yes", "y", false, "never prompt")
	f.StringVar(&a.connection, "connection", "", "use this connection string instead of the environment's secret")
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return errs.Usage("%v", err) })

	root.AddCommand(
		a.buildCmd(), a.planCmd(), a.deployCmd(), a.rollbackCmd(), a.attachCmd(), a.psCmd(), a.logsCmd(),
		a.execCmd(), a.runCmd(), a.cpCmd(), a.sshCmd(),
		a.restartCmd(), a.stopCmd(), a.scaleCmd(), a.destroyCmd(), a.pruneCmd(), a.cancelCmd(),
		a.detailsCmd(), a.diagnoseCmd(),
		a.statusCmd(), a.releasesCmd(), a.versionCmd(), a.lockCmd(),
		a.validateCmd(), a.configCmd(), a.listCmd(), a.serverCmd(), a.agentCmd(), a.uploadHelperCmd(), a.secretsCmd(), a.filterCmd(), a.pluginsCmd(),
	)
	root.CompletionOptions.HiddenDefaultCmd = false
	return root
}

func (a *app) setup() {
	if a.emitter != nil {
		return
	}
	a.human = &human{w: a.stdout, verbose: a.verbose, color: !a.noColor && isTerminal(os.Stdout) && os.Getenv("NO_COLOR") == ""}
	var sink events.Sink = a.human
	if a.json {
		sink = events.NewJSONSink(a.stdout)
	}
	a.emitter = events.NewEmitter(launcher.NewRunID(timeNow()), sink, nil)
}

func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

// confirm asks a yes/no question on a terminal; without one, or with --yes, it answers yes.
func (a *app) confirm(question string) bool {
	if !a.interactive() {
		return true
	}
	fmt.Fprintf(a.stdout, "%s [y/N] ", question)
	var answer string
	fmt.Fscanln(a.stdin, &answer)
	return answer == "y" || answer == "Y" || answer == "yes"
}

// printResult prints a read command's document: JSON with --json, or through render.
func (a *app) printResult(v any, render func(io.Writer)) {
	if a.json {
		b, _ := json.MarshalIndent(v, "", "  ")
		fmt.Fprintln(a.stdout, a.mask(string(b)))
		return
	}
	render(a.stdout)
}

// envArg returns the optional <env> argument.
func envArg(args []string) string {
	if len(args) > 0 {
		return args[0]
	}
	return ""
}
