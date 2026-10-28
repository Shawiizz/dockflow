package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/version"
)

// The Model Context Protocol over stdio (ADR-0016): JSON-RPC 2.0, one message per line. The
// protocol needs a handful of methods, written here rather than with an SDK (ADR-0002).

// mcpVersions are the protocol versions served, the newest first.
var mcpVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

// mcpMaxOutput caps the text of a tool's result, from its end: logs can be long.
const mcpMaxOutput = 200_000

type mcpMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
	write       bool
	args        func(in map[string]any) ([]string, error)
}

type mcpServer struct {
	app        *app
	allowApply bool
	// plans are the plans the plan tool computed, by fingerprint: deploy applies only those
	plans    map[string]string
	planDir  string
	tools    []mcpTool
	protocol string
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
			m := &mcpServer{app: a, allowApply: allowApply, plans: map[string]string{}, planDir: dir}
			m.tools = m.toolList()
			return m.serve(cmd.Context(), a.stdin, a.stdout)
		},
	}
	cmd.Flags().BoolVar(&allowApply, "allow-apply", false, "offer the deploy and rollback tools")
	return cmd
}

func (m *mcpServer) serve(ctx context.Context, in io.Reader, out io.Writer) error {
	r := bufio.NewReader(in)
	enc := json.NewEncoder(out)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			if reply := m.handle(ctx, line); reply != nil {
				if werr := enc.Encode(reply); werr != nil {
					return nil
				}
			}
		}
		if err != nil {
			// the client closed stdin: the session is over
			return nil
		}
	}
}

// handle answers one message; notifications get no answer.
func (m *mcpServer) handle(ctx context.Context, line []byte) map[string]any {
	var msg mcpMessage
	if err := json.Unmarshal(line, &msg); err != nil || msg.JSONRPC != "2.0" {
		return map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "not a JSON-RPC 2.0 message"}}
	}
	if len(msg.ID) == 0 {
		return nil
	}
	result, rpcErr := m.call(ctx, msg.Method, msg.Params)
	reply := map[string]any{"jsonrpc": "2.0", "id": msg.ID}
	if rpcErr != nil {
		reply["error"] = rpcErr
	} else {
		reply["result"] = result
	}
	return reply
}

func rpcError(code int, format string, a ...any) map[string]any {
	return map[string]any{"code": code, "message": fmt.Sprintf(format, a...)}
}

func (m *mcpServer) call(ctx context.Context, method string, params json.RawMessage) (any, map[string]any) {
	switch method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(params, &p)
		m.protocol = mcpVersions[0]
		if slices.Contains(mcpVersions, p.ProtocolVersion) {
			m.protocol = p.ProtocolVersion
		}
		instructions := "Dockflow deploys this project's Docker Compose app to its servers. Read tools: validate, status, releases, logs, plan."
		if m.allowApply {
			instructions += " deploy applies a plan by the fingerprint the plan tool returned; rollback restores a release named by its number in releases."
		} else {
			instructions += " Deploys and rollbacks are off: the server was started without --allow-apply."
		}
		return map[string]any{
			"protocolVersion": m.protocol,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "dockflow", "version": version.Version},
			"instructions":    instructions,
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		tools := []mcpTool{}
		for _, t := range m.tools {
			if !t.write || m.allowApply {
				tools = append(tools, t)
			}
		}
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcError(-32602, "invalid params: %v", err)
		}
		for _, t := range m.tools {
			if t.Name == p.Name && (!t.write || m.allowApply) {
				return m.callTool(ctx, t, p.Arguments), nil
			}
		}
		return nil, rpcError(-32602, "unknown tool %s", p.Name)
	}
	return nil, rpcError(-32601, "method %s not found", method)
}

func toolResult(text string, failed bool) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": failed}
}

