package caddy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/proxy"
)

// Switch talks to Caddy's admin API.
type Switch struct {
	http *http.Client
}

var _ proxy.Switch = (*Switch)(nil)

// New returns a switch reached through the admin socket at path.
func New(path string) *Switch {
	return &Switch{http: &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		}},
	}}
}

// Apply loads the configuration. Caddy swaps it gracefully: requests in flight finish on the
// previous configuration.
func (s *Switch) Apply(ctx context.Context, c proxy.Config) error {
	body, err := Build(c)
	if err != nil {
		return err
	}
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
