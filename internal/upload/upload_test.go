package upload

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Shawiizz/dockflow/internal/ignore"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return "<missing>"
	}
	return string(b)
}

// stage puts every blob of a scanned source into the store, as the agent does with the payload.
func stage(t *testing.T, store Store, paths map[string]string) {
	t.Helper()
	for _, p := range paths {
		if _, err := store.Put(p); err != nil {
			t.Fatal(err)
		}
	}
}

func TestApplyMirrorAndRestore(t *testing.T) {
	src, dest, blobs := t.TempDir(), t.TempDir(), t.TempDir()
	store := Store(blobs)
	write(t, filepath.Join(src, "index.html"), "v2")
	write(t, filepath.Join(src, "assets", "app.js"), "js")
	write(t, filepath.Join(src, ".git", "HEAD"), "x")
	write(t, filepath.Join(dest, "index.html"), "v1")
	write(t, filepath.Join(dest, "old", "gone.html"), "old")

	m, paths, err := Scan(src, ignore.New([]string{".git"}))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Files[".git/HEAD"]; ok {
		t.Fatal("excluded files must not be in the manifest")
	}
	stage(t, store, paths)
	before, err := Apply(dest, m, store, Options{Mirror: true, UID: -1, GID: -1})
	if err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dest, "index.html")) != "v2" || read(t, filepath.Join(dest, "assets", "app.js")) != "js" {
		t.Fatal("the destination must match the source")
	}
	if read(t, filepath.Join(dest, "old", "gone.html")) != "<missing>" {
		t.Fatal("mirror must delete what the source does not have")
	}
	if _, err := os.Stat(filepath.Join(dest, "old")); err == nil {
		t.Fatal("mirror must delete emptied directories")
	}

	// restoring puts back exactly what was there
	if _, err := Apply(dest, before, store, Options{UID: -1, GID: -1}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dest, "index.html")) != "v1" || read(t, filepath.Join(dest, "old", "gone.html")) != "old" {
		t.Fatal("the restore must bring the previous files back")
	}
	if read(t, filepath.Join(dest, "assets", "app.js")) != "<missing>" {
		t.Fatal("the restore must remove the files the upload created")
	}
}

func TestSingleFileAndDigest(t *testing.T) {
	src, dir, blobs := t.TempDir(), t.TempDir(), t.TempDir()
	write(t, filepath.Join(src, "app.service"), "[Unit]")
	m, paths, err := Scan(filepath.Join(src, "app.service"), nil)
	if err != nil {
		t.Fatal(err)
	}
	stage(t, Store(blobs), paths)
	target := filepath.Join(dir, "etc", "app.service")
	if _, err := Apply(target, m, Store(blobs), Options{Mode: 0o640, UID: -1, GID: -1}); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(target)
	if read(t, target) != "[Unit]" || st.Mode().Perm() != 0o640 {
		t.Fatalf("got %q, mode %v", read(t, target), st.Mode().Perm())
	}
	again, _, _ := Scan(filepath.Join(src, "app.service"), nil)
	if again.Digest() != m.Digest() {
		t.Fatal("the same content must have the same digest")
	}
}
