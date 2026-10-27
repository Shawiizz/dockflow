// Package cloudflare knows the address ranges Cloudflare's proxies connect from (ADR-0011,
// ADR-0014): the cloudflare edge opens ports 80 and 443 to them only, and trusts their
// CF-Connecting-IP header.
package cloudflare

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

// The lists Cloudflare publishes.
const (
	URLv4 = "https://www.cloudflare.com/ips-v4"
	URLv6 = "https://www.cloudflare.com/ips-v6"
)

// Default are the ranges as this version of Dockflow knows them, used when the lists cannot be
// downloaded and no earlier download exists.
var Default = []string{
	"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
	"108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
	"162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
	"2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
	"2a06:98c0::/29", "2c0f:f248::/32",
}

// Parse reads one published list: one CIDR of the family per line, at least one. Anything else
// refuses the whole list, so a captive portal's page or a truncated download never replaces
// good ranges.
func Parse(body string, v6 bool) ([]string, error) {
	var out []string
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		p, err := netip.ParsePrefix(line)
		if err != nil || p.Addr().Is6() != v6 || p.Bits() < 8 {
			return nil, fmt.Errorf("%q is not a range of the list", line)
		}
		out = append(out, p.Masked().String())
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("the list is empty")
	}
	return out, nil
}

// Fetch downloads both lists, IPv4 first.
func Fetch(ctx context.Context, client *http.Client) ([]string, error) {
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	var all []string
	for _, u := range []struct {
		url string
		v6  bool
	}{{URLv4, false}, {URLv6, true}} {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.url, nil)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("%s: status %d", u.url, resp.StatusCode)
		}
		ranges, err := Parse(string(b), u.v6)
		if err != nil {
			return nil, fmt.Errorf("%s: %v", u.url, err)
		}
		all = append(all, ranges...)
	}
	return all, nil
}
