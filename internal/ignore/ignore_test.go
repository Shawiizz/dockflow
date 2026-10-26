package ignore

import "testing"

func TestPatterns(t *testing.T) {
	p := New([]string{"*.md", "!README.md", "build/**/tmp", "/node_modules", "# comment"})
	cases := map[string]bool{
		"CHANGES.md": true, "README.md": false, "build/a/b/tmp": true, "build/a/b/tmp/x": true,
		"src/x.go": false, "node_modules/a/b.js": true,
	}
	for path, want := range cases {
		if got := p.Excludes(path); got != want {
			t.Errorf("%s: excluded %v, want %v", path, got, want)
		}
	}
	if !p.HasExceptions() {
		t.Error("!README.md is an exception")
	}
}
