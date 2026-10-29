package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/version"
)

// The Model Context Protocol over stdio (ADR-0016). Each tool runs a command of this CLI, in the
// process, with --json: the command's events go to the client as progress notifications, and its
// output is the tool's result.

// mcpMaxOutput caps the text of a tool's result, from its end: logs can be long.
const mcpMaxOutput = 200_000

type mcpServer struct {
	app *app
	// one command at a time: they share this process
	mu sync.Mutex
	// plans are the plans the plan tool computed, by fingerprint: deploy applies only those
	plans   map[string]string
	planDir string
}

func (a *app) mcpCmd() *cobra.Command {
	var allowApply bool
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "An MCP server over stdio, for AI agents",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir, err := os.MkdirTemp("", "dockflow-mcp-")
			if err != nil {
				return errs.Internal("create the plans' directory: %v", err)
			}
			defer os.RemoveAll(dir)
			m := &mcpServer{app: a, plans: map[string]string{}, planDir: dir}
			if err := m.server(allowApply).Run(cmd.Context(), &mcp.StdioTransport{}); err != nil && cmd.Context().Err() == nil {
				return errs.Internal("mcp: %v", err)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&allowApply, "allow-apply", false, "offer the deploy and rollback tools")
	return cmd
}

type envInput struct {
	Env string `json:"env,omitempty" jsonschema:"the environment, as in dockflow.yml"`
}

type releasesInput struct {
	Env   string `json:"env" jsonschema:"the environment, as in dockflow.yml"`
	Count int    `json:"count,omitempty" jsonschema:"the n most recent releases"`
}

type logsInput struct {
	Env     string `json:"env" jsonschema:"the environment, as in dockflow.yml"`
	Service string `json:"service,omitempty" jsonschema:"the service, as in the Compose file"`
	Lines   int    `json:"lines,omitempty" jsonschema:"lines per container from the end (default 100)"`
	Since   string `json:"since,omitempty" jsonschema:"a timestamp (2026-10-26T14:00:00Z) or a duration (10m)"`
}

type planInput struct {
	Env  string   `json:"env" jsonschema:"the environment, as in dockflow.yml"`
	Only []string `json:"only,omitempty" jsonschema:"plan these services only"`
}

type deployInput struct {
	Fingerprint string `json:"fingerprint" jsonschema:"the fingerprint the plan tool returned"`
}

type rollbackInput struct {
	Env     string `json:"env" jsonschema:"the environment, as in dockflow.yml"`
	Release int    `json:"release" jsonschema:"the release's number, as the releases tool lists it"`
	Service string `json:"service,omitempty" jsonschema:"restore this service only"`
}

