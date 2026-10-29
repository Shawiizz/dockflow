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

// A local hook inherits what a shell needs and the CI's description of the run, never a secret
// of any environment, DOCKFLOW_SECRETS, a SOPS key or a CI token; it gets a secret by listing it.
func TestLocalHookEnvironment(t *testing.T) {
	environ := []string{
		"PATH=/usr/bin:/bin", "HOME=/home/me", "LANG=C.UTF-8", "LC_ALL=C", "SSH_AUTH_SOCK=/tmp/agent", "CI=true",
		"GITHUB_SHA=abc123", "GITHUB_TOKEN=ghs_token", "GITHUB_REF_NAME=v1.2.0", "CI_COMMIT_SHA=abc123",
		"CI_JOB_TOKEN=glcbt-token", "CI_REPOSITORY_URL=https://gitlab-ci-token:glcbt-token@gitlab.example/x.git",
		"CI_REGISTRY_PASSWORD=registry-pass", "ACTIONS_RUNTIME_TOKEN=runtime",
		"PRODUCTION_CONNECTION=prod-conn", "STAGING_CONNECTION=staging-conn", "STAGING_DB_PASSWORD=staging-db",
		"DOCKFLOW_SECRETS={\"A\":\"b\"}", "DOCKFLOW_SSH_KEY=key", "SOPS_AGE_KEY=AGE-SECRET-KEY-1", "AWS_SECRET_ACCESS_KEY=aws",
		"NPM_TOKEN=npm",
	}
	got := Environ(environ, []string{"production", "staging"})
	want := []string{"PATH=/usr/bin:/bin", "HOME=/home/me", "LANG=C.UTF-8", "LC_ALL=C", "SSH_AUTH_SOCK=/tmp/agent", "CI=true",
		"GITHUB_SHA=abc123", "GITHUB_REF_NAME=v1.2.0", "CI_COMMIT_SHA=abc123"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("inherited:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// an environment named like a CI's family keeps its secrets out
	if got := Environ([]string{"CI_DB_PASSWORD_X=1", "CI_COMMIT_SHA=abc"}, []string{"ci"}); len(got) != 0 {
		t.Fatalf("the ci environment's variables inherited: %v", got)
	}

	// the hook runs with these and its own variables only
	var mu sync.Mutex
	var lines []string
	em := events.NewEmitter("r1", events.SinkFunc(func(e events.Event) {
		if e.Type == events.HookLog {
			mu.Lock()
			lines = append(lines, e.Msg)
			mu.Unlock()
		}
	}), nil)
	t.Setenv("STAGING_CONNECTION", "staging-conn")
	r := &Runner{Dir: t.TempDir(), Events: em, Environ: Environ(os.Environ(), []string{"production", "staging"})}
	h := domain.Hook{Phase: domain.HookBeforeBuild, Name: "env", Kind: domain.HookLocal, Command: "env",
		Env: []string{"DOCKFLOW_ENV=production", "JWT_KEY=listed"}, Timeout: domain.Duration(10 * time.Second), Fatal: true}
	if err := r.Run(context.Background(), domain.HookBeforeBuild, []domain.Hook{h}); err != nil {
		t.Fatal(err)
	}
	out := strings.Join(lines, "\n")
	if strings.Contains(out, "staging-conn") || !strings.Contains(out, "JWT_KEY=listed") || !strings.Contains(out, "PATH=") {
		t.Fatalf("the hook's environment:\n%s", out)
	}
}

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
