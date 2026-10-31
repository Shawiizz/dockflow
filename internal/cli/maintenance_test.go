package cli

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/proxy"
)

func TestMaintenanceOf(t *testing.T) {
	m, err := maintenanceOf("", []string{"203.0.113.7", " 10.0.0.0/8", "2001:db8::/32"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(m.Allow, []string{"203.0.113.7", "10.0.0.0/8", "2001:db8::/32"}) || m.Page != "" {
		t.Fatalf("got %+v", m)
	}
	if _, err := maintenanceOf("", []string{"office"}); err == nil {
		t.Fatal("a name is not an address")
	}

	dir := t.TempDir()
	page := filepath.Join(dir, "page.html")
	os.WriteFile(page, []byte("<h1>Back soon</h1>"), 0o644)
	if m, err := maintenanceOf(page, nil); err != nil || m.Page != "<h1>Back soon</h1>" {
		t.Fatalf("got %+v, %v", m, err)
	}
	big := filepath.Join(dir, "big.html")
	os.WriteFile(big, []byte(strings.Repeat("x", proxy.MaxMaintenancePage+1)), 0o644)
	if _, err := maintenanceOf(big, nil); err == nil {
		t.Fatal("a page larger than the limit is refused")
	}
	if _, err := maintenanceOf(filepath.Join(dir, "missing.html"), nil); err == nil {
		t.Fatal("a missing page is refused")
	}
}
