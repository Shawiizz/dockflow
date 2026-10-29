package render

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareRendersInACopy(t *testing.T) {
	project := t.TempDir()
	write(t, filepath.Join(project, "docs", "page.mdx"), "Install {{ VERSION }}{% if BETA == 'yes' %} (beta){% endif %}\n")
	write(t, filepath.Join(project, "docs", "app.ts"), "unchanged\n")
	write(t, filepath.Join(project, "docs", "node_modules", "big", "index.js"), "x")
	write(t, filepath.Join(project, "docs", ".dockerignore"), "node_modules\n**/*.log\n")
	write(t, filepath.Join(project, "docs", "debug.log"), "x")
	write(t, filepath.Join(project, "deploy", "app.conf.tpl"), "{% raw %}{{ not jinja }}{% endraw %} {{ DOMAIN }}")

	w, err := Prepare(project, []Template{
		{Src: "docs/page.mdx", Dest: "docs/page.mdx"},
		{Src: "deploy/app.conf.tpl", Dest: "deploy/app.conf"},
	}, map[string]string{"VERSION": "2.0.0", "BETA": "yes", "DOMAIN": "example.com"}, []string{filepath.Join(project, "docs")})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	ctx := w.Path(filepath.Join(project, "docs"))
	if ctx == filepath.Join(project, "docs") {
		t.Fatal("the build context must be a copy")
	}
	got, _ := os.ReadFile(filepath.Join(ctx, "page.mdx"))
	if string(got) != "Install 2.0.0 (beta)\n" {
		t.Fatalf("rendered %q", got)
	}
	if b, _ := os.ReadFile(filepath.Join(ctx, "app.ts")); string(b) != "unchanged\n" {
		t.Fatalf("other files must be copied: %q", b)
	}
	for _, ignored := range []string{"node_modules", "debug.log"} {
		if _, err := os.Stat(filepath.Join(ctx, ignored)); err == nil {
			t.Fatalf("%s is excluded by .dockerignore and must not be copied", ignored)
		}
	}
	if _, err := os.Stat(filepath.Join(ctx, ".dockerignore")); err != nil {
		t.Fatal("the .dockerignore itself is part of the context")
	}
	conf, _ := os.ReadFile(w.Path(filepath.Join(project, "deploy", "app.conf")))
	if string(conf) != "{{ not jinja }} example.com" {
		t.Fatalf("rendered %q", conf)
	}
	// the source tree is untouched, hard links or not
	src, _ := os.ReadFile(filepath.Join(project, "docs", "page.mdx"))
	if !strings.Contains(string(src), "{{ VERSION }}") {
		t.Fatalf("the source was modified: %q", src)
	}
	if _, err := os.Stat(filepath.Join(project, "deploy", "app.conf")); err == nil {
		t.Fatal("nothing may be written in the project")
	}
}

func TestUndefinedVariableIsAnError(t *testing.T) {
	project := t.TempDir()
	write(t, filepath.Join(project, "a.txt"), "{{ MISSING }}")
	_, err := Prepare(project, []Template{{Src: "a.txt", Dest: "a.txt"}}, map[string]string{}, nil)
	if err == nil || !strings.Contains(err.Error(), "a.txt") {
		t.Fatalf("want an error naming the template, got %v", err)
	}
}

// shquote makes any value one shell word, for host commands.
func TestShquote(t *testing.T) {
	got, err := String("systemctl restart {{ name | shquote }}", map[string]any{"name": "a'b; rm -rf /"})
	if err != nil {
		t.Fatal(err)
	}
	if want := `systemctl restart 'a'\''b; rm -rf /'`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
