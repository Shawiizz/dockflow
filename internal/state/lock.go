//go:build unix

package state

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Lock is a held environment lock. The kernel releases it when the process dies.
type Lock struct {
	f *os.File
}

// Lock takes the environment's lock without waiting. When another run holds it, the error has
// the code lock.held and exit code 5, and names the holder from lock.json.
func (a *App) Lock(info domain.LockInfo) (*Lock, error) {
	f, err := os.OpenFile(filepath.Join(a.dir, "lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, ioErr("open the lock", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, a.heldErr()
		}
		return nil, ioErr("take the lock", err)
	}
	info.Schema = Schema
	if info.Since.IsZero() {
		info.Since = time.Now().UTC()
	}
	if err := a.s.writeJSON(filepath.Join(a.dir, "lock.json"), info, false); err != nil {
		f.Close()
		return nil, err
	}
	return &Lock{f: f}, nil
}

func (a *App) heldErr() error {
	e := errs.New("lock.held", errs.ExitLocked, "another run holds the lock of this environment")
	if h, _ := a.Holder(); h != nil {
		e = errs.Newf("lock.held", errs.ExitLocked, "%s (run %s) by %s holds the lock since %s",
			h.Op, h.Run, h.By, h.Since.Format(time.RFC3339))
	}
	return e.WithHint("wait for it to finish, or retry with --wait-lock")
}

// LockServer takes the server-wide lock that serialises changes to the switch, waiting for it.
// It is held for the time of one configuration change only.
func (s *Store) LockServer() (*Lock, error) {
	f, err := os.OpenFile(filepath.Join(s.root, "server.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, ioErr("open the server lock", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, ioErr("take the server lock", err)
	}
	return &Lock{f: f}, nil
}

// Release frees the lock.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	err := l.f.Close()
	l.f = nil
	return err
}
