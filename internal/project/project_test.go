package project

import (
	"context"
	"encoding/json"
	"os"
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
	if !ok || !strings.Contains(e.Message, "`routes`") || !strings.Contains(e.Hint, "M3") {
		t.Fatalf("want routes refused until M3, got %v", err)
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

// ./data names a directory of this machine: the server has no such path.
func TestRelativeBindMountIsRefused(t *testing.T) {
	_, err := load(t, "relative-bind", "production")
	e, ok := errs.As(err)
	if !ok || e.Exit != errs.ExitConfig || !strings.Contains(e.Message, "data") {
		t.Fatalf("want a config error naming the bind mount, got %v", err)
	}
}

// Without an environment, a file with several still reads: choosing one from a CI tag needs it.
func TestReadWithoutEnvironmentKeepsTheFile(t *testing.T) {
	raw, _, err := Read("testdata/basic", "")
	if raw == nil || len(raw.EnvNames()) < 2 {
		t.Fatalf("the file must be read even when no environment is picked: %v", err)
	}
}

// Compose keys that docker compose up passes to the container are passed too; the ones a
// release's new containers would break are refused with the reason.
func TestComposeKeys(t *testing.T) {
	l, err := load(t, "compose-keys", "production")
	if err != nil {
		t.Fatal(err)
	}
	testutil.Golden(t, "compose-keys", struct {
		App      any
		Warnings []string
	}{l.App, l.Warnings})
}

func TestComposeKeysRefused(t *testing.T) {
	for name, service := range map[string]string{
		"network_mode service": "web: {image: nginx, network_mode: \"service:db\"}\n  db: {image: postgres}",
		"volumes_from":         "web: {image: nginx, volumes_from: [db]}\n  db: {image: postgres}",
		"link alias":           "web: {image: nginx, links: [\"db:database\"]}\n  db: {image: postgres}",
		"selinux":              "web: {image: nginx, volumes: [{type: bind, source: /srv, target: /srv, bind: {selinux: z}}]}",
		"job health":           "m: {image: alpine, x-dockflow: {run: before, health: {grace: 2s}}}",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte("version: 1\napp: keys\nenvironments:\n  production: {}\n"), 0o644)
			os.WriteFile(filepath.Join(dir, "compose.yml"), []byte("services:\n  "+service+"\n"), 0o644)
			_, err := Load(context.Background(), Options{Dir: dir, Env: "production"})
			if e, ok := errs.As(err); !ok || e.Exit != errs.ExitConfig {
				t.Fatalf("want a config error, got %v", err)
			}
		})
	}
}

// Secrets and configs become files named after their content: the app records their paths and
// hashes, never their values, which the run carries apart and the masker knows.
func TestSecretsAndConfigs(t *testing.T) {
	l, err := load(t, "secrets", "production",
		"PRODUCTION_DB_PASSWORD=pg-s3cret", "PRODUCTION_API_TOKEN=api-s3cret", "PRODUCTION_NPM_TOKEN=npm-s3cret")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(l.App)
	for _, v := range []string{"pg-s3cret", "api-s3cret", "npm-s3cret"} {
		if strings.Contains(string(b), v) {
			t.Fatalf("the app must not hold the value %s", v)
		}
		if !contains(append(l.FileSecrets, l.Secrets.Values()...), v) {
			t.Fatalf("%s must be masked", v)
		}
	}
	if len(l.FileContents) != 3 {
		t.Fatalf("two secrets and a config: %v", len(l.FileContents))
	}
	testutil.Golden(t, "secrets", l.App)
}
