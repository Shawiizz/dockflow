package state

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

func TestLockIsExclusive(t *testing.T) {
	s, err := Open(t.TempDir(), "r1")
	if err != nil {
		t.Fatal(err)
	}
	a, _ := s.App("shop-production")
	l, err := a.Lock(domain.LockInfo{Run: "r1", Op: "deploy", By: "me"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.Lock(domain.LockInfo{Run: "r2", Op: "deploy", By: "you"})
	if errs.ExitCode(err) != errs.ExitLocked || errs.CodeOf(err) != "lock.held" {
		t.Fatalf("want lock.held, got %v", err)
	}
	l.Release()
	l2, err := a.Lock(domain.LockInfo{Run: "r3", Op: "deploy", By: "me"})
	if err != nil {
		t.Fatalf("the lock must be free again: %v", err)
	}
	l2.Release()
}

func TestReleasesAndPrune(t *testing.T) {
	s, _ := Open(t.TempDir(), "r1")
	a, _ := s.App("shop-production")
	if env, err := a.Env(); env != nil || err != nil {
		t.Fatalf("no env yet: %v %v", env, err)
	}
	statuses := []string{
		domain.StatusSuperseded, domain.StatusRolledBack, domain.StatusSuperseded, domain.StatusFailed,
		domain.StatusSuperseded, domain.StatusActive, domain.StatusApplying,
	}
	for i, st := range statuses {
		if err := a.WriteRelease(&domain.Release{Seq: i + 1, Status: st, App: "shop"}); err != nil {
			t.Fatal(err)
		}
	}
	r, err := a.Release(4)
	if err != nil || r.Status != domain.StatusFailed || r.Schema != Schema {
		t.Fatalf("read back: %+v %v", r, err)
	}
	kept, deleted, err := a.Prune(2)
	if err != nil {
		t.Fatal(err)
	}
	var seqs []int
	for _, r := range kept {
		seqs = append(seqs, r.Seq)
	}
	if want := []int{5, 6, 7}; len(seqs) != 3 || seqs[0] != 5 || seqs[2] != 7 {
		t.Fatalf("kept %v, want %v", seqs, want)
	}
	if len(deleted) != 4 {
		t.Fatalf("deleted %d releases, want 4", len(deleted))
	}
	left, _ := a.Releases()
	if len(left) != 3 {
		t.Fatalf("files left: %v", left)
	}
	if err := a.WriteEnv(domain.EnvRecord{LastSeq: 7, Current: 6, Previous: 5}); err != nil {
		t.Fatal(err)
	}
	env, _ := a.Env()
	if env.Current != 6 || env.Schema != 1 {
		t.Fatalf("env: %+v", env)
	}
}

// The state is root's only, even when Docker created the directory as a bind source.
func TestRootIsPrivate(t *testing.T) {
	root := filepath.Join(t.TempDir(), "dockflow")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(root, "r1"); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(root); st.Mode().Perm() != 0o700 {
		t.Fatalf("the state directory is %o, want 700", st.Mode().Perm())
	}
}
