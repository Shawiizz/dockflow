package state

import (
	"path/filepath"
	"time"
)

// WatchdogRestart is one restart the watchdog made (ADR-0010).
type WatchdogRestart struct {
	Service   string    `json:"service"`
	Container string    `json:"container"`
	At        time.Time `json:"at"`
	// Reason is unhealthy, or boot for a container started again after a reboot.
	Reason string `json:"reason"`
}

// Watchdog is watchdog.json: the watchdog's most recent restarts in the app environment.
type Watchdog struct {
	Schema   int               `json:"schema"`
	Restarts []WatchdogRestart `json:"restarts"`
}

// keepRestarts is how many restarts watchdog.json keeps.
const keepRestarts = 20

// Watchdog reads watchdog.json; empty when the watchdog never restarted anything.
func (a *App) Watchdog() (*Watchdog, error) {
	var w Watchdog
	if _, err := a.s.readJSON(filepath.Join(a.dir, "watchdog.json"), &w); err != nil {
		return nil, err
	}
	return &w, nil
}

// AddWatchdogRestart records a restart, keeping the most recent ones.
func (a *App) AddWatchdogRestart(r WatchdogRestart) error {
	w, err := a.Watchdog()
	if err != nil {
		return err
	}
	w.Schema = Schema
	w.Restarts = append(w.Restarts, r)
	if n := len(w.Restarts); n > keepRestarts {
		w.Restarts = w.Restarts[n-keepRestarts:]
	}
	return a.s.writeJSON(filepath.Join(a.dir, "watchdog.json"), w, false)
}
