package domain

import (
	"fmt"
	"net/netip"
	"path"
	"strings"
)

// CanonicalHost is the form of a route's domain that the switch matches and that conflicts are
// checked on: lower case, without a trailing dot. It refuses what is not a host name, a
// wildcard (*.example.com, the first label only) or an IP address.
func CanonicalHost(d string) (string, error) {
	h := strings.TrimSuffix(strings.ToLower(d), ".")
	if a, err := netip.ParseAddr(strings.Trim(h, "[]")); err == nil && a.Zone() == "" {
		return a.String(), nil
	}
	if len(h) == 0 || len(h) > 253 {
		return "", fmt.Errorf("%q is not a host name", d)
	}
	labels := strings.Split(h, ".")
	for i, l := range labels {
		if l == "*" && i == 0 && len(labels) > 1 {
			continue
		}
		if !hostLabel(l) {
			return "", fmt.Errorf("%q is not a host name: write it in ASCII (punycode), with letters, digits and hyphens, a wildcard only as *.domain", d)
		}
	}
	return h, nil
}

func hostLabel(l string) bool {
	if len(l) == 0 || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
		return false
	}
	for _, c := range l {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' && c != '_' {
			return false
		}
	}
	return true
}

// Canonicalize puts the route's domains and path in their canonical forms, and refuses a domain
// that is not a host name or a domain given twice.
func (r *Route) Canonicalize() error {
	domains := make([]string, 0, len(r.Domains))
	seen := map[string]bool{}
	for _, d := range r.Domains {
		h, err := CanonicalHost(d)
		if err != nil {
			return err
		}
		if seen[h] {
			return fmt.Errorf("the domain %s is given twice", h)
		}
		seen[h] = true
		domains = append(domains, h)
	}
	r.Domains = domains
	r.Path = CanonicalPath(r.Path)
	return nil
}

// CanonicalPath is the form of a route's path that conflicts are checked on: cleaned, without a
// trailing slash, "/" for the root. /api and /api/ are one route.
func CanonicalPath(p string) string {
	if p == "" {
		return "/"
	}
	return path.Clean("/" + p)
}
