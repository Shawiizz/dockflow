package caddy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/proxy"
)

// Switch talks to Caddy's admin API, and writes the upstream files in the volume it shares
// with Caddy.
type Switch struct {
	http *http.Client
	// dir is where the agent sees the shared volume: Dir, except in tests.
	dir string
}

var _ proxy.Switch = (*Switch)(nil)

// New returns a switch whose shared volume is mounted at dir.
func New(dir string) *Switch {
	sock := filepath.Join(dir, filepath.Base(AdminSocket))
	return &Switch{dir: dir, http: &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		}},
	}}
}

// Apply points every route at its upstreams, then reloads Caddy only when the routes themselves
// changed: moving traffic between containers is writing the upstream files, which Caddy reads on
// every request.
func (s *Switch) Apply(ctx context.Context, c proxy.Config) error {
	body, err := Build(c)
	if err != nil {
		return err
	}
	if err := s.writeUpstreams(c); err != nil {
		return err
	}
	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:])
	hashFile := filepath.Join(s.dir, "config.sha256")
	if prev, err := os.ReadFile(hashFile); err == nil && string(prev) == hash && !c.Reload {
		return nil
	}
	if err := s.loadRetrying(ctx, body); err != nil {
		return err
	}
	if err := atomicWrite(hashFile, []byte(hash)); err != nil {
		return err
	}
	return s.pruneUpstreams(c)
}

// writeUpstreams writes every upstream file, each atomically.
func (s *Switch) writeUpstreams(c proxy.Config) error {
	for rel, addr := range Upstreams(c) {
		path := filepath.Join(s.dir, "up", rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return errs.Internal("create %s: %v", filepath.Dir(path), err)
		}
		if err := atomicWrite(path, []byte(addr)); err != nil {
			return err
		}
	}
	return nil
}

// pruneUpstreams removes the files of routes and slots the configuration no longer has.
func (s *Switch) pruneUpstreams(c proxy.Config) error {
	keep := Upstreams(c)
	root := filepath.Join(s.dir, "up")
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if _, ok := keep[filepath.ToSlash(rel)]; !ok {
			_ = os.Remove(path)
		}
		return nil
	})
}

func atomicWrite(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return errs.Internal("write %s: %v", path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return errs.Internal("rename %s: %v", path, err)
	}
	return nil
}

func (s *Switch) loadRetrying(ctx context.Context, body []byte) error {
	var last error
	for attempt := 0; attempt < 20; attempt++ {
		last = s.load(ctx, body)
		if last == nil {
			return nil
		}
		if _, ok := last.(*errs.Error); ok {
			return last
		}
		// the switch may be starting
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return errs.New("switch.unreachable", errs.ExitInternal, "the switch's admin API does not answer").WithCause(last).
		WithHint("check the dockflow-switch container on the server, or run `dockflow server init` again")
}

func (s *Switch) load(ctx context.Context, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://switch/load", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return errs.New("switch.config_refused", errs.ExitInternal, fmt.Sprintf("the switch refused its configuration (%d): %s", resp.StatusCode, bytes.TrimSpace(msg)))
	}
	return nil
}
