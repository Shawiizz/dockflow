package project

import (
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Shawiizz/dockflow/internal/compose"
	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

var (
	routeName   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	placeholder = regexp.MustCompile(`\{[a-z][a-z0-9_.]*\}`)
)

// appRoutes adds the routes of dockflow.yml to the app (ADR-0011): redirects and proxies are
// routes of the app; a files route is a service of its own, a file server in the switch's image.
func appRoutes(entries []config.RouteEntry, app *domain.App) error {
	names := map[string]bool{}
	for i, e := range entries {
		at := fmt.Sprintf("routes[%d]", i)
		if e.Name != "" {
			at = "route " + e.Name
			if !routeName.MatchString(e.Name) {
				return errs.Config("%s: the name must match %s", at, routeName)
			}
			if names[e.Name] {
				return errs.Config("%s: two routes have this name", at)
			}
			names[e.Name] = true
		}
		kinds := 0
		for _, set := range []bool{e.Redirect != "", e.Proxy != "", e.Files != nil} {
			if set {
				kinds++
			}
		}
		if kinds != 1 {
			return errs.Config("%s: give exactly one of redirect, proxy and files", at).
				WithHint("a route to a service of the app goes under x-dockflow.routes in the Compose file")
		}
		rt := domain.Route{Name: e.Name, Domains: e.Domains, Path: e.Path, TLS: true, StripPrefix: e.StripPrefix}
		if e.TLS != nil {
			rt.TLS = *e.TLS
		}
		if rt.Path == "" {
			rt.Path = "/"
		}
		if len(rt.Domains) == 0 || !strings.HasPrefix(rt.Path, "/") {
			return errs.Config("%s: a route needs domains, and a path starting with /", at)
		}
		if err := rt.Canonicalize(); err != nil {
			return errs.Config("%s: %v", at, err)
		}
		ext := compose.RouteOptionsExt{Headers: e.Headers, Encode: e.Encode, MaxBody: compose.SizeExt(e.MaxBody), Caddy: e.Caddy}
		if e.Timeouts != nil {
			ext.Timeouts = &struct {
				Read  string `json:"read"`
				Write string `json:"write"`
				Dial  string `json:"dial"`
			}{e.Timeouts.Read, e.Timeouts.Write, e.Timeouts.Dial}
		}
		if e.Auth != nil {
			ext.Auth = &struct {
				User     string `json:"user"`
				Password string `json:"password"`
			}{e.Auth.User, e.Auth.Password}
		}
		if len(e.ErrorPages) > 0 {
			ext.ErrorPages = map[string]compose.ErrorPageExt{}
			for k, p := range e.ErrorPages {
				ext.ErrorPages[k] = compose.ErrorPageExt{Route: p.Route, Body: p.Body}
			}
		}
		opts, err := compose.RouteOptions(at, ext)
		if err != nil {
			return err
		}
		rt.RouteOptions = opts

		switch {
		case e.Redirect != "":
			// Caddy's placeholders, {uri} and others, are kept as they are
			u, err := url.Parse(placeholder.ReplaceAllString(e.Redirect, ""))
			if err != nil || (u.Scheme != "http" && u.Scheme != "https" && !strings.HasPrefix(e.Redirect, "/")) {
				return errs.Config("%s: redirect %q must be an http or https URL, or a path", at, e.Redirect)
			}
			status := e.Status
			switch status {
			case 0:
				status = 308
			case 301, 302, 303, 307, 308:
			default:
				return errs.Config("%s: status %d: 301, 302, 303, 307 or 308", at, e.Status)
			}
			app.Routes = append(app.Routes, domain.AppRoute{Route: rt, Redirect: e.Redirect, Status: status})
		case e.Proxy != "":
			u, err := url.Parse(e.Proxy)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
				return errs.Config("%s: proxy %q must be an http or https URL without a path, like http://billing-api:8080", at, e.Proxy)
			}
			if e.Status != 0 {
				return errs.Config("%s: status goes with redirect", at)
			}
			app.Routes = append(app.Routes, domain.AppRoute{Route: rt, Proxy: strings.TrimSuffix(e.Proxy, "/"), Network: e.Network})
		default:
			if e.Status != 0 || e.Network != "" {
				return errs.Config("%s: status goes with redirect, network with proxy", at)
			}
			svc, err := fileServer(at, i, e, rt, app)
			if err != nil {
				return err
			}
			app.Services = append(app.Services, *svc)
		}
	}
	// error pages show a route of dockflow.yml, by name
	check := func(at string, r domain.Route) error {
		for _, p := range r.ErrorPages {
			if p.Route != "" && !names[p.Route] {
				return errs.Config("%s: error_pages: no route of dockflow.yml is named %s", at, p.Route).
					WithHint("name the route with name: under routes in dockflow.yml")
			}
		}
		return nil
	}
	for _, s := range app.Services {
		for _, r := range s.Routes {
			if err := check("service "+s.Name, r); err != nil {
				return err
			}
		}
	}
	for _, r := range app.Routes {
		if err := check("route "+r.Name, r.Route); err != nil {
			return err
		}
	}
	return nil
}

// fileServer is the service of a files route: the switch mounts nothing, so a small file server
// serves the directory or the volume, read-only.
func fileServer(at string, i int, e config.RouteEntry, rt domain.Route, app *domain.App) (*domain.Service, error) {
	name := "files-" + strconv.Itoa(i)
	if e.Name != "" {
		name = "files-" + e.Name
	}
	if _, exists := app.Service(name); exists {
		return nil, errs.Config("%s: the Compose file has a service %s already", at, name)
	}
	f := e.Files
	var mount domain.Mount
	switch {
	case f.HostPath != "" && f.Volume == "":
		if !filepath.IsAbs(f.HostPath) || strings.Contains(f.HostPath, "..") {
			return nil, errs.Config("%s: files.host_path %q must be an absolute path on the server", at, f.HostPath)
		}
		mount = domain.Mount{Type: "bind", Source: f.HostPath, Target: "/srv", ReadOnly: true}
	case f.Volume != "" && f.HostPath == "":
		for _, v := range app.Volumes {
			if v.Key == f.Volume {
				mount = domain.Mount{Type: "volume", Source: v.Name, Target: "/srv", ReadOnly: true}
			}
		}
		if mount.Source == "" {
			return nil, errs.Config("%s: files.volume %s is not a volume of the Compose file", at, f.Volume)
		}
	default:
		return nil, errs.Config("%s: files needs host_path or volume", at)
	}
	network := app.Stack + "_default"
	found := false
	for _, n := range app.Networks {
		if n.Key == "default" {
			network, found = n.Name, true
		}
	}
	if !found {
		app.Networks = append(app.Networks, domain.Network{Key: "default", Name: network})
	}
	cmd := []string{"caddy", "file-server", "--root", "/srv", "--listen", ":80"}
	if f.Browse {
		cmd = append(cmd, "--browse")
	}
	// the directory is the route's path: /builds-raw/x is x of the directory
	rt.Port, rt.StripPrefix = 80, rt.Path != "/"
	return &domain.Service{
		Name:     name,
		Replicas: 1,
		Strategy: domain.StrategySwitch,
		Spec: domain.ContainerSpec{
			Image: domain.FileServerImage, Command: cmd, Restart: "unless-stopped",
			Mounts:   []domain.Mount{mount},
			Networks: []domain.Attachment{{Network: network, Aliases: []string{name}}},
		},
		PullPolicy:  "missing",
		Routes:      []domain.Route{rt},
		Drain:       domain.Duration(30 * time.Second),
		HealthGrace: domain.Duration(2 * time.Second),
	}, nil
}
