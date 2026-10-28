package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcpClient connects a client to the MCP server of the project in dir.
func mcpClient(t *testing.T, dir string, allowApply bool) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	m := &mcpServer{app: &app{dir: dir}, plans: map[string]string{}, planDir: t.TempDir()}
	st, ct := mcp.NewInMemoryTransports()
	ss, err := m.server(allowApply).Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func tools(t *testing.T, cs *mcp.ClientSession) string {
	t.Helper()
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
	}
	return strings.Join(names, " ")
}

func callTool(t *testing.T, cs *mcp.ClientSession, params *mcp.CallToolParams) (string, bool) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), params)
	if err != nil {
		t.Fatalf("%s: %v", params.Name, err)
	}
	return res.Content[0].(*mcp.TextContent).Text, res.IsError
}

func TestMCP(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte("version: 1\napp: shop\nenvironments:\n  production: {}\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "compose.yml"), []byte("services:\n  web:\n    image: nginx:1.27\n"), 0o644)

	cs := mcpClient(t, dir, false)
	if got := tools(t, cs); got != "logs plan releases status validate" {
		t.Fatalf("without --allow-apply, the read tools only: %s", got)
	}
	call := func(name string, args map[string]any) (string, bool) {
		return callTool(t, cs, &mcp.CallToolParams{Name: name, Arguments: args})
	}
	if text, failed := call("validate", map[string]any{"env": "production"}); failed || !strings.Contains(text, `"valid": true`) {
		t.Fatalf("validate: %v\n%s", failed, text)
	}
	if text, failed := call("validate", map[string]any{"env": "staging"}); !failed || !strings.Contains(text, "staging") {
		t.Fatalf("validate of an unknown environment fails: %v\n%s", failed, text)
	}
	if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "deploy", Arguments: map[string]any{"fingerprint": "x"}}); err == nil {
		t.Fatal("deploy is not a tool without --allow-apply")
	}
	if text, failed := call("logs", map[string]any{"env": "production", "service": "--connection"}); !failed || !strings.Contains(text, "cannot start with -") {
		t.Fatalf("a value cannot be a flag: %v\n%s", failed, text)
	}
	if text, failed := call("releases", map[string]any{"count": 3}); !failed || !strings.Contains(text, "env") {
		t.Fatalf("releases needs its env: %v\n%s", failed, text)
	}

	cs = mcpClient(t, dir, true)
	if got := tools(t, cs); got != "deploy logs plan releases rollback status validate" {
		t.Fatalf("with --allow-apply, the write tools too: %s", got)
	}
	// only a plan this session computed can be applied
	if text, failed := callTool(t, cs, &mcp.CallToolParams{Name: "deploy", Arguments: map[string]any{"fingerprint": "sha256:none"}}); !failed || !strings.Contains(text, "no plan of this session") {
		t.Fatalf("deploy of an unknown fingerprint: %v\n%s", failed, text)
	}
	if text, failed := callTool(t, cs, &mcp.CallToolParams{Name: "rollback", Arguments: map[string]any{"env": "production"}}); !failed || !strings.Contains(text, "release") {
		t.Fatalf("rollback names its release: %v\n%s", failed, text)
	}
}
