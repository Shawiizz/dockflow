package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/version"
)

func project(t *testing.T, yml string, files ...string) *Raw {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(yml), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		os.MkdirAll(filepath.Dir(filepath.Join(dir, f)), 0o755)
		os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o644)
	}
	r, err := Read(dir)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func lookup(values map[string]string) Lookup {
	return func(k string) (string, bool) { v, ok := values[k]; return v, ok }
}

// An environment needs only its own variables: not those of other environments, nor those of
// the top-level keys it overrides.
func TestInterpolationIsPerEnvironment(t *testing.T) {
	r := project(t, `version: 1
app: shop
notify:
  - url: https://hooks.example.com/${TOP_ONLY}
environments:
  production:
    notify:
      - url: https://hooks.example.com/${PROD_HOOK}
  staging:
    server: { host: "${STAGING_HOST}", user: deploy, host_key: "SHA256:x" }
`)
	if _, err := r.Resolve("production", lookup(map[string]string{"PROD_HOOK": "p"})); err != nil {
		t.Fatalf("production must not need staging's or the overridden top-level variables: %v", err)
	}
	_, err := r.Resolve("staging", lookup(map[string]string{"TOP_ONLY": "t"}))
	if err == nil || !strings.Contains(err.Error(), "STAGING_HOST") {
		t.Fatalf("staging must still need its own variables, got %v", err)
	}
}

// Hook commands get values as environment variables (ADR-0022): $VAR stays for the shell.
func TestHookCommandsAreNotInterpolated(t *testing.T) {
	r := project(t, `version: 1
app: shop
hooks:
  before_deploy:
    - run: echo "$HOME ${DOCKFLOW_ENV}"
environments:
  production:
    hooks:
      after_deploy:
        - host: echo $USER
`)
	res, err := r.Resolve("production", lookup(map[string]string{}))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hooks) != 1 || res.Hooks[0].Command != `echo $USER` {
		t.Fatalf("hooks: %+v", res.Hooks)
	}
	res2, err := project(t, `version: 1
app: shop
hooks:
  before_deploy:
    - run: echo "$HOME ${DOCKFLOW_ENV}"
environments:
  production: {}
`).Resolve("production", lookup(map[string]string{}))
	if err != nil || res2.Hooks[0].Command != `echo "$HOME ${DOCKFLOW_ENV}"` {
		t.Fatalf("got %+v, %v", res2.Hooks, err)
	}
}

func TestUploadOwnerIsNumeric(t *testing.T) {
	r := project(t, `version: 1
app: shop
uploads:
  - { src: conf, dest: /etc/shop, owner: www-data }
environments:
  production: {}
`, "conf/a")
	if _, err := r.Resolve("production", lookup(nil)); err == nil || !strings.Contains(err.Error(), "numeric") {
		t.Fatalf("a named owner must be refused before the deploy, got %v", err)
	}
}

func TestMissingTemplateIsRefused(t *testing.T) {
	r := project(t, `version: 1
app: shop
templates: [config/app.conf]
environments:
  production: {}
`)
	if _, err := r.Resolve("production", lookup(nil)); err == nil || !strings.Contains(err.Error(), "config/app.conf") {
		t.Fatalf("a missing template must be refused, got %v", err)
	}
}

// A file for a newer Dockflow asks for an upgrade, before any key it adds is refused as unknown.
func TestNewerFileAsksForAnUpgrade(t *testing.T) {
	defer func(v string) { version.Version = v }(version.Version)
	version.Version = "1.2.0"
	cases := map[string]string{
		"format 2":           "version: 2\napp: shop\nkey_of_format_2: x\nenvironments: { production: {} }\n",
		"requires a minor":   "version: 1\nrequires: \"1.3\"\napp: shop\nkey_of_1_3: x\nenvironments: { production: {} }\n",
		"requires a release": "version: 1\nrequires: 1.2.1\napp: shop\nenvironments: { production: {} }\n",
	}
	for name, yml := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, FileName), []byte(yml), 0o644)
			_, err := Read(dir)
			if e, ok := errs.As(err); !ok || e.Code != "config.newer" || e.Exit != errs.ExitConfig {
				t.Fatalf("want config.newer, got %v", err)
			}
		})
	}
	for _, ok := range []string{"\"1.2\"", "1.1.0", "1.0.0-alpha.3"} {
		project(t, "version: 1\nrequires: "+ok+"\napp: shop\nenvironments: { production: {} }\n")
	}
	// a development build reads every file it can
	version.Version = "dev"
	project(t, "version: 1\nrequires: \"9.0\"\napp: shop\nenvironments: { production: {} }\n")
}

func TestVersionErrors(t *testing.T) {
	for name, yml := range map[string]string{
		"missing":      "app: shop\nenvironments: { production: {} }\n",
		"zero":         "version: 0\napp: shop\nenvironments: { production: {} }\n",
		"not a number": "version: one\napp: shop\nenvironments: { production: {} }\n",
		"bad requires": "version: 1\nrequires: \">=1.2\"\napp: shop\nenvironments: { production: {} }\n",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, FileName), []byte(yml), 0o644)
			_, err := Read(dir)
			if e, ok := errs.As(err); !ok || e.Code != "config.invalid" {
				t.Fatalf("want config.invalid, got %v", err)
			}
		})
	}
}
