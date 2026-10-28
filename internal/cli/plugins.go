package cli

import (
	"encoding/json"
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/plugin"
)

// pluginsCmd is `dockflow plugins` (ADR-0017).
func (a *app) pluginsCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "plugins", Short: "Plugins: bundles of uploads, templates and hooks"}
	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "The built-in plugins, and those the project uses, with their inputs",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			all, err := plugin.Builtins()
			if err != nil {
				return err
			}
			if inProject(a.dir) {
				raw, err := config.Read(a.dir)
				if err != nil {
					return err
				}
				for _, use := range raw.PluginUses() {
					if !plugin.IsPath(use) {
						continue
					}
					p, err := plugin.Load(a.dir, use)
					if err != nil {
						return err
					}
					all = append(all, p)
				}
			}
			if a.json {
				return json.NewEncoder(a.stdout).Encode(all)
			}
			for i, p := range all {
				if i > 0 {
					fmt.Fprintln(a.stdout)
				}
				fmt.Fprintf(a.stdout, "%s (%s): %s\n", p.Name, p.Source, p.Description)
				w := tabwriter.NewWriter(a.stdout, 0, 4, 2, ' ', 0)
				for _, in := range p.Inputs {
					about := []string{in.Type}
					if in.Required {
						about = append(about, "required")
					}
					if in.RequiredUnless != "" {
						about = append(about, "required without "+in.RequiredUnless)
					}
					if in.Default != nil {
						about = append(about, fmt.Sprintf("default %v", in.Default))
					}
					fmt.Fprintf(w, "  %s\t%s\t%s\n", in.Name, strings.Join(about, ", "), in.Description)
				}
				if err := w.Flush(); err != nil {
					return err
				}
			}
			return nil
		},
	})
	return cmd
}
