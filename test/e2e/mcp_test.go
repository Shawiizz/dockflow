//go:build e2e

package e2e

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// An agent deploys through `dockflow mcp --allow-apply`: plan, deploy by the plan's fingerprint, a
// stale plan refused, then a rollback by release number.
func TestMCP(t *testing.T) {
	app := "journey43"
	host := app + ".test"
	dir := filepath.Join(workDir, app)
	commit := func(message string) {
		builtApp(t, dir, app, message)
		if out, err := exec.Command("sh", "-c", "cd "+dir+" && (git init -q 2>/dev/null; true) && git add -A && git -c user.name=e2e -c user.email=e2e@example.com commit -qm "+message).CombinedOutput(); err != nil {
			t.Fatalf("git: %v: %s", err, out)
		}
	}
	t.Cleanup(func() { dockflow(t, dir, "destroy", "production") })
	commit("first")

	cmd := dockflowCmd(dir, "mcp", "--allow-apply")
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); cmd.Wait() }()
	answers := bufio.NewScanner(stdout)
	answers.Buffer(make([]byte, 0, 1<<20), 16<<20)
	id, progress := 0, 0
	// call sends a request and returns its answer, counting the progress notifications before it
	call := func(method string, params any) map[string]any {
		t.Helper()
		id++
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		fmt.Fprintf(stdin, "%s\n", b)
		for {
			done := make(chan bool, 1)
			go func() { done <- answers.Scan() }()
			select {
			case ok := <-done:
				if !ok {
					t.Fatalf("%s: the server closed its output", method)
				}
			case <-time.After(5 * time.Minute):
				t.Fatalf("%s: no answer", method)
			}
			var m map[string]any
			if err := json.Unmarshal(answers.Bytes(), &m); err != nil {
				t.Fatalf("%s: %v %s", method, err, answers.Bytes())
			}
			if m["method"] == "notifications/progress" {
				progress++
				continue
			}
			if m["id"] != float64(id) {
				t.Fatalf("%s: %s", method, answers.Bytes())
			}
			return m
		}
	}
	tool := func(name string, args map[string]any) (string, bool) {
		t.Helper()
		res := call("tools/call", map[string]any{"name": name, "arguments": args, "_meta": map[string]any{"progressToken": id + 1}})["result"].(map[string]any)
		failed, _ := res["isError"].(bool)
		return res["content"].([]any)[0].(map[string]any)["text"].(string), failed
	}
	fingerprint := func(text string) string {
		t.Helper()
		for _, line := range strings.Split(text, "\n") {
			if fp, ok := strings.CutPrefix(line, "fingerprint: "); ok {
				return fp
			}
		}
		t.Fatalf("the plan has no fingerprint:\n%s", text)
		return ""
	}
	mustTool := func(name string, args map[string]any) string {
		t.Helper()
		text, failed := tool(name, args)
		if failed {
			t.Fatalf("%s failed:\n%s", name, text)
		}
		return text
	}

	call("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "e2e", "version": "1"}})
	fmt.Fprintln(stdin, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)

	first := fingerprint(mustTool("plan", map[string]any{"env": "production"}))
	progress = 0
	mustTool("deploy", map[string]any{"fingerprint": first})
	// the deploy's events reached the client as it ran
	if progress == 0 {
		t.Fatal("the deploy sent no progress notification")
	}
	waitServing(t, host)
	if got := served(t, host); got != "first" {
		t.Fatalf("served %q, want first", got)
	}

	commit("second")
	second := fingerprint(mustTool("plan", map[string]any{"env": "production"}))
	mustTool("deploy", map[string]any{"fingerprint": second})
	if got := served(t, host); got != "second" {
		t.Fatalf("served %q, want second", got)
	}
	// the server changed since the first plan: it no longer applies
	if text, failed := tool("deploy", map[string]any{"fingerprint": first}); !failed || !strings.Contains(text, "plan.stale") {
		t.Fatalf("a stale plan must be refused: %v\n%s", failed, text)
	}

	if text := mustTool("releases", map[string]any{"env": "production"}); !strings.Contains(text, `"seq": 2`) {
		t.Fatalf("releases:\n%s", text)
	}
	mustTool("rollback", map[string]any{"env": "production", "release": 1})
	if got := served(t, host); got != "first" {
		t.Fatalf("after the rollback, served %q, want first", got)
	}
	if text := mustTool("status", map[string]any{"env": "production"}); !strings.Contains(text, app) {
		t.Fatalf("status:\n%s", text)
	}
	mustTool("logs", map[string]any{"env": "production", "lines": 5})
}
