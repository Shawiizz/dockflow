package planner

import (
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Only returns the app that deploys the services named in only as next has them, and keeps
// every other service as base, the current release, has it: planned against the server, the
// other services do not change, and the new release still records the whole app. A service of
// next that base does not have and only does not name is left out. Jobs are tasks of the
// version deployed, not services that run: they always come from next, and run as a full deploy
// runs them. Networks and volumes are those of both; uploads are next's.
func Only(next, base domain.App, only []string) (domain.App, error) {
	names := map[string]bool{}
	for _, name := range only {
		if _, ok := next.Service(name); !ok {
			return domain.App{}, errs.Usage("no service %s in this version of the app", name)
		}
		names[name] = true
	}
	out := next
	out.Services = nil
	seen := map[string]bool{}
	for _, s := range next.Services {
		seen[s.Name] = true
		if names[s.Name] || s.Job != "" {
			out.Services = append(out.Services, s)
		} else if b, ok := base.Service(s.Name); ok {
			out.Services = append(out.Services, *b)
		}
	}
	for _, s := range base.Services {
		if !seen[s.Name] && s.Job == "" {
			out.Services = append(out.Services, s)
		}
	}
	for _, s := range out.Services {
		if !names[s.Name] {
			continue
		}
		for _, d := range s.DependsOn {
			if _, ok := out.Service(d.Service); !ok {
				return domain.App{}, errs.Plan("plan.only_dependency", "%s depends on %s, which is not deployed", s.Name, d.Service).
					WithHint("add %s to --only", d.Service)
			}
		}
	}
	out.Networks = union(next.Networks, base.Networks, func(n domain.Network) string { return n.Name })
	out.Volumes = union(next.Volumes, base.Volumes, func(v domain.Volume) string { return v.Name })
	return out, nil
}

func union[T any](a, b []T, key func(T) string) []T {
	out := append([]T(nil), a...)
	seen := map[string]bool{}
	for _, x := range a {
		seen[key(x)] = true
	}
	for _, x := range b {
		if !seen[key(x)] {
			out = append(out, x)
		}
	}
	return out
}
