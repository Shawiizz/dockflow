package filter

import (
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/domain"
)

// What the rules do is tested end to end (test/e2e, TestPortFilter): a port is reachable or not.
// Here, only what Rules refuses.
func TestRulesRefuseInvalidPorts(t *testing.T) {
	for _, bad := range []Allow{
		{PublicPort: domain.PublicPort{Port: 70000}, Why: "app-x"},
		{PublicPort: domain.PublicPort{Port: 1, Protocol: "sctp"}, Why: "app-x"},
		{PublicPort: domain.PublicPort{Port: 1, From: []string{"nope"}}, Why: "app-x"},
	} {
		if _, err := Rules([]Allow{bad}, 4); err == nil || !strings.Contains(err.Error(), "app-x") {
			t.Fatalf("%+v must be refused, naming its app: %v", bad, err)
		}
	}
}
