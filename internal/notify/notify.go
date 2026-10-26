// Package notify sends webhooks when a run ends, signed with HMAC-SHA256.
package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"time"
)

// Webhook is one entry of notify.
type Webhook struct {
	URL     string
	On      []string // success, failure; empty means both
	Secret  string
	Headers map[string]string
	Timeout time.Duration
}

// Payload is the body of a webhook.
type Payload struct {
	Event      string    `json:"event"` // run.finished
	App        string    `json:"app"`
	Env        string    `json:"env"`
	Server     string    `json:"server"`
	Op         string    `json:"op"`
	Run        string    `json:"run"`
	Version    string    `json:"version"`
	Release    int       `json:"release,omitempty"`
	Outcome    string    `json:"outcome"`
	Status     string    `json:"status"` // success or failure
	ExitCode   int       `json:"exit_code"`
	DurationMS int64     `json:"duration_ms"`
	Error      string    `json:"error,omitempty"`
	At         time.Time `json:"at"`
}

// SignatureHeader carries sha256=<hex HMAC of the body>, when the webhook has a secret.
const SignatureHeader = "X-Dockflow-Signature"

// Send posts p to every webhook that wants its status, and returns the errors, one per failed
// webhook. A webhook never changes the outcome of a run.
func Send(ctx context.Context, hooks []Webhook, p Payload, client *http.Client) []error {
	if client == nil {
		client = http.DefaultClient
	}
	body, _ := json.Marshal(p)
	var failed []error
	for _, h := range hooks {
		if len(h.On) > 0 && !slices.Contains(h.On, p.Status) {
			continue
		}
		if err := post(ctx, client, h, body); err != nil {
			failed = append(failed, fmt.Errorf("webhook %s: %w", h.URL, err))
		}
	}
	return failed
}

func post(ctx context.Context, client *http.Client, h Webhook, body []byte) error {
	timeout := h.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "dockflow")
	req.Header.Set("X-Dockflow-Event", "run.finished")
	for k, v := range h.Headers {
		req.Header.Set(k, v)
	}
	if h.Secret != "" {
		req.Header.Set(SignatureHeader, Sign(h.Secret, body))
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

// Sign returns the signature header of body: sha256=<hex HMAC-SHA256 with secret>.
func Sign(secret string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}
