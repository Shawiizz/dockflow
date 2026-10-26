package hooks

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/events"
)

// A script hook listed under templates: runs rendered, with its template's mode; the project's
// file is left as it is.
func TestScriptHookRunsRendered(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "deploy.sh"), []byte("echo raw\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var lines []string
	em := events.NewEmitter("r1", events.SinkFunc(func(e events.Event) {
		if e.Type == events.HookLog {
			mu.Lock()
			lines = append(lines, e.Msg)
			mu.Unlock()
		}
	}), nil)
	r := &Runner{Dir: dir, Events: em, Render: func(script string) ([]byte, os.FileMode, bool, error) {
		if script != "deploy.sh" {
			return nil, 0, false, nil
		}
		return []byte("#!/bin/sh\necho rendered for production\n"), 0o755, true, nil
	}}
	h := domain.Hook{Phase: domain.HookBeforeBuild, Name: "deploy", Kind: domain.HookLocal, Script: "deploy.sh",
		Timeout: domain.Duration(10 * time.Second), Fatal: true}
	if err := r.Run(context.Background(), domain.HookBeforeBuild, []domain.Hook{h}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(lines, "\n"); !strings.Contains(got, "rendered for production") {
		t.Fatalf("the rendered script must run, got %q", got)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "deploy.sh")); string(b) != "echo raw\n" {
		t.Fatalf("the project's script must stay as it is: %q", b)
	}

	// a script that is no template runs as it is
	lines = nil
	r.Render = func(string) ([]byte, os.FileMode, bool, error) { return nil, 0, false, nil }
	if err := r.Run(context.Background(), domain.HookBeforeBuild, []domain.Hook{h}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(lines, "\n"); !strings.Contains(got, "raw") {
		t.Fatalf("the project's script must run, got %q", got)
	}
}
