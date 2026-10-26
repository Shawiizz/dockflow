package connection

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"

	"github.com/Shawiizz/dockflow/internal/errs"
)

// Socket is a local unix socket whose connections are forwarded through a dialer: remote builds
// point buildx at the server's Docker through it (ADR-0009). It lives in a directory only the
// current user can enter, because whoever reaches it controls the server's Docker.
type Socket struct {
	// Path is the socket's path; DOCKER_HOST is unix://<Path>.
	Path string
	dir  string
	l    net.Listener
}

// Forward opens a socket that forwards its connections through dial.
func Forward(dial func(ctx context.Context, network, addr string) (net.Conn, error)) (*Socket, error) {
	dir, err := os.MkdirTemp("", "dockflow-docker-")
	if err != nil {
		return nil, errs.Internal("temporary directory: %v", err)
	}
	s := &Socket{Path: filepath.Join(dir, "docker.sock"), dir: dir}
	if s.l, err = net.Listen("unix", s.Path); err != nil {
		os.RemoveAll(dir)
		return nil, errs.Internal("listen on %s: %v", s.Path, err)
	}
	go func() {
		for {
			c, err := s.l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				up, err := dial(context.Background(), "unix", "")
				if err != nil {
					return
				}
				defer up.Close()
				done := make(chan struct{}, 2)
				go pipe(up, c, done)
				go pipe(c, up, done)
				<-done
				<-done
			}()
		}
	}()
	return s, nil
}

// pipe copies src to dst, then half-closes dst: the Engine's hijacked streams (the build
// session) keep reading after their peer is done writing.
func pipe(dst, src net.Conn, done chan<- struct{}) {
	io.Copy(dst, src)
	if cw, ok := dst.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
	} else {
		dst.Close()
	}
	done <- struct{}{}
}

// Close stops listening and removes the socket.
func (s *Socket) Close() {
	_ = s.l.Close()
	os.RemoveAll(s.dir)
}
