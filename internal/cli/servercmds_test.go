package cli

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAutoUpdates(t *testing.T) {
	root := t.TempDir()
	if got := autoUpdates(root); got != "unknown" {
		t.Fatalf("without apt: %s", got)
	}
	write := func(path, content string) {
		p := filepath.Join(root, path)
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(content), 0o644)
	}
	write("usr/bin/apt-get", "")
	if got := autoUpdates(root); got != "off" {
		t.Fatalf("without unattended-upgrades: %s", got)
	}
	write("usr/bin/unattended-upgrade", "")
	write("etc/apt/apt.conf.d/20auto-upgrades", "APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\n")
	if got := autoUpdates(root); got != "on" {
		t.Fatalf("Ubuntu's default: %s", got)
	}
	// a later file turns it off
	write("etc/apt/apt.conf.d/99local", "APT::Periodic::Unattended-Upgrade \"0\";\n")
	if got := autoUpdates(root); got != "off" {
		t.Fatalf("turned off by a later file: %s", got)
	}
}

func TestClockCheck(t *testing.T) {
	sent := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	received := sent.Add(5 * time.Second)
	if c := clockCheck(sent.Add(2*time.Second), sent, received); c.Level != "ok" {
		t.Fatalf("in sync: %+v", c)
	}
	if c := clockCheck(sent.Add(-3*time.Minute), sent, received); c.Level != "warn" || c.Detail != "3m0s off this machine's" {
		t.Fatalf("behind: %+v", c)
	}
	if c := clockCheck(received.Add(2*time.Minute), sent, received); c.Level != "warn" {
		t.Fatalf("ahead: %+v", c)
	}
	if clockCheck(time.Time{}, sent, received) != nil {
		t.Fatal("an older agent says no time")
	}
}
