//go:build unix

package cli

import (
	"os"
	"os/signal"
	"syscall"
)

// watchResize calls fn whenever the local terminal is resized, until stop is called.
func watchResize(fn func()) (stop func()) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGWINCH)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ch:
				fn()
			case <-done:
				return
			}
		}
	}()
	return func() {
		signal.Stop(ch)
		close(done)
	}
}
