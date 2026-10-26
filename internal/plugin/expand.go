package plugin

import (
	"bytes"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/render"
)

// hook is a hook of plugin.yml: one of dockflow.yml, plus if_changed.
type hook struct {
	config.HookEntry `yaml:",inline"`
	// IfChanged is the destination of one of the plugin's uploads: the hook runs only when the
	// deploy changed it.
	IfChanged string `yaml:"if_changed"`
}

type pluginHooks struct {
	BeforeBuild  []hook `yaml:"before_build"`
	AfterBuild   []hook `yaml:"after_build"`
	BeforeDeploy []hook `yaml:"before_deploy"`
	AfterDeploy  []hook `yaml:"after_deploy"`
	AfterFailure []hook `yaml:"after_failure"`
}

// expand turns the hooks into the project's, named after the plugin. dests are the
// destinations of the plugin's uploads, which if_changed can name.
func (h *pluginHooks) expand(at, id string, dests map[string]bool) ([]domain.Hook, error) {
	var plain config.Hooks
	// in the order ParseHooks returns them
	var ifChanged []string
	phases := []struct {
		name    string
		entries []hook
		out     *[]config.HookEntry
	}{
		{domain.HookBeforeBuild, h.BeforeBuild, &plain.BeforeBuild},
		{domain.HookAfterBuild, h.AfterBuild, &plain.AfterBuild},
		{domain.HookBeforeDeploy, h.BeforeDeploy, &plain.BeforeDeploy},
		{domain.HookAfterDeploy, h.AfterDeploy, &plain.AfterDeploy},
		{domain.HookAfterFailure, h.AfterFailure, &plain.AfterFailure},
	}
	for _, ph := range phases {
		for i, e := range ph.entries {
			if e.Script != "" {
				return nil, errs.Config("%s: hooks.%s[%d]: a plugin's hook has no script: upload the script and run it with host:", at, ph.name, i)
			}
			if e.IfChanged != "" {
				if ph.name != domain.HookAfterDeploy {
					return nil, errs.Config("%s: hooks.%s[%d]: if_changed belongs to after_deploy hooks, which run once the uploads are done", at, ph.name, i)
				}
				if !dests[e.IfChanged] {
					return nil, errs.Config("%s: hooks.%s[%d]: if_changed %s is the destination of none of the plugin's uploads", at, ph.name, i, e.IfChanged)
				}
			}
			*ph.out = append(*ph.out, e.HookEntry)
			ifChanged = append(ifChanged, e.IfChanged)
		}
	}
	out, err := config.ParseHooks(&plain)
	if err != nil {
		if e, ok := errs.As(err); ok {
			e.Message = at + ": " + e.Message
			return nil, e
		}
		return nil, err
	}
	for i := range out {
		out[i].Plugin, out[i].IfChanged = id, ifChanged[i]
		out[i].Name = id + ": " + out[i].Name
	}
	return out, nil
}

// decode renders every string of n with Jinja, then decodes it into out, unknown keys refused.
func decode(n *yaml.Node, ctx map[string]any, out any) error {
	if n.Kind == 0 {
		return nil
	}
	c := clone(n)
	if err := renderNode(c, ctx); err != nil {
		return err
	}
	b, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err := dec.Decode(out); err != nil {
		return errs.Config("%s", strings.TrimPrefix(err.Error(), "yaml: "))
	}
	return nil
}

func renderNode(n *yaml.Node, ctx map[string]any) error {
	switch n.Kind {
	case yaml.ScalarNode:
		if (n.Tag != "" && n.Tag != "!!str") || !strings.ContainsAny(n.Value, "{") {
			return nil
		}
		if !strings.Contains(n.Value, "{{") && !strings.Contains(n.Value, "{%") && !strings.Contains(n.Value, "{#") {
			return nil
		}
		out, err := render.String(n.Value, ctx)
		if err != nil {
			return errs.Config("%q cannot be rendered: %v", n.Value, err)
		}
		// typed again from what it renders to: "{{ strict }}" can be a boolean
		n.Value, n.Tag, n.Style = out, "", 0
	default:
		for i, c := range n.Content {
			// keys are never rendered
			if n.Kind == yaml.MappingNode && i%2 == 0 {
				continue
			}
			if err := renderNode(c, ctx); err != nil {
				return err
			}
		}
	}
	return nil
}

func clone(n *yaml.Node) *yaml.Node {
	c := *n
	c.Content = make([]*yaml.Node, len(n.Content))
	for i, x := range n.Content {
		c.Content[i] = clone(x)
	}
	return &c
}
