package state

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// BackupRun is backup.json: what a backup or a restore changed in the app environment that must
// not outlive it (state-v1.md). The run writes it before it stops a service, quiesces it, or
// replaces its volumes, and removes it once the service runs as before; the next run that takes
// the lock, or the watchdog once the agent is gone, finishes what it records.
type BackupRun struct {
	Schema  int    `json:"schema"`
	Run     string `json:"run"`
	Op      string `json:"op"`
	Service string `json:"service"`
	// Quiesce is stop when the run stopped Containers, exec when it ran the quiesce pre command
	// in Containers[0], and empty when it changed neither.
	Quiesce    string   `json:"quiesce,omitempty"`
	Containers []string `json:"containers,omitempty"`
	// Volumes are those a restore replaces, each with the staging volume that holds the
	// snapshot's files.
	Volumes []RestoreVolume `json:"volumes,omitempty"`
	// Copying tells that the restore may have begun to replace Volumes: they are replaced again,
	// from the staging volumes, before the service starts.
	Copying bool      `json:"copying,omitempty"`
	Since   time.Time `json:"since"`
}

// RestoreVolume is a volume, or a bind mount, that a restore replaces.
type RestoreVolume struct {
	// Type is volume or bind, and Source the volume's name or the bind's path on the server.
	Type    string `json:"type"`
	Source  string `json:"source"`
	Staging string `json:"staging"`
}

func (a *App) backupRunPath() string { return filepath.Join(a.dir, "backup.json") }

// BackupRun reads backup.json; nil when no backup or restore left anything to finish.
func (a *App) BackupRun() (*BackupRun, error) {
	var v BackupRun
	ok, err := a.s.readJSON(a.backupRunPath(), &v)
	if !ok || err != nil {
		return nil, err
	}
	return &v, nil
}

// SetBackupRun writes backup.json.
func (a *App) SetBackupRun(v BackupRun) error {
	v.Schema = Schema
	return a.s.writeJSON(a.backupRunPath(), v, false)
}

// ClearBackupRun removes backup.json.
func (a *App) ClearBackupRun() error {
	return a.s.remove(a.backupRunPath())
}

// remove deletes path; a missing file is not an error.
func (s *Store) remove(path string) error {
	rm := func() error {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return ioErr("remove "+path, err)
		}
		return nil
	}
	if s.Faults != nil {
		return s.Faults(path, rm)
	}
	return rm()
}

// WriteFile writes b to path, under the store's root, atomically: to a temporary file, synced,
// then renamed.
func (s *Store) WriteFile(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return ioErr("create "+filepath.Dir(path), err)
	}
	if s.Faults != nil {
		return s.Faults(path, func() error { return s.put(path, b) })
	}
	return s.put(path, b)
}
