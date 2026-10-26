package cli

import (
	"context"
	"io"
	"os"
	"sync"

	"golang.org/x/term"
)

// session streams of an interactive command, and how to resize its terminal.
type interactive struct {
	stdin  io.WriteCloser
	stdout io.Reader
	stderr io.Reader
	tty    bool
	resize func(ctx context.Context, width, height uint) error
}

// interact connects the local terminal to a remote command until its output ends. With a TTY,
// the local terminal is in raw mode, so Ctrl+C reaches the remote command.
func (a *app) interact(ctx context.Context, s interactive) error {
	in, isTerm := a.stdin, isTerminal(a.stdin)
	if s.tty && isTerm {
		state, err := term.MakeRaw(int(in.Fd()))
		if err == nil {
			defer func() { _ = term.Restore(int(in.Fd()), state) }()
		}
	}
	if s.tty && s.resize != nil {
		size := func() {
			if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
				_ = s.resize(ctx, uint(w), uint(h))
			}
		}
		size()
		stop := watchResize(size)
		defer stop()
	}
	if s.stdin != nil {
		go func() {
			io.Copy(s.stdin, in)
			s.stdin.Close()
		}()
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		io.Copy(a.stdout, s.stdout)
	}()
	if s.stderr != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			io.Copy(a.stderr, s.stderr)
		}()
	}
	wg.Wait()
	return nil
}

// terminalSize is the local terminal's size, or 0 without a terminal.
func terminalSize() (uint, uint) {
	if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
		return uint(w), uint(h)
	}
	return 0, 0
}
