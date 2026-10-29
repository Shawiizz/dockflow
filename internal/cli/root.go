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
	"strings"
	"sync/atomic"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/connection"
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
	// connectionRead is set once connection holds the string itself, read from where
	// --connection pointed (readConnection).
	connectionRead bool
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

	return a.exitCode(root.ExecuteContext(ctx))
}

// exitCode reports err and returns the exit code it maps to.
func (a *app) exitCode(err error) int {
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
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			a.setup()
			if a.connection == "-" && cmd.Name() == "mcp" {
				return errs.Usage("--connection - cannot be used with mcp, whose standard input is the client's").
					WithHint("use --connection @<file>, or the <ENV>_CONNECTION variable")
			}
			return a.readConnection()
		},
	}
	f := root.PersistentFlags()
	f.StringVarP(&a.dir, "dir", "C", ".", "the project directory")
	f.BoolVar(&a.json, "json", false, "machine-readable output")
	f.BoolVarP(&a.verbose, "verbose", "v", false, "show debug events")
	f.BoolVar(&a.noColor, "no-color", false, "no colours")
	f.BoolVarP(&a.yes, "yes", "y", false, "never prompt")
	f.StringVar(&a.connection, "connection", "", "use this connection string instead of the environment's secret: @<file> reads it from a file, - from the first line of standard input")
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return errs.Usage("%v", err) })

	root.AddCommand(
		a.buildCmd(), a.planCmd(), a.deployCmd(), a.rollbackCmd(), a.attachCmd(), a.psCmd(), a.logsCmd(),
		a.execCmd(), a.runCmd(), a.cpCmd(), a.sshCmd(),
		a.restartCmd(), a.stopCmd(), a.scaleCmd(), a.destroyCmd(), a.pruneCmd(), a.cancelCmd(),
		a.detailsCmd(), a.diagnoseCmd(),
		a.statusCmd(), a.releasesCmd(), a.versionCmd(), a.lockCmd(), a.backupCmd(),
		a.initCmd(), a.validateCmd(), a.configCmd(), a.listCmd(), a.serverCmd(), a.agentCmd(), a.uploadHelperCmd(), a.secretsCmd(), a.filterCmd(), a.pluginsCmd(), a.watchdogCmd(), a.probeCmd(), a.mcpCmd(),
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

// readConnection reads the connection string --connection points to: @<file> reads a file, - the
// first line of standard input, which keep the private key out of the process list; a string
// given as is still works, with a warning. The string, and the key or password it holds, line by
// line, are masked from then on.
func (a *app) readConnection() error {
	if a.connection == "" {
		return nil
	}
	v := a.connection
	switch {
	case a.connectionRead:
	case v == "-":
		line, err := readLine(a.stdin)
		if err != nil {
			return errs.Usage("--connection -: cannot read the connection string from standard input: %v", err)
		}
		v = line
	case strings.HasPrefix(v, "@"):
		b, err := os.ReadFile(v[1:])
		if err != nil {
			return errs.Usage("--connection: cannot read %s: %v", v[1:], err)
		}
		v = string(b)
	default:
		a.emitter.Masker().Add(v)
		// on stderr: with --json, stdout holds the command's document alone
		fmt.Fprintln(a.stderr, "warning: --connection puts the private key on the command line, where other users of this machine can read it; "+
			"use --connection @<file>, --connection - (standard input), or the <ENV>_CONNECTION variable")
	}
	v = strings.TrimSpace(v)
	a.connection, a.connectionRead = v, true
	a.emitter.Masker().Add(v)
	if c, err := connection.ParseConnString(v); err == nil {
		a.emitter.Masker().Add(c.PrivateKey, c.Password)
	}
	return nil
}

// readLine reads one line of f, byte by byte, so nothing after it is consumed.
func readLine(f *os.File) (string, error) {
	if f == nil {
		return "", errors.New("no standard input")
	}
	var b []byte
	one := make([]byte, 1)
	for len(b) < 1<<20 {
		n, err := f.Read(one)
		if n == 1 {
			if one[0] == '\n' {
				break
			}
			b = append(b, one[0])
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return "", errors.New("it is empty")
	}
	return string(b), nil
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
