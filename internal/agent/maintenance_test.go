//go:build linux

package agent

import (
	"slices"
	"testing"

	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/proxy"
	"github.com/Shawiizz/dockflow/internal/state"
)

// maintenanceOf returns the maintenance mode of every route the switch serves, failing when the
// routes disagree.
func (h *harness) maintenanceOf() *proxy.Maintenance {
	h.t.Helper()
	routes := h.w.served.Routes
	if len(routes) == 0 {
		h.t.Fatal("the switch serves no routes")
	}
	for _, rt := range routes[1:] {
		if (rt.Maintenance == nil) != (routes[0].Maintenance == nil) {
			h.t.Fatalf("the routes of one environment disagree on the maintenance mode")
		}
	}
	return routes[0].Maintenance
}

func TestMaintenance(t *testing.T) {
	h := newHarness(t)
	if res, _ := h.do(Request{Op: OpMaintenanceOn}, 0, ""); res.Outcome != events.OutcomeFailed || res.Error.Code != "maintenance.no_routes" {
		t.Fatalf("an environment without routes cannot be under maintenance: %+v", res)
	}
	if res, _ := h.deploy(refApp("1"), 0, ""); res.Outcome != events.OutcomeSuccess {
		t.Fatalf("the deploy failed: %+v", res.Error)
	}

	res, _ := h.do(Request{Op: OpMaintenanceOn, Maintenance: &proxy.Maintenance{Page: "<h1>soon</h1>", Allow: []string{"10.0.0.0/8"}}}, 0, "")
	if res.Outcome != events.OutcomeSuccess {
		t.Fatalf("maintenance on failed: %+v", res.Error)
	}
	m := h.maintenanceOf()
	if m == nil || m.Page != "<h1>soon</h1>" || !slices.Equal(m.Allow, []string{"10.0.0.0/8"}) || m.Since.IsZero() {
		t.Fatalf("the switch serves %+v", m)
	}

	// a deploy keeps it, and so does the recorded state the switch is rebuilt from
	if res, _ := h.deploy(refApp("2"), 0, ""); res.Outcome != events.OutcomeSuccess {
		t.Fatalf("the deploy failed: %+v", res.Error)
	}
	if m := h.maintenanceOf(); m == nil || m.Page != "<h1>soon</h1>" {
		t.Fatalf("the deploy ended the maintenance mode: %+v", m)
	}
	st, err := state.Open(h.root, "check")
	if err != nil {
		t.Fatal(err)
	}
	table, err := st.SwitchRoutes()
	if err != nil {
		t.Fatal(err)
	}
	if rs := table[testStack]; len(rs) == 0 || rs[0].Maintenance == nil {
		t.Fatal("the recorded routes lost the maintenance mode")
	}

	if res, _ := h.do(Request{Op: OpMaintenanceOff}, 0, ""); res.Outcome != events.OutcomeSuccess {
		t.Fatalf("maintenance off failed: %+v", res.Error)
	}
	if m := h.maintenanceOf(); m != nil {
		t.Fatalf("the switch still serves the maintenance page: %+v", m)
	}
	if res, _ := h.do(Request{Op: OpMaintenanceOff}, 0, ""); res.Outcome != events.OutcomeNoop {
		t.Fatalf("maintenance off of an open environment changes nothing: %+v", res)
	}
}

func TestMaintenanceRefusesALargePage(t *testing.T) {
	h := newHarness(t)
	h.deploy(refApp("1"), 0, "")
	big := make([]byte, proxy.MaxMaintenancePage+1)
	res, _ := h.do(Request{Op: OpMaintenanceOn, Maintenance: &proxy.Maintenance{Page: string(big)}}, 0, "")
	if res.Outcome != events.OutcomeFailed {
		t.Fatalf("a page larger than the limit is refused: %+v", res)
	}
	if h.maintenanceOf() != nil {
		t.Fatal("the refused page is served")
	}
}
