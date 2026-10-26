package agent

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
)

// RunContainerPrefix names agent containers: dockflow-run-<run>.
const RunContainerPrefix = "dockflow-run-"

// checkFailed is the code of a failed HTTP check: on_failure decides what it does (ADR-0008).
const checkFailed = "health.check_failed"

// joinNetwork connects the agent's own container to network, so it reaches the app's containers
// by name.
func (r *runner) joinNetwork(ctx context.Context, network string) error {
	if r.joined == nil {
		r.joined = map[string]bool{}
	}
	if r.joined[network] {
		return nil
	}
	if err := r.Engine.Connect(ctx, network, RunContainerPrefix+r.req.Run, nil); err != nil {
		return err
	}
	r.joined[network] = true
	return nil
}

// leaveNetworks disconnects the agent from the app networks it joined.
func (r *runner) leaveNetworks(ctx context.Context) {
	for network := range r.joined {
		_ = r.Engine.Disconnect(context.WithoutCancel(ctx), network, RunContainerPrefix+r.req.Run)
	}
	r.joined = nil
}

// checkContainers runs the service's internal HTTP check against each new container.
func (r *runner) checkContainers(ctx context.Context, s *domain.Service, names []string) error {
	c := s.HTTPCheck
	if c == nil {
		return nil
	}
	if len(s.Spec.Networks) == 0 {
		r.warn("health.check_skipped", fmt.Sprintf("%s: the internal HTTP check needs the service on a network of the app; it is skipped", s.Name))
		return nil
	}
	if err := r.joinNetwork(ctx, s.Spec.Networks[0].Network); err != nil {
		return err
	}
	for _, name := range names {
		url := fmt.Sprintf("http://%s:%d%s", name, c.Port, c.Path)
		ok := func(status int) bool { return status >= c.StatusMin && status <= c.StatusMax }
		want := fmt.Sprintf("%d-%d", c.StatusMin, c.StatusMax)
		if err := r.probe(ctx, s.Name, url, http.MethodGet, ok, want, c.Timeout.D(), c.Interval.D(), c.Retries, true); err != nil {
			return err
		}
	}
	return nil
}

// publicChecks runs health.endpoints, after the switch.
func (r *runner) publicChecks(ctx context.Context) error {
	if len(r.req.Endpoints) == 0 {
		return nil
	}
	if d := r.req.StartupDelay.D(); d > 0 {
		r.ev.Info(events.Log, fmt.Sprintf("waiting %s before the public checks", d), map[string]any{"line": "startup_delay " + d.String()})
		select {
		case <-ctx.Done():
			return interrupted()
		case <-time.After(d):
		}
	}
	for _, e := range r.req.Endpoints {
		ok := func(status int) bool { return status == e.ExpectedStatus }
		if err := r.probe(ctx, e.Name, e.URL, e.Method, ok, fmt.Sprint(e.ExpectedStatus), e.Timeout.D(), e.RetryDelay.D(), e.Retries, e.ValidateCerts); err != nil {
			return err
		}
	}
	return nil
}

// probe requests url until it answers with an accepted status, retries times.
func (r *runner) probe(ctx context.Context, name, url, method string, ok func(int) bool, want string, timeout, interval time.Duration, retries int, validateCerts bool) error {
	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:             nil,
			TLSClientConfig:   &tls.Config{InsecureSkipVerify: !validateCerts}, //nolint:gosec // validate_certs: false asks for it
			DisableKeepAlives: true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	last := ""
	for attempt := 1; attempt <= retries; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, url, nil)
		if err != nil {
			return errs.Config("health check %s: %v", name, err)
		}
		status := 0
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			status = resp.StatusCode
			last = fmt.Sprintf("status %d", status)
		} else {
			last = err.Error()
		}
		passed := err == nil && ok(status)
		data := map[string]any{"service": name, "url": url, "attempt": attempt, "ok": passed}
		if status > 0 {
			data["status"] = status
		}
		if passed {
			r.ev.Info(events.HealthCheck, fmt.Sprintf("%s: %s answers %d", name, url, status), data)
			return nil
		}
		r.ev.Debug(events.HealthCheck, fmt.Sprintf("%s: %s: %s (attempt %d of %d)", name, url, last, attempt, retries), data)
		if ctx.Err() != nil {
			return interrupted()
		}
		if attempt < retries {
			select {
			case <-ctx.Done():
				return interrupted()
			case <-time.After(interval):
			}
		}
	}
	return errs.Newf(checkFailed, errs.ExitRolledBack, "health check %s failed: %s answered %s, not %s, after %d attempts", name, url, last, want, retries).
		WithHint("check the URL and the expected status; on_failure decides whether a failed check rolls back")
}

// checkPolicy applies on_failure to a failed HTTP check: ignore turns it into a warning.
func (r *runner) checkPolicy(err error) error {
	if err == nil || errs.CodeOf(err) != checkFailed || r.req.OnFailure != "ignore" || r.req.NoRollback {
		return err
	}
	r.warn(checkFailed, errs.CodeOf(err)+": "+err.Error()+" (on_failure: ignore)")
	return nil
}
