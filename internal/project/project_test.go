package project

import (
	"context"
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/testutil"
)

func load(t *testing.T, dir, env string, environ ...string) (*Loaded, error) {
	t.Helper()
	return Load(context.Background(), Options{
		Dir: "testdata/" + dir, Env: env, Environ: environ,
		Git: Git{SHA: "0123456789abcdef", Branch: "main"},
	})
}

func TestBasic(t *testing.T) {
	l, err := load(t, "basic", "prod", `DOCKFLOW_SECRETS={"PRODUCTION_DB_PASSWORD":"from-ci"}`)
	if err != nil {
		t.Fatal(err)
	}
	if l.Config.Env != "production" {
		t.Fatalf("prefix not resolved: %s", l.Config.Env)
	}
	testutil.Golden(t, "basic-production", struct {
		App      any
		Warnings []string
		Version  string
	}{l.App, l.Warnings, l.Version})
}

func TestBasicStagingUsesLocalSecrets(t *testing.T) {
	l, err := load(t, "basic", "staging")
	if err != nil {
		t.Fatal(err)
	}
	web, _ := l.App.Service("web")
	if !contains(web.Spec.Env, "DATABASE_URL=postgres://app:from-local-file@db/app") {
		t.Fatalf("local secret not used: %v", web.Spec.Env)
	}
	if web.Replicas != 1 {
		t.Fatalf("replicas = %d", web.Replicas)
	}
}

func TestMissingVariableIsAnError(t *testing.T) {
	_, err := load(t, "missing-var", "production")
	e, ok := errs.As(err)
	if !ok || e.Exit != errs.ExitConfig || !strings.Contains(e.Message, "NGINX_TAG") {
		t.Fatalf("want a config error naming NGINX_TAG, got %v", err)
	}
}

func TestLaterKeyIsRefused(t *testing.T) {
	_, err := load(t, "later-key", "production")
	e, ok := errs.As(err)
	if !ok || !strings.Contains(e.Message, "`build`") || !strings.Contains(e.Hint, "M2") {
		t.Fatalf("want build refused until M2, got %v", err)
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
