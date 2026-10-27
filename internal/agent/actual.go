package agent

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/state"
)

// observed is what runs on the server for one app environment.
type observed struct {
	actual  domain.Actual
	current *domain.Release
	// serving holds, per service, the containers of the release that serves it.
	serving map[string][]engine.Container
	// leftovers are the app's containers of other releases: from a failed or abandoned run, or
	// old containers a run did not get to remove.
	leftovers []engine.Container
}

// observe reads the actual state of stack from Docker and from its state files.
func observe(ctx context.Context, eng engine.Engine, app *state.App, stack string) (*observed, error) {
	env, err := app.Env()
	if err != nil {
		return nil, err
	}
	o := &observed{serving: map[string][]engine.Container{}}
	if env != nil && env.Current > 0 {
		if o.current, err = app.Release(env.Current); err != nil {
			return nil, err
		}
	}
	cs, err := eng.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{
		domain.LabelProject: stack, domain.LabelKind: domain.KindService,
	}})
	if err != nil {
		return nil, err
	}

	// which release serves each service
	servingRelease := map[string]int{}
	if o.current != nil {
		for svc, seq := range o.current.Serving {
			servingRelease[svc] = seq
		}
	} else {
		// no record: the newest containers serve
		for _, c := range cs {
			if c.Release > servingRelease[c.Service] {
				servingRelease[c.Service] = c.Release
			}
		}
	}

	o.actual = domain.Actual{Services: map[string]domain.ActualService{}, Env: env}
	for _, c := range cs {
		if c.OneOff || c.Service == "" {
			continue
		}
		if seq, ok := servingRelease[c.Service]; !ok || c.Release != seq {
			o.leftovers = append(o.leftovers, c)
			continue
		}
		o.serving[c.Service] = append(o.serving[c.Service], c)
	}
	for name, list := range o.serving {
		sort.Slice(list, func(i, j int) bool { return number(list[i]) < number(list[j]) })
		as := domain.ActualService{Name: name, Release: servingRelease[name], Hash: list[0].Hash}
		for _, c := range list {
			as.Containers = append(as.Containers, c.ContainerInfo)
		}
		if o.current != nil {
			if s, ok := o.current.Desired.Service(name); ok {
				as.Desired = s
			}
		}
		o.actual.Services[name] = as
	}
	if o.current != nil {
		o.actual.PublicPorts = o.current.Desired.PublicPorts
	}
	if o.current != nil && len(o.current.Desired.Uploads) > 0 {
		o.actual.Uploads = map[string]string{}
		for _, u := range o.current.Desired.Uploads {
			o.actual.Uploads[u.Dest] = u.Manifest
		}
	}
	if o.actual.Networks, err = eng.Networks(ctx); err != nil {
		return nil, err
	}
	plugins, err := eng.Plugins(ctx)
	if err != nil {
		return nil, err
	}
	o.actual.VolumeDrivers = map[string]bool{}
	for _, p := range plugins {
		for _, t := range p.Types {
			if p.Enabled && strings.HasPrefix(t, "docker.volumedriver/") {
				o.actual.VolumeDrivers[p.Name] = true
				o.actual.VolumeDrivers[strings.TrimSuffix(p.Name, ":latest")] = true
			}
		}
	}
	if o.actual.Volumes, err = eng.Volumes(ctx); err != nil {
		return nil, err
	}
	return o, nil
}

func number(c engine.Container) int {
	n, _ := strconv.Atoi(c.Labels[domain.LabelNumber])
	return n
}

// containerName is the name of container n of a service in release seq.
func containerName(stack string, s *domain.Service, seq, n int) string {
	if s.ContainerName != "" {
		return s.ContainerName
	}
	return domain.ContainerName(stack, s.Name, seq, n)
}
