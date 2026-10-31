package project

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/errs"
)

func TestStartIntervalNeedsStartPeriod(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte("version: 1\napp: refused\nenvironments:\n  production: {}\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "compose.yml"), []byte("services:\n  app:\n    image: alpine:3\n    healthcheck:\n      test: [\"CMD\", \"true\"]\n      start_interval: 1s\n"), 0o644)
	_, err := Load(context.Background(), Options{Dir: dir, Env: "production", Git: Git{SHA: "0123456789abcdef", Branch: "main"}})
	if e, ok := errs.As(err); !ok || e.Code != "config.invalid" || !strings.Contains(e.Message, "start_period") {
		t.Fatalf("got %v, want a config.invalid error at plan time, as Docker refuses it", err)
	}
}

// TestRefusedComposeKeys checks that each Compose key Dockflow does not support is refused at
// plan time with a configuration error, rather than ignored. A key that becomes supported fails
// here: it must then be added to the conformance files of the e2e tests (test/e2e/conformance_test.go).
func TestRefusedComposeKeys(t *testing.T) {
	for key, value := range map[string]string{
		"blkio_config":        "{weight: 300}",
		"cpu_count":           "2",
		"cpu_percent":         "50",
		"cpu_rt_period":       "1000",
		"cpu_rt_runtime":      "100",
		"device_cgroup_rules": `["c 1:3 mr"]`,
		"mac_address":         "02:42:ac:11:65:43",
		"external_links":      "[other]",
		"post_start":          `[{command: ["true"]}]`,
		"pre_stop":            `[{command: ["true"]}]`,
		"credential_spec":     "{file: spec.json}",
		"isolation":           "default",
		"use_api_socket":      "true",
		"provider":            "{type: model}",
		"volumes_from":        "[other]",
		"network_mode":        `"service:other"`,
		"links":               `["other:alias"]`,
	} {
		t.Run(key, func(t *testing.T) {
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, "dockflow.yml"), []byte("version: 1\napp: refused\nenvironments:\n  production: {}\n"), 0o644)
			compose := "services:\n  app:\n    image: alpine:3\n    " + key + ": " + value + "\n  other:\n    image: alpine:3\n"
			os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(compose), 0o644)
			_, err := Load(context.Background(), Options{Dir: dir, Env: "production", Git: Git{SHA: "0123456789abcdef", Branch: "main"}})
			e, ok := errs.As(err)
			if !ok || e.Code != "config.invalid" || !strings.Contains(e.Message, strings.Split(key, "_")[0]) {
				t.Fatalf("%s: %v, want a config.invalid error naming it", key, err)
			}
		})
	}
}
