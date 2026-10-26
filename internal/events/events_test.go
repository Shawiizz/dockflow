package events

import (
	"bytes"
	"encoding/json"
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

func TestMaskerMasksJSONEscapedForm(t *testing.T) {
	m := NewMasker(`pa"ss\word`)
	b, _ := json.Marshal(map[string]string{"v": `pa"ss\word`})
	if strings.Contains(m.Mask(string(b)), "word") {
		t.Fatalf("escaped form not masked: %s", m.Mask(string(b)))
	}
}
