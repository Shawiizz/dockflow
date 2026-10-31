package compose

import (
	"strings"
	"testing"
)

func TestWalkNestedKeys(t *testing.T) {
	for name, c := range map[string]struct {
		key   string
		value any
		err   string
		warn  string
	}{
		"handled":             {key: "volumes", value: []any{map[string]any{"type": "tmpfs", "target": "/x", "tmpfs": map[string]any{"size": 1.0, "mode": 1023.0}}}},
		"unknown sub-key":     {key: "volumes", value: []any{map[string]any{"type": "volume", "volume": map[string]any{"labels": map[string]any{"a": "b"}}}}, err: "volumes.volume.labels"},
		"network entry":       {key: "networks", value: map[string]any{"front": map[string]any{"priority": 10.0, "future_key": "x"}}, err: "networks.<name>.future_key"},
		"data is not keys":    {key: "deploy", value: map[string]any{"resources": map[string]any{"limits": map[string]any{"memory": "1m"}}}},
		"ignored":             {key: "deploy", value: map[string]any{"restart_policy": map[string]any{"condition": "any", "delay": "5s"}}, warn: "deploy.restart_policy.delay is ignored"},
		"zero values pass":    {key: "deploy", value: map[string]any{"labels": map[string]any{}}},
		"depends on":          {key: "depends_on", value: map[string]any{"db": map[string]any{"condition": "service_started", "required": true, "restart": true}}, warn: "depends_on.<name>.restart is ignored"},
		"depends on, unknown": {key: "depends_on", value: map[string]any{"db": map[string]any{"wait": true}}, err: "depends_on.<name>.wait"},
		"map of names data":   {key: "ulimits", value: map[string]any{"nofile": map[string]any{"soft": 1.0, "hard": 2.0}}},
	} {
		t.Run(name, func(t *testing.T) {
			var warnings []string
			err := walk("service app", c.key, c.value, &warnings)
			switch {
			case c.err == "" && err != nil:
				t.Fatalf("refused: %v", err)
			case c.err != "" && (err == nil || !strings.Contains(err.Error(), "`"+c.err+"`")):
				t.Fatalf("got %v, want a refusal of %s", err, c.err)
			case c.warn != "" && (len(warnings) != 1 || !strings.Contains(warnings[0], c.warn)):
				t.Fatalf("got warnings %v, want %s", warnings, c.warn)
			}
		})
	}
}

func TestNestedKeysAreKnownToCompose(t *testing.T) {
	// a path in the table whose parent is no key, such as a typo, would never be walked
	for _, k := range NestedKeys() {
		root := strings.SplitN(strings.TrimPrefix(strings.TrimPrefix(k, "(networks).*."), "(volumes).*."), ".", 2)[0]
		root = strings.TrimSuffix(root, "[]")
		if strings.HasPrefix(k, "(") {
			continue
		}
		if !supported[root] {
			t.Errorf("%s is under %s, which is no supported key", k, root)
		}
	}
}