func (m *mcpServer) callTool(ctx context.Context, t mcpTool, in map[string]any) map[string]any {
	if in == nil {
		in = map[string]any{}
	}
	args, err := t.args(in)
	if err != nil {
		return toolResult(err.Error(), true)
	}
	out, code := m.run(ctx, args...)
	if code != errs.ExitOK {
		return toolResult(fmt.Sprintf("%s\nexit code %d", out, code), true)
	}
	if t.Name == "plan" {
		return m.planned(args, out)
	}
	return toolResult(out, false)
}

// planned keeps the plan the plan tool wrote, for deploy, and gives its fingerprint.
func (m *mcpServer) planned(args []string, out string) map[string]any {
	path := args[slices.Index(args, "--out")+1]
	sp, err := readPlan(path)
	if err != nil {
		os.Remove(path)
		// an empty plan has no fingerprint: nothing to deploy
		return toolResult(out+"\nnothing to deploy", false)
	}
	m.plans[sp.Fingerprint] = path
	note := "fingerprint: " + sp.Fingerprint
	if m.allowApply {
		note += "\napply this plan with the deploy tool and this fingerprint"
	}
	return toolResult(out+"\n"+note, false)
}

// run runs a command of this CLI with --json, in this process, and returns its output.
func (m *mcpServer) run(ctx context.Context, args ...string) (string, int) {
	var out bytes.Buffer
	null, err := os.Open(os.DevNull)
	if err != nil {
		return err.Error(), errs.ExitInternal
	}
	defer null.Close()
	a := &app{stdout: &out, stderr: &out, stdin: null, interrupts: make(chan struct{}, 2)}
	root := a.root()
	global := []string{"--json", "--yes", "--no-color", "--dir", m.app.dir}
	if m.app.connection != "" {
		global = append(global, "--connection", m.app.connection)
	}
	root.SetArgs(append(global, args...))
	code := a.exitCode(root.ExecuteContext(ctx))
	s := out.String()
	if len(s) > mcpMaxOutput {
		s = "[…]" + s[len(s)-mcpMaxOutput:]
	}
	return s, code
}

