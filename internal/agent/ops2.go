package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
)

// currentRelease reads the release the environment runs.
func (r *runner) currentRelease() (*domain.Release, error) {
	env, err := r.app.Env()
	if err != nil {
		return nil, err
	}
	if env == nil || env.Current == 0 {
		return nil, errs.Newf("env.never_deployed", errs.ExitPlan, "%s was never deployed", r.stack)
	}
	rel, err := r.app.Release(env.Current)
	if err != nil {
		return nil, err
	}
	if rel == nil {
		return nil, errs.Newf("state.missing_release", errs.ExitInternal, "release %d of %s is missing", env.Current, r.stack)
	}
	return rel, nil
}

// changed returns the current app as restart, stop, scale or destroy --only change it, and the
// services restart replaces.
func (r *runner) changed(cur domain.App) (domain.App, []string, error) {
	a := cur
	a.Services = append([]domain.Service(nil), cur.Services...)
	names, err := r.selected(&a)
	if err != nil {
		return a, nil, err
	}
	var restart []string
	for i := range a.Services {
		s := &a.Services[i]
		if !names[s.Name] {
			continue
		}
		switch r.req.Op {
		case OpRestart:
			s.Stopped = false
			restart = append(restart, s.Name)
		case OpStop:
			s.Stopped = true
		case OpScale:
			if s.Stateful && r.req.Replicas > 1 {
				return a, nil, errs.Plan("plan.stateful_replicas", "%s is stateful: it runs once", s.Name)
			}
			if s.ContainerName != "" && r.req.Replicas > 1 {
				return a, nil, errs.Plan("plan.container_name_replicas", "%s has a container_name: it runs once", s.Name)
			}
			s.Replicas, s.Stopped = r.req.Replicas, false
		}
	}
	if r.req.Op == OpDestroy {
		kept := a.Services[:0]
		for _, s := range a.Services {
			if !names[s.Name] {
				kept = append(kept, s)
			}
		}
		a.Services = kept
		for _, s := range a.Services {
			for _, d := range s.DependsOn {
				if names[d.Service] {
					return a, nil, errs.Plan("plan.dependency_removed", "%s depends on %s", s.Name, d.Service).
						WithHint("destroy them together")
				}
			}
		}
	}
	return a, restart, nil
}

// selected checks the request's services against a; none means every long-running service.
func (r *runner) selected(a *domain.App) (map[string]bool, error) {
	names := map[string]bool{}
	if len(r.req.Services) == 0 {
		if r.req.Op == OpScale || r.req.Op == OpDestroy {
			return nil, errs.Usage("name the services")
		}
		for _, s := range a.Services {
			if s.Job == "" {
				names[s.Name] = true
			}
		}
		return names, nil
	}
	for _, name := range r.req.Services {
		s, ok := a.Service(name)
		if !ok {
			return nil, errs.Usage("no service %s in the current release", name)
		}
		if s.Job != "" && r.req.Op != OpDestroy {
			return nil, errs.Usage("%s is a job: it runs on deploys only", name)
		}
		names[name] = true
	}
	return names, nil
}

