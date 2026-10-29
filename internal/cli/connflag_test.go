package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/connection"
)

const testKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAMwAAAAtzc2gtZWQyNTUxOQAAACBdeploykey01\n-----END OPENSSH PRIVATE KEY-----\n"

// --connection reads the string from a file or standard input, or as given with a warning, and
// masks it and the key it holds, line by line.
func TestConnectionFlag(t *testing.T) {
	cs := connection.ConnString{Servers: []connection.Server{{Host: "203.0.113.10"}}, PrivateKey: testKey}.Encode()
	file := filepath.Join(t.TempDir(), "conn")
	if err := os.WriteFile(file, []byte(cs+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdin := filepath.Join(t.TempDir(), "stdin")
	if err := os.WriteFile(stdin, []byte(cs+"\nthe rest of the input\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		flag    string
		warning bool
	}{{"@" + file, false}, {"-", false}, {cs, true}} {
		in, err := os.Open(stdin)
		if err != nil {
			t.Fatal(err)
		}
		var out, errOut bytes.Buffer
		a := &app{stdout: &out, stderr: &errOut, stdin: in, interrupts: make(chan struct{}, 2)}
		root := a.root()
		root.SetArgs([]string{"--connection", c.flag, "version"})
		if err := root.Execute(); err != nil {
			t.Fatalf("%.10s: %v", c.flag, err)
		}
		if a.connection != cs {
			t.Fatalf("%.10s: read %q", c.flag, a.connection)
		}
		if got := strings.Contains(errOut.String(), "command line"); got != c.warning {
			t.Fatalf("%.10s: warning %v: %q", c.flag, got, errOut.String())
		}
		for _, s := range append([]string{cs}, strings.Split(strings.TrimSpace(testKey), "\n")...) {
			if got := a.mask("x " + s + " x"); got != "x *** x" {
				t.Fatalf("%.10s: %q not masked: %q", c.flag, s, got)
			}
		}
		if c.flag == "-" {
			// one line read, the rest left for the command
			rest := make([]byte, 64)
			n, _ := in.Read(rest)
			if string(rest[:n]) != "the rest of the input\n" {
				t.Fatalf("stdin consumed: %q", rest[:n])
			}
		}
		in.Close()
	}

	if out, code := runMain(t, nil, "--connection", "@"+filepath.Join(t.TempDir(), "missing"), "version"); code != 2 {
		t.Fatalf("a missing file: exit %d: %s", code, out)
	}
}
