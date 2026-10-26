//go:build !unix

package state

import (
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Lock is a held environment lock.
type Lock struct{}

// Lock is only available where the agent runs: in a Linux container.
func (a *App) Lock(domain.LockInfo) (*Lock, error) {
	return nil, errs.Internal("the environment lock is only available on Unix")
}

// LockServer is only available on Unix.
func (s *Store) LockServer() (*Lock, error) {
	return nil, errs.Internal("the server lock is only available on Unix")
}

// Release frees the lock.
func (l *Lock) Release() error { return nil }