func (m *mcpServer) server(allowApply bool) *mcp.Server {
	instructions := "Dockflow deploys this project's Docker Compose app to its servers. Read tools: validate, status, releases, logs, plan."
	if allowApply {
		instructions += " deploy applies a plan by the fingerprint the plan tool returned; rollback restores a release named by its number in releases."
	} else {
		instructions += " Deploys and rollbacks are off: the server was started without --allow-apply."
	}
	s := mcp.NewServer(&mcp.Implementation{Name: "dockflow", Version: version.Version},
		&mcp.ServerOptions{Instructions: instructions, Capabilities: &mcp.ServerCapabilities{}})
	closed, open := false, true
	read := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &open}
	write := &mcp.ToolAnnotations{DestructiveHint: &open, OpenWorldHint: &open}

	mcp.AddTool(s, &mcp.Tool{Name: "validate", Description: "Check dockflow.yml and the Compose files of an environment, without a server",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &closed}},
		func(ctx context.Context, req *mcp.CallToolRequest, in envInput) (*mcp.CallToolResult, any, error) {
			return m.tool(ctx, req, withEnv("validate", in.Env), in.Env)
		})
	mcp.AddTool(s, &mcp.Tool{Name: "status", Description: "The current release, services and containers of an environment; without env, of every environment", Annotations: read},
		func(ctx context.Context, req *mcp.CallToolRequest, in envInput) (*mcp.CallToolResult, any, error) {
			return m.tool(ctx, req, withEnv("status", in.Env), in.Env)
		})
	mcp.AddTool(s, &mcp.Tool{Name: "releases", Description: "The release history of an environment, the newest first", Annotations: read},
		func(ctx context.Context, req *mcp.CallToolRequest, in releasesInput) (*mcp.CallToolResult, any, error) {
			args := withEnv("releases", in.Env)
			if in.Count > 0 {
				args = append(args, "--count", strconv.Itoa(in.Count))
			}
			return m.tool(ctx, req, args, in.Env)
		})
	mcp.AddTool(s, &mcp.Tool{Name: "logs", Description: "The logs of an environment's serving containers, or of one service", Annotations: read},
		func(ctx context.Context, req *mcp.CallToolRequest, in logsInput) (*mcp.CallToolResult, any, error) {
			args := withEnv("logs", in.Env)
			if in.Service != "" {
				args = append(args, in.Service)
			}
			if in.Lines > 0 {
				args = append(args, "--lines", strconv.Itoa(in.Lines))
			}
			if in.Since != "" {
				args = append(args, "--since", in.Since)
			}
			return m.tool(ctx, req, args, in.Env, in.Service, in.Since)
		})
	mcp.AddTool(s, &mcp.Tool{Name: "plan",
		Description: "What a deploy of the working tree would change. It builds and pushes the images it needs, " +
			"changes nothing on the server, and returns the plan's fingerprint",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: &closed, IdempotentHint: true, OpenWorldHint: &open}},
		func(ctx context.Context, req *mcp.CallToolRequest, in planInput) (*mcp.CallToolResult, any, error) {
			return m.plan(ctx, req, in)
		})
	if !allowApply {
		return s
	}
	mcp.AddTool(s, &mcp.Tool{Name: "deploy", Description: "Apply a plan the plan tool computed, by its fingerprint; refused if anything changed since", Annotations: write},
		func(ctx context.Context, req *mcp.CallToolRequest, in deployInput) (*mcp.CallToolResult, any, error) {
			m.mu.Lock()
			path, ok := m.plans[in.Fingerprint]
			m.mu.Unlock()
			if !ok {
				return failed(fmt.Sprintf("no plan of this session has the fingerprint %q: compute one with the plan tool", in.Fingerprint)), nil, nil
			}
			return m.tool(ctx, req, []string{"deploy", "--plan", path})
		})
	mcp.AddTool(s, &mcp.Tool{Name: "rollback", Description: "Re-apply a recorded release of an environment, named by its number in releases", Annotations: write},
		func(ctx context.Context, req *mcp.CallToolRequest, in rollbackInput) (*mcp.CallToolResult, any, error) {
			if in.Release < 1 {
				return failed("release is required: the release's number, as the releases tool lists it"), nil, nil
			}
			args := append(withEnv("rollback", in.Env), "--to", strconv.Itoa(in.Release))
			if in.Service != "" {
				args = append(args, "--service", in.Service)
			}
			return m.tool(ctx, req, args, in.Env, in.Service)
		})
	return s
}

func failed(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}, IsError: true}
}

// withEnv is the command with its env argument, when given.
func withEnv(command, env string) []string {
	if env == "" {
		return []string{command}
	}
	return []string{command, env}
}

// tool runs the command and makes its output the tool's result. The values from the client are
// arguments, never flags.
func (m *mcpServer) tool(ctx context.Context, req *mcp.CallToolRequest, args []string, values ...string) (*mcp.CallToolResult, any, error) {
	for _, v := range values {
		if strings.HasPrefix(v, "-") {
			return failed(fmt.Sprintf("%q: a value cannot start with -", v)), nil, nil
		}
	}
	out, code, err := m.run(ctx, req, args...)
	if err != nil {
		return failed(err.Error()), nil, nil
	}
	if code != errs.ExitOK {
		return failed(fmt.Sprintf("%s\nexit code %d", out, code)), nil, nil
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: out}}}, nil, nil
}

