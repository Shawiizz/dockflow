// Package compose loads an environment's Compose files with compose-go, the loader Docker
// Compose itself uses (ADR-0002), and converts the project to Dockflow's domain model.
package compose

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/compose-spec/compose-go/v2/cli"
	interp "github.com/compose-spec/compose-go/v2/interpolation"
	"github.com/compose-spec/compose-go/v2/loader"
	"github.com/compose-spec/compose-go/v2/template"
	"github.com/compose-spec/compose-go/v2/types"

	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// DefaultFiles are tried in order when dockflow.yml names no Compose file.
var DefaultFiles = []string{"compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"}

// Variables are the values interpolation sees, already ordered by precedence.
type Variables struct {
	Lookup config.Lookup
	// All lists every known variable with its value, for Compose's own environment
	// resolution (`environment: [KEY]` without a value).
	All map[string]string
}

// Load reads the Compose files of an environment. files are relative to dir; an empty list
// means the first default file that exists, and no file at all is valid (an app without
// services).
func Load(ctx context.Context, dir, stack string, files, profiles []string, vars Variables) (*types.Project, error) {
	paths, err := resolveFiles(dir, files)
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return &types.Project{Name: stack, WorkingDir: dir, Services: types.Services{}}, nil
	}
	env := make([]string, 0, len(vars.All))
	for k, v := range vars.All {
		env = append(env, k+"="+v)
	}
	sort.Strings(env)

	opts, err := cli.NewProjectOptions(paths,
		// relative paths (build contexts, env files) are the first Compose file's, as with
		// docker compose -f
		cli.WithWorkingDirectory(filepath.Dir(paths[0])),
		cli.WithName(stack),
		cli.WithEnv(env),
		cli.WithProfiles(profiles),
		cli.WithLoadOptions(func(o *loader.Options) {
			o.Interpolate = &interp.Options{
				LookupValue: interp.LookupValue(vars.Lookup),
				Substitute: func(s string, m template.Mapping) (string, error) {
					return config.Substitute(s, m)
				},
			}
		}),
	)
	if err != nil {
		return nil, errs.Config("cannot read the Compose files").WithCause(err)
	}
	project, err := opts.LoadProject(ctx)
	if err != nil {
		return nil, composeError(err)
	}
	return project, nil
}

func resolveFiles(dir string, files []string) ([]string, error) {
	if len(files) == 0 {
		for _, f := range DefaultFiles {
			if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
				return []string{filepath.Join(dir, f)}, nil
			}
		}
		return nil, nil
	}
	out := make([]string, len(files))
	for i, f := range files {
		p := f
		if !filepath.IsAbs(p) {
			p = filepath.Join(dir, f)
		}
		if _, err := os.Stat(p); err != nil {
			return nil, errs.Config("Compose file %s not found", f).
				WithHint("check `compose:` in %s", config.FileName)
		}
		out[i] = p
	}
	return out, nil
}

func composeError(err error) error {
	var missing *config.MissingVariableError
	if errors.As(err, &missing) {
		return errs.Config("Compose: variable %s is not defined", missing.Name).WithCause(err).
			WithHint("define it under environments.<env>.vars or as a secret, or write ${%s:-default}", missing.Name)
	}
	var required *template.MissingRequiredError
	if errors.As(err, &required) {
		return errs.Config("Compose: %s", strings.TrimSpace(required.Error()))
	}
	return errs.Config("the Compose files are not valid").WithCause(err)
}
