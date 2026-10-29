package agent

import (
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/events"
)

// details names the environment variables of the services, never their values: a secret rotated
// since the deploy is known to no masker.
func TestDetailsLeavesEnvironmentValuesOut(t *testing.T) {
	h := newHarness(t)
	app := refApp("1")
	for i := range app.Services {
		app.Services[i].Spec.Env = append(app.Services[i].Spec.Env, "DB_PASSWORD=old-rotated-secret")
	}
	if res, _ := h.deploy(app, 0, ""); res == nil || res.Outcome != events.OutcomeSuccess {
		t.Fatalf("deploy: %+v", res)
	}
	sink := &memSink{}
	h.sink = sink
	if res, _ := h.do(Request{Op: OpDetails}, 0, ""); res == nil || res.Outcome != events.OutcomeSuccess {
		t.Fatalf("details: %+v", res)
	}
	results := sink.find(events.Result, `"services"`)
	if len(results) != 1 {
		t.Fatalf("want one result, got %d", len(results))
	}
	data := string(results[0].Data)
	if strings.Contains(data, "old-rotated-secret") || strings.Contains(data, "VERSION=1") {
		t.Fatalf("details holds environment values: %s", data)
	}
	if !strings.Contains(data, `"DB_PASSWORD=***"`) || !strings.Contains(data, `"VERSION=***"`) {
		t.Fatalf("details must name the variables: %s", data)
	}
	// the release record itself is untouched
	if cur := h.check("after details", false); !strings.Contains(strings.Join(cur.Desired.Services[0].Spec.Env, " "), "old-rotated-secret") {
		t.Fatalf("the release record changed: %v", cur.Desired.Services[0].Spec.Env)
	}
}
