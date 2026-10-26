package secrets

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLookupOrderAndScoping(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, LocalFile), []byte("# local\nDB_PASSWORD=local-db\nONLY_LOCAL='p$a ss'\nQUOTED=\"a\\nb\"\nPLAIN=v # comment\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	environ := []string{
		"PATH=/usr/bin",
		"PRODUCTION_API_KEY=scoped-from-process",
		`DOCKFLOW_SECRETS={"DB_PASSWORD":"ci-db","PRODUCTION_DB_PASSWORD":"ci-prod-db","STAGING_X":"x"}`,
	}
	s, err := Load("production", dir, environ)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"DB_PASSWORD": "ci-prod-db",          // scoped beats unscoped within the CI source
		"API_KEY":     "scoped-from-process", // process variable with the environment's prefix
		"ONLY_LOCAL":  "p$a ss",              // single quotes, no expansion
		"QUOTED":      "a\nb",
		"PLAIN":       "v",
	}
	for k, want := range cases {
		if got, ok := s.Lookup(k); !ok || got != want {
			t.Errorf("%s = %q, %v; want %q", k, got, ok, want)
		}
	}
	if _, ok := s.Lookup("PATH"); ok {
		t.Error("PATH must not be read from the process")
	}
	if v, ok := s.Lookup("STAGING_X"); !ok || v != "x" {
		t.Error("an unscoped DOCKFLOW_SECRETS key is visible as is")
	}
}

func TestInvalidJSON(t *testing.T) {
	if _, err := Load("production", t.TempDir(), []string{"DOCKFLOW_SECRETS=not json"}); err == nil {
		t.Fatal("want an error")
	}
}
