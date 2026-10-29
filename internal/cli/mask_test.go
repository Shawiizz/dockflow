package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// runMain runs the command line as Main does, errors reported, and returns its output.
func runMain(t *testing.T, stdin *os.File, args ...string) (string, int) {
	t.Helper()
	var out bytes.Buffer
	if stdin == nil {
		stdin = os.Stdin
	}
	a := &app{stdout: &out, stderr: &out, stdin: stdin, interrupts: make(chan struct{}, 2)}
	root := a.root()
	root.SetArgs(args)
	code := a.exitCode(root.Execute())
	return out.String(), code
}

func writeProject(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

const maskProject = "version: 1\napp: shop\nenvironments:\n  production: {}\n"

// Secrets are masked from the moment they are read: an error of the Compose file that quotes an
// interpolated value does not show it.
func TestLoadErrorsMaskSecrets(t *testing.T) {
	const secret = "s3cr3t-port-value"
	dir := writeProject(t, map[string]string{
		"dockflow.yml":  maskProject,
		"compose.yml":   "services:\n  web:\n    image: nginx\n    ports:\n      - \"${WEB_PORT}:80\"\n",
		".env.dockflow": "WEB_PORT=" + secret + "\n",
	})
	for _, args := range [][]string{{"validate", "production"}, {"--json", "validate", "production"}} {
		out, code := runMain(t, nil, append([]string{"-C", dir}, args...)...)
		if code == 0 {
			t.Fatalf("%v: the invalid port was accepted:\n%s", args, out)
		}
		if strings.Contains(out, secret) || !strings.Contains(out, "***") {
			t.Fatalf("%v: the secret is not masked:\n%s", args, out)
		}
	}
}

// config show masks each line of a multi-line secret, however YAML lays it out.
func TestConfigShowMasksMultiLineSecrets(t *testing.T) {
	lines := []string{"-----BEGIN TEST KEY-----", "c2VjcmV0LWxpbmUtb25lLW9mLXRoZS1rZXk=", "c2Vjb25kLWxpbmUtb2YtdGhlLWtleSAg  ", "-----END TEST KEY-----"}
	dir := writeProject(t, map[string]string{
		"dockflow.yml":  maskProject,
		"compose.yml":   "services:\n  web:\n    image: nginx\n    environment:\n      KEY: ${KEY}\n",
		".env.dockflow": `KEY="` + strings.Join(lines, `\n`) + `"` + "\n",
	})
	for _, args := range [][]string{{"config", "show", "production"}, {"--json", "config", "show", "production"}} {
		out, code := runMain(t, nil, append([]string{"-C", dir}, args...)...)
		if code != 0 {
			t.Fatalf("%v: exit code %d:\n%s", args, code, out)
		}
		for _, l := range lines {
			if strings.Contains(out, strings.TrimSpace(l)) {
				t.Fatalf("%v: %q shown:\n%s", args, l, out)
			}
		}
	}
}
