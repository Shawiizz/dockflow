package cli

import (
	"encoding/json"
	"os"
	"slices"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/version"
)

// savedPlan is the file `plan --out` writes and `deploy --plan` applies (cli-v1.md): what was
// reviewed, and what a deploy needs to apply exactly that. It holds no secret: the fingerprint
// covers the desired state, secrets included, so a changed secret makes the plan stale.
type savedPlan struct {
	Schema  int    `json:"schema"`
	App     string `json:"app"`
	Env     string `json:"env"`
	Server  string `json:"server"`
	Version string `json:"version"`
	// Only is the plan's --only.
	Only []string `json:"only,omitempty"`
	// Images are the built services' images, pinned: a deploy of the plan builds nothing.
	Images          map[string]string `json:"images,omitempty"`
	Fingerprint     string            `json:"fingerprint"`
	Plan            *domain.Plan      `json:"plan"`
	CreatedAt       time.Time         `json:"created_at"`
	DockflowVersion string            `json:"dockflow_version"`
}

const savedPlanSchema = 1

// savePlan writes the plan of s to path, readable by its owner only.
func (s *session) savePlan(path string, p *domain.Plan, only []string) error {
	l := s.loaded
	sp := savedPlan{
		Schema: savedPlanSchema, App: l.Config.App, Env: l.Config.Env, Server: s.target.Server.Name,
		Version: l.Version, Only: only, Images: map[string]string{}, Plan: p,
		CreatedAt: timeNow().UTC(), DockflowVersion: version.Version,
	}
	if p != nil {
		sp.Fingerprint = p.Fingerprint
	}
	for _, b := range l.Builds {
		if svc, ok := l.App.Service(b.Service); ok && (len(only) == 0 || slices.Contains(only, b.Service)) {
			sp.Images[b.Service] = svc.Spec.Image
		}
	}
	data, err := json.MarshalIndent(sp, "", "  ")
	if err != nil {
		return errs.Internal("encode the plan: %v", err)
	}
	// reasons can quote values: masked as every output is
	if err := os.WriteFile(path, []byte(s.app.mask(string(data))+"\n"), 0o600); err != nil {
		return errs.Usage("cannot write the plan to %s: %v", path, err)
	}
	return nil
}

// readPlan reads a saved plan.
func readPlan(path string) (*savedPlan, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errs.Usage("cannot read the plan %s: %v", path, err)
	}
	var sp savedPlan
	if err := json.Unmarshal(data, &sp); err != nil || sp.Schema == 0 {
		return nil, errs.Usage("%s is not a plan written by `dockflow plan --out`", path)
	}
	if sp.Schema != savedPlanSchema {
		return nil, errs.Usage("%s is a plan of schema %d; this CLI reads schema %d", path, sp.Schema, savedPlanSchema).
			WithHint("compute the plan again with this version of the CLI")
	}
	if sp.Fingerprint == "" {
		return nil, errs.Usage("%s has nothing to apply: the plan was empty", path)
	}
	return &sp, nil
}

// usePlan points the built services of s at the plan's images.
func (s *session) usePlan(sp *savedPlan) error {
	l := s.loaded
	if l.Config.App != sp.App || l.Config.Env != sp.Env {
		return errs.Usage("the plan is for %s/%s, not %s/%s", sp.App, sp.Env, l.Config.App, l.Config.Env)
	}
	for _, b := range l.Builds {
		if len(sp.Only) > 0 && !slices.Contains(sp.Only, b.Service) {
			continue
		}
		ref, ok := sp.Images[b.Service]
		if !ok {
			return errs.Plan("plan.stale", "the plan has no image for %s", b.Service).
				WithHint("compute the plan again")
		}
		svc, _ := l.App.Service(b.Service)
		svc.Spec.Image = ref
	}
	return nil
}
