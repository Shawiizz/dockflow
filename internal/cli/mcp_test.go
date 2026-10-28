package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mcpSession sends the requests to `dockflow mcp` and returns its answers by id.
func mcpSession(t *testing.T, dir string, flags []string, requests ...string) map[float64]map[string]any {
	t.Helper()
	in := filepath.Join(t.TempDir(), "in")
	if err := os.WriteFile(in, []byte(strings.Join(requests, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(in)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out bytes.Buffer
	a := &app{stdout: &out, stderr: &out, stdin: f, interrupts: make(chan struct{}, 2)}
	root := a.root()
	root.SetArgs(append([]string{"-C", dir, "mcp"}, flags...))
	if err := root.Execute(); err != nil {
		t.Fatalf("mcp: %v\n%s", err, out.String())
	}
	answers := map[float64]map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("not JSON: %q", line)
		}
		id, _ := m["id"].(float64)
		answers[id] = m
	}
	return answers
}

func toolNames(t *testing.T, answer map[string]any) []string {
	t.Helper()
	var names []string
	for _, tool := range answer["result"].(map[string]any)["tools"].([]any) {
		names = append(names, tool.(map[string]any)["name"].(string))
	}
	return names
}

func toolText(t *testing.T, answer map[string]any) (string, bool) {
	t.Helper()
	res, ok := answer["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %v", answer)
	}
	return res["content"].([]any)[0].(map[string]any)["text"].(string), res["isError"].(bool)
}

func TestMCP(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte("version: 1\napp: shop\nenvironments:\n  production: {}\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "compose.yml"), []byte("services:\n  web:\n    image: nginx:1.27\n"), 0o644)

	got := mcpSession(t, dir, nil,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"validate","arguments":{"env":"production"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"validate","arguments":{"env":"staging"}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"deploy","arguments":{"fingerprint":"x"}}}`,
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"logs","arguments":{"env":"production","service":"--connection"}}}`,
		`{"jsonrpc":"2.0","id":7,"method":"resources/list"}`,
		`{"jsonrpc":"2.0","id":8,"method":"ping"}`,
	)
	if len(got) != 8 {
		t.Fatalf("one answer per request, none to the notification: %v", got)
	}
	init := got[1]["result"].(map[string]any)
	if init["protocolVersion"] != "2025-06-18" || init["serverInfo"].(map[string]any)["name"] != "dockflow" {
		t.Fatalf("initialize: %v", init)
	}
	if names := strings.Join(toolNames(t, got[2]), " "); names != "validate status releases logs plan" {
		t.Fatalf("without --allow-apply, the read tools only: %s", names)
	}
	if text, failed := toolText(t, got[3]); failed || !strings.Contains(text, `"valid": true`) {
		t.Fatalf("validate: %v\n%s", failed, text)
	}
	if text, failed := toolText(t, got[4]); !failed || !strings.Contains(text, "staging") {
		t.Fatalf("validate of an unknown environment fails: %v\n%s", failed, text)
	}
	if got[5]["error"] == nil {
		t.Fatalf("deploy is not a tool without --allow-apply: %v", got[5])
	}
	if text, failed := toolText(t, got[6]); !failed || !strings.Contains(text, "does not start with -") {
		t.Fatalf("an argument cannot be a flag: %v\n%s", failed, text)
	}
	if code := got[7]["error"].(map[string]any)["code"]; code != float64(-32601) {
		t.Fatalf("unknown method: %v", got[7])
	}
	if got[8]["result"] == nil {
		t.Fatalf("ping: %v", got[8])
	}

	got = mcpSession(t, dir, []string{"--allow-apply"},
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"deploy","arguments":{"fingerprint":"sha256:none"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rollback","arguments":{"env":"production"}}}`,
	)
	if v := got[1]["result"].(map[string]any)["protocolVersion"]; v != mcpVersions[0] {
		t.Fatalf("an unknown version gets the newest: %v", v)
	}
	if names := strings.Join(toolNames(t, got[2]), " "); names != "validate status releases logs plan deploy rollback" {
		t.Fatalf("with --allow-apply, the write tools too: %s", names)
	}
	// only a plan this session computed can be applied
	if text, failed := toolText(t, got[3]); !failed || !strings.Contains(text, "no plan of this session") {
		t.Fatalf("deploy of an unknown fingerprint: %v\n%s", failed, text)
	}
	if text, failed := toolText(t, got[4]); !failed || !strings.Contains(text, "release is required") {
		t.Fatalf("rollback names its release: %v\n%s", failed, text)
	}
}
