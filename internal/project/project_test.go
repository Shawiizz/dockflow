package project

import (
	"context"
	"path/filepath"
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
	if !ok || !strings.Contains(e.Message, "`firewall`") || !strings.Contains(e.Hint, "M3") {
		t.Fatalf("want firewall refused until M3, got %v", err)
	}
}

func TestBuildIsConverted(t *testing.T) {
	l, err := load(t, "build", "production")
	if err != nil {
		t.Fatal(err)
	}
	app, _ := l.App.Service("app")
	if !app.Build || app.Spec.Image != "site/app" {
		t.Fatalf("a built service is named <app>/<service> until it is pinned: %+v", app)
	}
	b := l.Builds[0]
	dir, _ := filepath.Abs("testdata/build")
	if b.Context != dir {
		t.Fatalf("the context must be absolute: %s", b.Context)
	}
	b.Context = "<project>"
	testutil.Golden(t, "build", b)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// A routed service is warned about only when nothing but the grace gates its switch.
func TestRoutedWithoutHealthcheckWarning(t *testing.T) {
	l, err := load(t, "routed", "production")
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Warnings) != 1 || !strings.Contains(l.Warnings[0], "unchecked") {
		t.Fatalf("only the service without a check must be warned about: %q", l.Warnings)
	}
}