func (m *mcpServer) toolList() []mcpTool {
	env := map[string]any{"type": "string", "description": "the environment, as in dockflow.yml"}
	schema := func(props map[string]any, required ...string) map[string]any {
		s := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
		if len(required) > 0 {
			s["required"] = required
		}
		return s
	}
	readOnly := map[string]any{"readOnlyHint": true, "openWorldHint": true}
	return []mcpTool{
		{
			Name:        "validate",
			Description: "Check dockflow.yml and the Compose files of an environment, without a server",
			InputSchema: schema(map[string]any{"env": env}),
			Annotations: map[string]any{"readOnlyHint": true, "openWorldHint": false},
			args:        func(in map[string]any) ([]string, error) { return withEnv([]string{"validate"}, in) },
		},
		{
			Name:        "status",
			Description: "The current release, services and containers of an environment; without env, of every environment",
			InputSchema: schema(map[string]any{"env": env}),
			Annotations: readOnly,
			args:        func(in map[string]any) ([]string, error) { return withEnv([]string{"status"}, in) },
		},
		{
			Name:        "releases",
			Description: "The release history of an environment, the newest first",
			InputSchema: schema(map[string]any{"env": env, "count": map[string]any{"type": "integer", "minimum": 1, "description": "the n most recent releases"}}, "env"),
			Annotations: readOnly,
			args: func(in map[string]any) ([]string, error) {
				args, err := withEnv([]string{"releases"}, in)
				if n, ok := in["count"].(float64); ok && err == nil {
					args = append(args, "--count", strconv.Itoa(int(n)))
				}
				return args, err
			},
		},
		{
			Name:        "logs",
			Description: "The logs of an environment's serving containers, or of one service",
			InputSchema: schema(map[string]any{
				"env":     env,
				"service": map[string]any{"type": "string", "description": "the service, as in the Compose file"},
				"lines":   map[string]any{"type": "integer", "minimum": 1, "description": "lines per container from the end (default 100)"},
				"since":   map[string]any{"type": "string", "description": "a timestamp (2026-10-26T14:00:00Z) or a duration (10m)"},
			}, "env"),
			Annotations: readOnly,
			args: func(in map[string]any) ([]string, error) {
				args, err := withEnv([]string{"logs"}, in)
				if err != nil {
					return nil, err
				}
				if s, err := plain(in, "service"); err != nil {
					return nil, err
				} else if s != "" {
					args = append(args, s)
				}
				if n, ok := in["lines"].(float64); ok {
					args = append(args, "--lines", strconv.Itoa(int(n)))
				}
				if s, err := plain(in, "since"); err != nil {
					return nil, err
				} else if s != "" {
					args = append(args, "--since", s)
				}
				return args, nil
			},
		},
		{
			Name: "plan",
			Description: "What a deploy of the working tree would change. It builds and pushes the images it needs, " +
				"changes nothing on the server, and returns the plan's fingerprint",
			InputSchema: schema(map[string]any{
				"env":  env,
				"only": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "plan these services only"},
			}, "env"),
			Annotations: map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true},
			args: func(in map[string]any) ([]string, error) {
				args, err := withEnv([]string{"plan"}, in)
				if err != nil {
					return nil, err
				}
				if only, ok := in["only"].([]any); ok {
					for _, o := range only {
						s, err := plain(map[string]any{"only": o}, "only")
						if err != nil {
							return nil, err
						}
						if s != "" {
							args = append(args, "--only", s)
						}
					}
				}
				f, err := os.CreateTemp(m.planDir, "plan-*.json")
				if err != nil {
					return nil, err
				}
				f.Close()
				return append(args, "--out", filepath.Clean(f.Name())), nil
			},
		},
		{
			Name:        "deploy",
			Description: "Apply a plan the plan tool computed, by its fingerprint; refused if anything changed since",
			InputSchema: schema(map[string]any{"fingerprint": map[string]any{"type": "string", "description": "the fingerprint the plan tool returned"}}, "fingerprint"),
			Annotations: map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": true},
			write:       true,
			args: func(in map[string]any) ([]string, error) {
				fp, _ := in["fingerprint"].(string)
				path, ok := m.plans[fp]
				if !ok {
					return nil, fmt.Errorf("no plan of this session has the fingerprint %q: compute one with the plan tool", fp)
				}
				return []string{"deploy", "--plan", path}, nil
			},
		},
		{
			Name:        "rollback",
			Description: "Re-apply a recorded release of an environment, named by its number in releases",
			InputSchema: schema(map[string]any{
				"env":     env,
				"release": map[string]any{"type": "integer", "minimum": 1, "description": "the release's number, as the releases tool lists it"},
				"service": map[string]any{"type": "string", "description": "restore this service only"},
			}, "env", "release"),
			Annotations: map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": true},
			write:       true,
			args: func(in map[string]any) ([]string, error) {
				args, err := withEnv([]string{"rollback"}, in)
				if err != nil {
					return nil, err
				}
				n, ok := in["release"].(float64)
				if !ok || n < 1 {
					return nil, fmt.Errorf("release is required: the release's number, as the releases tool lists it")
				}
				args = append(args, "--to", strconv.Itoa(int(n)))
				if s, err := plain(in, "service"); err != nil {
					return nil, err
				} else if s != "" {
					args = append(args, "--service", s)
				}
				return args, nil
			},
		},
	}
}

// withEnv appends the env argument, when given.
func withEnv(args []string, in map[string]any) ([]string, error) {
	env, err := plain(in, "env")
	if err != nil || env == "" {
		return args, err
	}
	return append(args, env), nil
}

// plain returns the string argument key, refused if it would read as a flag.
func plain(in map[string]any, key string) (string, error) {
	v, ok := in[key]
	if !ok {
		return "", nil
	}
	s, ok := v.(string)
	if !ok || strings.HasPrefix(s, "-") {
		return "", fmt.Errorf("%s must be a string that does not start with -", key)
	}
	return s, nil
}
