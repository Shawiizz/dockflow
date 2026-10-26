package shell

import (
	"os/exec"
	"strings"
	"testing"
)

// A value is never read as shell syntax, whatever it holds.
func TestValuesStayValues(t *testing.T) {
	for _, v := range []string{"plain", "it's", `"; rm -rf / #`, "$(id)", "`id`", "a\nb", "$HOME", ""} {
		s := (&Script{}).Set("VALUE", v).Body(`printf '%s' "$VALUE"`)
		out, err := exec.Command("sh", "-c", s.String()).Output()
		if err != nil {
			t.Fatalf("%q: %v", v, err)
		}
		if string(out) != v {
			t.Fatalf("got %q, want %q", out, v)
		}
	}
}

func TestStrictMode(t *testing.T) {
	s := (&Script{}).Body("false\necho reached")
	out, err := exec.Command("sh", "-c", s.String()).CombinedOutput()
	if err == nil || strings.Contains(string(out), "reached") {
		t.Fatalf("a failing command must stop the script: %q", out)
	}
}
