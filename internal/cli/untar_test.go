package cli

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

type entry struct {
	name, link, body string
	typ              byte
}

func archive(t *testing.T, entries ...entry) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Linkname: e.link, Typeflag: e.typ, Mode: 0o644, Size: int64(len(e.body))}
		if e.typ == tar.TypeDir {
			hdr.Mode = 0o755
		}
		if e.typ != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			tw.Write([]byte(e.body))
		}
	}
	tw.Close()
	return &buf
}

func empty(t *testing.T, dir string) {
	t.Helper()
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("something was written outside the destination: %v", ents)
	}
}

// cp from a container extracts what the container sends inside the destination only: symlinks
// that leave it are not created, and nothing is written through a symlink.
func TestUntarStaysInTheDestination(t *testing.T) {
	outside := t.TempDir()
	dest := filepath.Join(t.TempDir(), "d")
	skipped, err := untarTo(archive(t,
		entry{name: "d/", typ: tar.TypeDir},
		entry{name: "d/abs", link: outside, typ: tar.TypeSymlink},
		entry{name: "d/abs/pwn", body: "x", typ: tar.TypeReg},
		entry{name: "d/up", link: "../../" + filepath.Base(outside), typ: tar.TypeSymlink},
		entry{name: "d/sub/", typ: tar.TypeDir},
		entry{name: "d/sub/file", body: "inside", typ: tar.TypeReg},
		entry{name: "d/ok", link: "sub/file", typ: tar.TypeSymlink},
		entry{name: "d/through", link: "sub/target", typ: tar.TypeSymlink},
		entry{name: "d/through", body: "replaced", typ: tar.TypeReg},
	), dest)
	if err != nil {
		t.Fatal(err)
	}
	if len(skipped) != 2 {
		t.Fatalf("the two symlinks leaving the destination must be skipped: %v", skipped)
	}
	empty(t, outside)
	if b, err := os.ReadFile(filepath.Join(dest, "ok")); err != nil || string(b) != "inside" {
		t.Fatalf("a symlink inside the destination is kept: %q %v", b, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "abs", "pwn")); string(b) != "x" {
		t.Fatalf("abs/pwn must be a file of the destination: %q", b)
	}
	if st, err := os.Lstat(filepath.Join(dest, "through")); err != nil || !st.Mode().IsRegular() {
		t.Fatalf("a file replaces the symlink in its place: %v %v", st, err)
	}
	if _, err := os.Stat(filepath.Join(dest, "sub", "target")); err == nil {
		t.Fatal("a file was written through a symlink")
	}

	// a symlink that leaves the destination only once its parent, itself a symlink, is resolved
	dest2 := filepath.Join(t.TempDir(), "d")
	_, err = untarTo(archive(t,
		entry{name: "d/", typ: tar.TypeDir},
		entry{name: "d/self", link: ".", typ: tar.TypeSymlink},
		entry{name: "d/self/esc", link: "../" + filepath.Base(outside), typ: tar.TypeSymlink},
		entry{name: "d/esc/pwn", body: "x", typ: tar.TypeReg},
	), dest2)
	empty(t, outside)
	if err == nil {
		t.Fatal("writing through a symlink that leaves the destination must fail")
	}

	// paths outside the top entry
	for _, name := range []string{"d/../../x", "other/x"} {
		if _, err := untarTo(archive(t, entry{name: "d/", typ: tar.TypeDir}, entry{name: name, body: "x", typ: tar.TypeReg}),
			filepath.Join(t.TempDir(), "d")); err == nil {
			t.Fatalf("%s: a path outside the archive's root must be refused", name)
		}
	}

	// a single file lands at the destination's path
	file := filepath.Join(t.TempDir(), "copy.txt")
	if _, err := untarTo(archive(t, entry{name: "f.txt", body: "one", typ: tar.TypeReg}), file); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(file); string(b) != "one" {
		t.Fatalf("the file: %q", b)
	}
}
