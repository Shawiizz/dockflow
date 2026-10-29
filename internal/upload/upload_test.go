package upload

import (
	"os"
	"path/filepath"
	"strings"
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

// A container that writes to a destination can swap a directory of it for a symbolic link to
// anywhere: Apply writes, saves and deletes inside the destination only.
func TestApplyDoesNotFollowSymlinksOut(t *testing.T) {
	src, dest, blobs, outside := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	store := Store(blobs)
	write(t, filepath.Join(src, "conf", "app.conf"), "new")
	write(t, filepath.Join(src, "conf", "gone.conf"), "x")
	m, paths, err := Scan(src, nil)
	if err != nil {
		t.Fatal(err)
	}
	stage(t, store, paths)
	write(t, filepath.Join(outside, "app.conf"), "secret")
	write(t, filepath.Join(outside, "other"), "keep")
	if err := os.Symlink(outside, filepath.Join(dest, "conf")); err != nil {
		t.Fatal(err)
	}

	if _, err := Apply(dest, m, store, Options{Mirror: true, UID: -1, GID: -1}); err == nil {
		t.Fatal("a directory swapped for a link out of the destination must be an error")
	}
	if read(t, filepath.Join(outside, "app.conf")) != "secret" || read(t, filepath.Join(outside, "other")) != "keep" {
		t.Fatal("nothing outside the destination may be written or deleted")
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 2 {
		t.Fatalf("nothing may be created outside the destination: %v", entries)
	}

	// deleting through the link
	absent := &Manifest{Files: map[string]File{}, Absent: []string{"conf/other"}}
	if _, err := Apply(dest, absent, store, Options{UID: -1, GID: -1}); err == nil {
		t.Fatal("deleting through a link out of the destination must be an error")
	}
	if read(t, filepath.Join(outside, "other")) != "keep" {
		t.Fatal("a file outside the destination must not be deleted")
	}

	// the destination itself swapped for a link
	parent := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(parent, "site")); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(filepath.Join(parent, "site"), m, store, Options{UID: -1, GID: -1}); err == nil {
		t.Fatal("a destination swapped for a link out of its parent must be an error")
	}
	if read(t, filepath.Join(outside, "app.conf")) != "secret" {
		t.Fatal("nothing outside the destination may be written")
	}

	// a single file whose name is a link: replaced, never written through
	single, _, _ := Scan(filepath.Join(src, "conf", "app.conf"), nil)
	link := filepath.Join(parent, "app.conf")
	if err := os.Symlink(filepath.Join(outside, "app.conf"), link); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(link, single, store, Options{UID: -1, GID: -1}); err == nil {
		t.Fatal("a single file that is a link must be an error")
	}
	if read(t, filepath.Join(outside, "app.conf")) != "secret" {
		t.Fatal("a file outside the destination must not be written through a link")
	}
}

func TestManifestPathsStayInside(t *testing.T) {
	sum := strings.Repeat("ab", 32)
	for _, bad := range []*Manifest{
		{Files: map[string]File{"../x": {SHA256: sum}}},
		{Files: map[string]File{"/etc/passwd": {SHA256: sum}}},
		{Files: map[string]File{"a/../../x": {SHA256: sum}}},
		{Files: map[string]File{"": {SHA256: sum}}},
		{Files: map[string]File{"a": {SHA256: "../../etc/shadow"}}},
		{Files: map[string]File{}, Dirs: []string{".."}},
		{Files: map[string]File{}, Absent: []string{"a/./b"}},
		{Single: true, Files: map[string]File{"x": {SHA256: sum}}},
	} {
		if err := bad.Validate(); err == nil {
			t.Errorf("%+v must be refused", bad)
		}
		if _, err := Apply(t.TempDir(), bad, Store(t.TempDir()), Options{UID: -1, GID: -1}); err == nil {
			t.Errorf("Apply must refuse %+v", bad)
		}
	}
	if err := (&Manifest{Files: map[string]File{"a/b.txt": {SHA256: sum}}, Dirs: []string{"a"}}).Validate(); err != nil {
		t.Fatal(err)
	}
}