// plan runs plan --out, keeps the plan for deploy, and gives its fingerprint.
func (m *mcpServer) plan(ctx context.Context, req *mcp.CallToolRequest, in planInput) (*mcp.CallToolResult, any, error) {
	f, err := os.CreateTemp(m.planDir, "plan-*.json")
	if err != nil {
		return failed(err.Error()), nil, nil
	}
	f.Close()
	path := filepath.Clean(f.Name())
	args := append(withEnv("plan", in.Env), "--out", path)
	for _, s := range in.Only {
		args = append(args, "--only", s)
	}
	res, _, _ := m.tool(ctx, req, args, append([]string{in.Env}, in.Only...)...)
	if res.IsError {
		return res, nil, nil
	}
	text := res.Content[0].(*mcp.TextContent)
	sp, err := readPlan(path)
	if err != nil {
		// an empty plan has no fingerprint: nothing to deploy
		os.Remove(path)
		text.Text += "\nnothing to deploy"
		return res, nil, nil
	}
	m.mu.Lock()
	m.plans[sp.Fingerprint] = path
	m.mu.Unlock()
	text.Text += "\nfingerprint: " + sp.Fingerprint
	return res, nil, nil
}

// run runs a command of this CLI with --json, in this process, and returns its output. Each event
// is also a progress notification, when the client asked for them. A cancelled call stops the
// command as Ctrl+C does: a deploy under way rolls back.
func (m *mcpServer) run(ctx context.Context, req *mcp.CallToolRequest, args ...string) (string, int, error) {
	null, err := os.Open(os.DevNull)
	if err != nil {
		return "", 0, err
	}
	defer null.Close()
	m.mu.Lock()
	defer m.mu.Unlock()

	out := &progressWriter{ctx: ctx, req: req, token: req.Params.GetProgressToken()}
	a := &app{stdout: out, stderr: out, stdin: null, interrupts: make(chan struct{}, 2)}
	inner, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()
	stop := context.AfterFunc(ctx, func() {
		if !a.agentRunning.Load() {
			cancel()
			return
		}
		select {
		case a.interrupts <- struct{}{}:
		default:
		}
	})
	defer stop()

	root := a.root()
	global := []string{"--json", "--yes", "--no-color", "--dir", m.app.dir}
	// the string the server's --connection read, handed over in memory: never as an argument
	a.connection, a.connectionRead = m.app.connection, true
	root.SetArgs(append(global, args...))
	code := a.exitCode(root.ExecuteContext(inner))
	s := out.all.String()
	if len(s) > mcpMaxOutput {
		s = "[…]" + s[len(s)-mcpMaxOutput:]
	}
	return s, code, nil
}

// progressWriter keeps a command's output and sends each of its events as a progress notification.
type progressWriter struct {
	ctx   context.Context
	req   *mcp.CallToolRequest
	token any
	all   bytes.Buffer
	line  []byte
	n     float64
}

func (w *progressWriter) Write(p []byte) (int, error) {
	w.all.Write(p)
	if w.token == nil {
		return len(p), nil
	}
	w.line = append(w.line, p...)
	for {
		i := bytes.IndexByte(w.line, '\n')
		if i < 0 {
			return len(p), nil
		}
		var e struct {
			Msg string `json:"msg"`
		}
		if json.Unmarshal(w.line[:i], &e) == nil && e.Msg != "" {
			w.n++
			_ = w.req.Session.NotifyProgress(w.ctx, &mcp.ProgressNotificationParams{ProgressToken: w.token, Progress: w.n, Message: e.Msg})
		}
		w.line = w.line[i+1:]
	}
}
