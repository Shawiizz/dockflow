package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func runCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out, errOut bytes.Buffer
	a := &app{stdout: &out, stderr: &errOut, stdin: os.Stdin, interrupts: make(chan struct{}, 2)}
	root := a.root()
	root.SetArgs(args)
	err := root.Execute()
	return out.String() + errOut.String(), err
}

func TestInit(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "My Shop")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("node_modules"), 0o644)
	os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM node:22\nEXPOSE 3000/tcp\n"), 0o644)
	if out, err := runCLI(t, "-C", dir, "init", "--ci", "github", "--domain", "shop.example.org"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	// what init writes is a valid project
	out, err := runCLI(t, "-C", dir, "--json", "validate", "production")
	if err != nil || !strings.Contains(strings.Join(strings.Fields(out), ""), `"valid":true`) {
		t.Fatalf("the project is valid: %v\n%s", err, out)
	}
	var cfg struct {
		App          string `yaml:"app"`
		Environments map[string]struct {
			Vars map[string]string `yaml:"vars"`
		} `yaml:"environments"`
	}
	b, _ := os.ReadFile(filepath.Join(dir, "dockflow.yml"))
	if err := yaml.Unmarshal(b, &cfg); err != nil || cfg.App != "my-shop" || cfg.Environments["production"].Vars["DOMAIN"] != "shop.example.org" {
		t.Fatalf("dockflow.yml: %v\n%s", err, b)
	}
	b, _ = os.ReadFile(filepath.Join(dir, "compose.yml"))
	if !strings.Contains(string(b), "build: .") || !strings.Contains(string(b), "port: 3000") {
		t.Fatalf("compose.yml builds the Dockerfile, on the port it exposes:\n%s", b)
	}
	if b, _ = os.ReadFile(filepath.Join(dir, ".gitignore")); string(b) != "node_modules\n.env.dockflow\n" {
		t.Fatalf(".gitignore: %q", b)
	}
	var wf struct {
		Jobs map[string]struct {
			If string `yaml:"if"`
		} `yaml:"jobs"`
	}
	b, _ = os.ReadFile(filepath.Join(dir, ".github/workflows/deploy.yml"))
	if err := yaml.Unmarshal(b, &wf); err != nil || wf.Jobs["deploy"].If != "github.ref_type == 'tag'" || wf.Jobs["build"].If == "" {
		t.Fatalf("the workflow: %v\n%s", err, b)
	}

	// a second run overwrites nothing
	if out, err := runCLI(t, "-C", dir, "init"); err == nil || !strings.Contains(err.Error(), "dockflow.yml exists already") {
		t.Fatalf("init refuses to overwrite: %v\n%s", err, out)
	}
	if out, err := runCLI(t, "-C", dir, "init", "--force", "--ci", "gitlab"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if b, _ = os.ReadFile(filepath.Join(dir, ".gitignore")); strings.Count(string(b), ".env.dockflow") != 1 {
		t.Fatalf(".gitignore gets one line: %q", b)
	}
	if b, err = os.ReadFile(filepath.Join(dir, ".gitlab-ci.yml")); err != nil || yaml.Unmarshal(b, &map[string]any{}) != nil {
		t.Fatalf("the GitLab workflow: %v\n%s", err, b)
	}
}

func TestInitStarterIsValid(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "hello")
	os.MkdirAll(dir, 0o755)
	if out, err := runCLI(t, "-C", dir, "init"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if out, err := runCLI(t, "-C", dir, "--json", "validate"); err != nil || !strings.Contains(strings.Join(strings.Fields(out), ""), `"valid":true`) {
		t.Fatalf("the starter project is valid: %v\n%s", err, out)
	}
	if out, err := runCLI(t, "-C", dir, "init", "--force", "--ci", "jenkins"); err == nil {
		t.Fatalf("--ci jenkins is refused:\n%s", out)
	}
}
