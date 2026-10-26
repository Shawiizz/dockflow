// Package testutil holds helpers shared by tests.
package testutil

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var update = flag.Bool("update", false, "rewrite golden files")

// Golden compares v, encoded as indented JSON, with testdata/<name>.golden.json. With -update,
// it rewrites the file instead.
func Golden(t *testing.T, name string, v any) {
	t.Helper()
	got, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	compare(t, filepath.Join("testdata", name+".golden.json"), append(got, '\n'))
}

// GoldenText compares text with testdata/<file>, as Golden does.
func GoldenText(t *testing.T, file, text string) {
	t.Helper()
	compare(t, filepath.Join("testdata", file), []byte(text))
}

func compare(t *testing.T, path string, got []byte) {
	t.Helper()
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run the tests with -update to create it)", err)
	}
	if string(got) != string(want) {
		t.Errorf("%s differs from the golden file; run with -update after checking the diff\n--- got\n%s", path, got)
	}
}
