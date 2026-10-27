package compose

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

var (
	headerName = regexp.MustCompile(`^-?[A-Za-z0-9!#$%&'*+.^_|~-]+$`)
	sizeValue  = regexp.MustCompile(`^(\d+)\s*([kKmMgG]?)(i?[bB])?$`)
)

// RouteOptions checks the options of a route and converts them (ADR-0011).
func RouteOptions(at string, x RouteOptionsExt) (domain.RouteOptions, error) {
	o := domain.RouteOptions{Headers: x.Headers, Caddy: strings.TrimSpace(x.Caddy)}
	for name, value := range x.Headers {
		if !headerName.MatchString(name) {
			return o, errs.Config("%s: route header %q is not a header name", at, name)
		}
		if strings.HasPrefix(name, "-") && value != "" {
			return o, errs.Config("%s: route header %s removes the header: give it an empty value", at, name)
		}
	}
	for _, e := range x.Encode {
		if e != "zstd" && e != "gzip" {
			return o, errs.Config("%s: route encode %q: zstd or gzip", at, e)
		}
	}
	o.Encode = x.Encode
	if x.MaxBody != "" {
		n, err := parseSize(string(x.MaxBody))
		if err != nil {
			return o, errs.Config("%s: route max_body %q is not a size", at, x.MaxBody).WithHint("write it like 25MB or 512k")
		}
		o.MaxBody = n
	}
	if t := x.Timeouts; t != nil {
		o.Timeouts = &domain.RouteTimeouts{}
		for _, d := range []struct {
			name, value string
			out         *domain.Duration
		}{{"read", t.Read, &o.Timeouts.Read}, {"write", t.Write, &o.Timeouts.Write}, {"dial", t.Dial, &o.Timeouts.Dial}} {
			if d.value == "" {
				continue
			}
			v, err := time.ParseDuration(d.value)
			if err != nil || v <= 0 {
				return o, errs.Config("%s: route timeouts.%s %q is not a duration", at, d.name, d.value)
			}
			*d.out = domain.Duration(v)
		}
	}
	if a := x.Auth; a != nil {
		if a.User == "" || a.Password == "" || strings.Contains(a.User, ":") {
			return o, errs.Config("%s: route auth needs a user, without a colon, and a password", at).
				WithHint("give the password from a secret: password: ${PANEL_PASSWORD}")
		}
		o.Auth = &domain.RouteAuth{User: a.User, Password: a.Password}
	}
	keys := make([]string, 0, len(x.ErrorPages))
	for k := range x.ErrorPages {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		page := x.ErrorPages[k]
		if (page.Route == "") == (page.Body == "") {
			return o, errs.Config("%s: route error_pages %q: give a route or a body", at, k)
		}
		ep := domain.ErrorPage{Route: page.Route, Body: page.Body}
		for _, part := range strings.Split(k, ",") {
			n, err := strconv.Atoi(strings.TrimSpace(part))
			if err != nil || n < 400 || n > 599 {
				return o, errs.Config("%s: route error_pages %q: statuses from 400 to 599, separated by commas", at, k)
			}
			ep.Statuses = append(ep.Statuses, n)
		}
		o.ErrorPages = append(o.ErrorPages, ep)
	}
	return o, nil
}

// parseSize reads 25MB, 512k or 1048576 as bytes, in powers of 1024 as nginx does.
func parseSize(s string) (int64, error) {
	m := sizeValue.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, errs.Config("not a size")
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, err
	}
	switch strings.ToLower(m[2]) {
	case "k":
		n <<= 10
	case "m":
		n <<= 20
	case "g":
		n <<= 30
	}
	if n <= 0 {
		return 0, errs.Config("not a size")
	}
	return n, nil
}