// destroy removes the environment from the server: its containers, its routes, its networks,
// with Volumes its volumes, and its state.
func (r *runner) destroy(ctx context.Context) events.RunFinishedData {
	l, err := r.lock(ctx)
	if err != nil {
		return failed(err)
	}
	defer r.unlock(l)
	ctx = context.WithoutCancel(ctx)

	if err := r.applyRoutes(ctx, nil); err != nil {
		return failed(err)
	}
	cs, err := r.Engine.Containers(ctx, engine.Filter{All: true, Labels: map[string]string{domain.LabelProject: r.stack}})
	if err != nil {
		return failed(err)
	}
	removed := 0
	for _, c := range cs {
		if c.Labels[domain.LabelKind] == domain.KindRun {
			continue
		}
		if err := r.Engine.Remove(ctx, c.ID); err != nil {
			return failed(err)
		}
		removed++
	}
	r.ev.Info(events.Log, fmt.Sprintf("%d containers removed", removed), map[string]any{"line": "containers removed"})
	cur, _ := r.currentRelease()
	if cur != nil {
		for _, n := range cur.Desired.Networks {
			if !n.External {
				if err := r.Engine.Disconnect(ctx, n.Name, SwitchContainer); err != nil {
					r.warn("destroy.network", err.Error())
				}
				if err := r.Engine.RemoveNetwork(ctx, n.Name); err != nil {
					r.warn("destroy.network", err.Error())
				}
			}
		}
		if r.req.Volumes {
			for _, v := range cur.Desired.Volumes {
				if !v.External {
					if err := r.Engine.RemoveVolume(ctx, v.Name); err != nil {
						return failed(err)
					}
					r.ev.Info(events.Log, "volume "+v.Name+" deleted", map[string]any{"line": "rm volume " + v.Name})
				}
			}
		}
	}
	if err := r.app.Delete(); err != nil {
		return failed(err)
	}
	r.result(map[string]any{"destroyed": r.stack, "containers": removed, "volumes": r.req.Volumes})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// details returns the current release in full.
func (r *runner) details() events.RunFinishedData {
	cur, err := r.currentRelease()
	if err != nil {
		return failed(err)
	}
	r.result(cur)
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// PruneReport is what prune removed.
type PruneReport struct {
	Containers []string `json:"containers"`
	Images     []string `json:"images"`
	Volumes    []string `json:"volumes"`
	Networks   []string `json:"networks"`
	Reclaimed  int64    `json:"reclaimed_bytes"`
	Registry   bool     `json:"registry_collected"`
}

// prune removes unused Docker objects of the server, never one Dockflow still needs: managed
// containers, app volumes, and the images of the releases in retention.
func (r *runner) prune(ctx context.Context) events.RunFinishedData {
	p := r.req.Prune
	if p == nil {
		p = &PruneRequest{Containers: true, Images: true, Networks: true}
	}
	rep := PruneReport{Containers: []string{}, Images: []string{}, Volumes: []string{}, Networks: []string{}}
	if p.Containers {
		cs, err := r.Engine.Containers(ctx, engine.Filter{All: true})
		if err != nil {
			return failed(err)
		}
		for _, c := range cs {
			if c.Labels[domain.LabelManagedBy] == "true" || (c.State != "exited" && c.State != "created" && c.State != "dead") {
				continue
			}
			if err := r.Engine.Remove(ctx, c.ID); err == nil {
				rep.Containers = append(rep.Containers, c.Name)
			}
		}
	}
	if p.Images {
		kept, err := r.keptImages()
		if err != nil {
			return failed(err)
		}
		imgs, err := r.Engine.Images(ctx)
		if err != nil {
			return failed(err)
		}
		for _, img := range imgs {
			if img.Containers > 0 || keptImage(img, kept) || (len(img.Tags) > 0 && !p.AllImages) {
				continue
			}
			if err := r.Engine.RemoveImage(ctx, img.ID); err == nil {
				rep.Images = append(rep.Images, imageName(img))
				rep.Reclaimed += img.Size
			}
		}
	}
	if p.Volumes {
		names, err := r.Engine.PruneVolumes(ctx)
		if err != nil {
			return failed(err)
		}
		rep.Volumes = append(rep.Volumes, names...)
	}
	if p.Networks {
		names, err := r.Engine.PruneNetworks(ctx)
		if err != nil {
			return failed(err)
		}
		rep.Networks = append(rep.Networks, names...)
	}
	if p.Registry {
		if err := r.collectRegistry(ctx); err != nil {
			return failed(err)
		}
		rep.Registry = true
	}
	r.result(rep)
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// keptImages are the images of every release in retention, of every app on the server, and of
// the server's own containers.
func (r *runner) keptImages() (map[string]bool, error) {
	kept := map[string]bool{}
	stacks, err := r.Store.Stacks()
	if err != nil {
		return nil, err
	}
	for _, stack := range stacks {
		app, err := r.Store.App(stack)
		if err != nil {
			return nil, err
		}
		seqs, err := app.Releases()
		if err != nil {
			return nil, err
		}
		for _, seq := range seqs {
			rel, err := app.Release(seq)
			if err != nil || rel == nil {
				continue
			}
			for _, s := range rel.Desired.Services {
				kept[s.Spec.Image] = true
			}
		}
	}
	if srv, _ := r.Store.Server(); srv != nil {
		kept[srv.SwitchImage] = true
		kept[srv.RegistryImage] = true
	}
	return kept, nil
}

func keptImage(img engine.Image, kept map[string]bool) bool {
	if kept[img.ID] {
		return true
	}
	for _, ref := range append(append([]string(nil), img.Tags...), img.Digests...) {
		if kept[ref] {
			return true
		}
		// a pinned reference names repository@digest, possibly with the tag before
		repo, digest, _ := strings.Cut(ref, "@")
		for k := range kept {
			if digest != "" && strings.HasSuffix(k, "@"+digest) && strings.Contains(k, strings.TrimPrefix(repo, "docker.io/library/")) {
				return true
			}
		}
		if strings.HasPrefix(ref, "dockflow/agent:") {
			return true
		}
	}
	return false
}

func imageName(img engine.Image) string {
	if len(img.Tags) > 0 {
		return img.Tags[0]
	}
	if len(img.Digests) > 0 {
		return img.Digests[0]
	}
	return img.ID
}
