package cli

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/upload"
)

// uploadHelperCmd runs in a helper container on the server, which mounts an upload's
// destination: it applies a manifest there and prints the digest of the manifest that restores
// it (ADR-0021).
func (a *app) uploadHelperCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "upload-helper",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var hr agent.HelperRequest
			if err := json.Unmarshal([]byte(os.Getenv(agent.HelperEnv)), &hr); err != nil {
				return errs.Internal("the helper's request is not valid: %v", err)
			}
			b, err := os.ReadFile(hr.Manifest)
			if err != nil {
				return errs.Internal("read the manifest: %v", err)
			}
			var m upload.Manifest
			if err := json.Unmarshal(b, &m); err != nil {
				return errs.Internal("the manifest is not valid: %v", err)
			}
			before, err := upload.Apply(hr.Target, &m, upload.Store(hr.Blobs), upload.Options{
				Mirror: hr.Mirror, Mode: fs.FileMode(hr.Mode), UID: hr.UID, GID: hr.GID,
			})
			if err != nil {
				fmt.Fprintln(a.stderr, err)
				os.Exit(1)
			}
			out, _ := json.Marshal(before)
			name := hr.Manifests + "/" + before.Digest()[len("sha256:"):] + ".json"
			if err := os.WriteFile(name, out, 0o600); err != nil {
				return errs.Internal("write the restore manifest: %v", err)
			}
			fmt.Fprintln(a.stdout, before.Digest())
			return nil
		},
	}
}
