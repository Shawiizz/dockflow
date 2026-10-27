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

func TestAppRoutes(t *testing.T) {
	l, err := load(t, "app-routes", "production", "PRODUCTION_ARCHIVES_PASSWORD=s3cret")
	if err != nil {
		t.Fatal(err)
	}
	testutil.Golden(t, "app-routes", struct {
		Services any
		Routes   any
		Networks any
	}{l.App.Services, l.App.Routes, l.App.Networks})
}

func TestAppRouteErrors(t *testing.T) {
	cases := map[string]string{
		"two kinds":      "routes:\n  - domains: [a.test]\n    redirect: https://b.test\n    proxy: http://c:80\n",
		"no kind":        "routes:\n  - domains: [a.test]\n",
		"proxy path":     "routes:\n  - domains: [a.test]\n    proxy: http://c:80/api\n",
		"unknown page":   "routes:\n  - domains: [a.test]\n    redirect: https://b.test\n    error_pages: { \"502\": { route: nope } }\n",
		"unknown volume": "routes:\n  - domains: [a.test]\n    files: { volume: nope }\n",
		"bad status":     "routes:\n  - domains: [a.test]\n    redirect: https://b.test\n    status: 200\n",
	}
	for name, routes := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte("version: 1\napp: shop\n"+routes+"environments:\n  production: {}\n"), 0o644)
			os.WriteFile(filepath.Join(dir, "compose.yml"), []byte("services:\n  web:\n    image: nginx\n"), 0o644)
			_, err := Load(context.Background(), Options{Dir: dir, Env: "production"})
			if e, ok := errs.As(err); !ok || e.Exit != errs.ExitConfig {
				t.Fatalf("want a config error, got %v", err)
			}
		})
	}
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

// A command that acts on what the server runs reads dockflow.yml alone: the variables of the
// Compose files are not needed.
func TestConfigOnlyNeedsNoComposeVariable(t *testing.T) {
	l, err := Load(context.Background(), Options{Dir: "testdata/missing-var", Env: "production", ConfigOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if l.App.Stack != "shop-production" || len(l.App.Services) != 0 || l.Config.Env != "production" {
		t.Fatalf("the environment, without the Compose files: %+v", l.App)
	}
}

func TestBackups(t *testing.T) {
	l, err := load(t, "backups", "production")
	if err != nil {
		t.Fatal(err)
	}
	b := l.Config.Backups
	if b == nil || b.Repository != "s3:s3.example.com/backups/shop" || b.Password != "repo-password" || b.Env["AWS_ACCESS_KEY_ID"] != "key" {
		t.Fatalf("backups: %+v", b)
	}
	db, _ := l.App.Service("db")
	if db.Backup == nil || db.Backup.Type != "postgres" || strings.Join(db.Backup.DumpOptions, " ") != "--no-owner --no-acl" || db.Backup.Keep.Daily != 14 {
		t.Fatalf("db: %+v", db.Backup)
	}
	mc, _ := l.App.Service("minecraft")
	if b := mc.Backup; b == nil || b.Quiesce.Mode != "exec" || strings.Join(b.Quiesce.Pre, " ") != "rcon-cli save-off" || strings.Join(b.Volumes, ",") != "/data" {
		t.Fatalf("minecraft: %+v", mc.Backup)
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

// A Compose file in a folder of the project resolves its paths from that folder, as Compose
// does; a bind mount of the project, from there too, is still refused.
func TestComposeFileInAFolder(t *testing.T) {
	_, err := load(t, "compose-subdir", "production")
	if e, ok := errs.As(err); !ok || !strings.Contains(e.Message, "data") {
		t.Fatalf("../data is a folder of the project: %v", err)
	}
	l, err := load(t, "compose-subdir-build", "production")
	if err != nil {
		t.Fatal(err)
	}
	dir, _ := filepath.Abs("testdata/compose-subdir-build")
	if b := l.Builds[0]; b.Context != dir || b.Dockerfile != "deploy/Dockerfile" {
		t.Fatalf("the context is the project, from deploy/: %+v", b)
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
		"backup not stateful":  "db: {image: postgres, x-dockflow: {backup: {type: postgres}}}",
		"backup no type":       "db: {image: postgres, x-dockflow: {stateful: true, backup: {database: shop}}}",
		"backup unknown type":  "db: {image: postgres, x-dockflow: {stateful: true, backup: {type: oracle}}}",
		"backup dump volumes":  "db: {image: postgres, volumes: [\"d:/d\"], x-dockflow: {stateful: true, backup: {type: postgres, volumes: [d]}}}\nvolumes: {d: {}}",
		"backup no volume":     "db: {image: redis, x-dockflow: {stateful: true, backup: {type: volume}}}",
		"backup other volume":  "db: {image: redis, volumes: [\"d:/d\"], x-dockflow: {stateful: true, backup: {type: volume, volumes: [e]}}}\nvolumes: {d: {}}",
		"backup command half":  "db: {image: redis, x-dockflow: {stateful: true, backup: {type: command, dump: [cat]}}}",
		"backup quiesce":       "db: {image: redis, volumes: [\"d:/d\"], x-dockflow: {stateful: true, backup: {type: volume, quiesce: pause}}}\nvolumes: {d: {}}",
		"backup empty exec":    "db: {image: redis, volumes: [\"d:/d\"], x-dockflow: {stateful: true, backup: {type: volume, quiesce: {exec: {}}}}}\nvolumes: {d: {}}",
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
