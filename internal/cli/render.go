package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/events"
)

// human renders events for a terminal.
type human struct {
	mu      sync.Mutex
	w       io.Writer
	verbose bool
	color   bool
}

func (h *human) paint(code, s string) string {
	if !h.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (h *human) Emit(e events.Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if e.Level == events.Debug && !h.verbose {
		return
	}
	switch e.Type {
	case events.RunStarted, events.LockAcquired, events.LockReleased, events.ActionFinished, events.Result, events.RunFinished:
		if !h.verbose {
			return
		}
	case events.PlanComputed:
		var p domain.Plan
		_ = json.Unmarshal(e.Data, &p)
		fmt.Fprintf(h.w, "%s %s\n", h.paint("1", "Plan:"), e.Msg)
		for _, a := range p.Actions {
			sym := map[string]string{
				domain.ActionCreateService: h.paint("32", "+"), domain.ActionUpdateService: h.paint("33", "~"),
				domain.ActionRemoveService: h.paint("31", "-"),
			}[a.Kind]
			if sym == "" {
				sym = "·"
			}
			strategy := ""
			if a.Strategy != "" {
				strategy = h.paint("2", " ["+string(a.Strategy)+"]")
			}
			fmt.Fprintf(h.w, "  %s %s %s%s: %s\n", sym, a.Kind, a.Target, strategy, a.Reason)
		}
		if len(p.Unchanged) > 0 {
			fmt.Fprintf(h.w, "  %s\n", h.paint("2", "unchanged: "+strings.Join(p.Unchanged, ", ")))
		}
		return
	case events.PlanEmpty:
		fmt.Fprintln(h.w, h.paint("32", "Nothing to change."))
		return
	}
	if e.Type == events.BuildLog {
		fmt.Fprintln(h.w, h.paint("2", "  │ "+e.Msg))
		return
	}
	prefix := "  "
	switch e.Level {
	case events.Warn:
		prefix = h.paint("33", "! ")
	case events.Error:
		prefix = h.paint("31", "✗ ")
	}
	switch e.Type {
	case events.ServiceHealthy, events.SwitchChanged:
		prefix = h.paint("32", "✓ ")
	case events.ReleaseCreated:
		prefix = h.paint("1", "→ ")
	}
	fmt.Fprintf(h.w, "%s%s\n", prefix, e.Msg)
}

// finish prints the outcome of a run.
func (h *human) finish(res events.RunFinishedData) {
	d := (time.Duration(res.DurationMS) * time.Millisecond).Round(100 * time.Millisecond)
	switch res.Outcome {
	case events.OutcomeSuccess:
		if res.ReleaseSeq > 0 {
			fmt.Fprintf(h.w, "%s release %d is live (%s)\n", h.paint("32", "✓"), res.ReleaseSeq, d)
		}
	case events.OutcomeNoop:
	case events.OutcomeRolledBack:
		fmt.Fprintf(h.w, "%s the deploy failed and was rolled back: the previous release is running\n", h.paint("31", "✗"))
	case events.OutcomeCancelled:
		fmt.Fprintf(h.w, "%s cancelled: the previous release is running\n", h.paint("33", "!"))
	}
}
