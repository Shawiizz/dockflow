package events

import (
	"bytes"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"
)

func TestEmitterNumbersAndMasks(t *testing.T) {
	var buf bytes.Buffer
	e := NewEmitter("run1", NewJSONSink(&buf), NewMasker("s3cr3t-value", "ab"))
	e.Info(Log, "the password is s3cr3t-value", map[string]string{"line": "s3cr3t-value and ab"})
	e.Warn(Warning, "second", nil)

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 lines, got %d", len(lines))
	}
	var first Event
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first.Seq != 1 || first.Run != "run1" || first.V != 1 {
		t.Fatalf("bad envelope: %+v", first)
	}
	if strings.Contains(first.Msg, "s3cr3t-value") || !strings.Contains(first.Msg, "***") {
		t.Fatalf("message not masked: %q", first.Msg)
	}
	if strings.Contains(string(first.Data), "s3cr3t-value") {
		t.Fatalf("data not masked: %s", first.Data)
	}
	// values shorter than 4 characters are not masked
	if !strings.Contains(string(first.Data), "ab") {
		t.Fatalf("short value masked: %s", first.Data)
	}
}

// A PEM key printed by a hook arrives one line per event: each of its lines is masked.
func TestMaskerMasksEachLineOfAMultiLineSecret(t *testing.T) {
	body := make([]byte, 300)
	for i := range body {
		body[i] = byte(i * 7)
	}
	key := string(pem.EncodeToMemory(&pem.Block{Type: "OPENSSH PRIVATE KEY", Bytes: body}))
	var c Collector
	e := NewEmitter("run1", &c, NewMasker(key))
	for _, line := range strings.Split(key, "\n") {
		e.Info(HookLog, "keygen │ "+line, map[string]string{"line": line})
	}
	var out strings.Builder
	for _, ev := range c.Events {
		out.WriteString(ev.Msg + "\n" + string(ev.Data) + "\n")
	}
	for _, line := range strings.Split(strings.TrimSpace(key), "\n") {
		if strings.Contains(out.String(), line) {
			t.Fatalf("line %q of the key not masked:\n%s", line, out.String())
		}
	}

	// re-indented, as config show's YAML prints it, or with CRLF line ends
	indented := "key: |-\n    " + strings.ReplaceAll(strings.TrimSpace(key), "\n", "\n    ")
	if got := e.Masker().Mask(indented); strings.Contains(got, "PRIVATE KEY") || strings.Count(got, "***") < 8 {
		t.Fatalf("indented key not masked:\n%s", got)
	}
	m := NewMasker("first-line-1\r\nsecond-line-2\r\n}")
	if got := m.Mask("first-line-1 second-line-2 }"); got != "*** *** }" {
		t.Fatalf("CRLF lines: %q", got)
	}
}

func TestMaskerMasksJSONEscapedForm(t *testing.T) {
	m := NewMasker(`pa"ss\word`)
	b, _ := json.Marshal(map[string]string{"v": `pa"ss\word`})
	if strings.Contains(m.Mask(string(b)), "word") {
		t.Fatalf("escaped form not masked: %s", m.Mask(string(b)))
	}
}
