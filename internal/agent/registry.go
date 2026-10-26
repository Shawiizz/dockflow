package agent

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// registryURL is how the agent reaches the server-local registry: its container's address on
// the bridge both share, since its published port listens on the host's loopback only.
func (r *runner) registryURL(ctx context.Context) (string, error) {
	c, err := r.Engine.Inspect(ctx, RegistryContainer)
	if err != nil {
		return "", err
	}
	for _, ip := range c.IPs {
		return "http://" + ip + ":5000", nil
	}
	return "", errs.Internal("the registry has no address")
}

// forgetImages deletes from the server-local registry the manifests of images no kept release
// uses; the registry's garbage collection then frees their layers.
func (r *runner) forgetImages(ctx context.Context, refs []string) {
	var local []string
	for _, ref := range refs {
		if strings.HasPrefix(ref, RegistryAddr+"/") && strings.Contains(ref, "@sha256:") {
			local = append(local, ref)
		}
	}
	if len(local) == 0 {
		return
	}
	base, err := r.registryURL(ctx)
	if err != nil {
		r.warn("cleanup.failed", "cannot reach the registry: "+err.Error())
		return
	}
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil}}
	for _, ref := range local {
		repo, digest, _ := strings.Cut(strings.TrimPrefix(ref, RegistryAddr+"/"), "@")
		repo, _, _ = strings.Cut(repo, ":")
		req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, fmt.Sprintf("%s/v2/%s/manifests/%s", base, repo, digest), nil)
		resp, err := client.Do(req)
		if err != nil {
			r.warn("cleanup.failed", "cannot delete "+ref+" from the registry: "+err.Error())
			continue
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusNotFound {
			r.warn("cleanup.failed", fmt.Sprintf("the registry refused to delete %s: status %d", ref, resp.StatusCode))
		}
	}
}

// collectRegistry runs the registry's garbage collection, which frees the layers no manifest
// uses any more.
func (r *runner) collectRegistry(ctx context.Context) error {
	ex, err := r.Engine.Exec(ctx, RegistryContainer, engine.ExecOptions{
		Cmd: []string{"registry", "garbage-collect", "--delete-untagged", "/etc/distribution/config.yml"},
	})
	if err != nil {
		return err
	}
	defer ex.Close()
	ex.Stdin.Close()
	// both streams come from one connection: read them together, or one blocks the other
	var stderr []byte
	done := make(chan struct{})
	go func() {
		stderr, _ = io.ReadAll(ex.Stderr)
		close(done)
	}()
	stdout, _ := io.ReadAll(ex.Stdout)
	<-done
	out := append(stdout, stderr...)
	code, err := ex.Wait(ctx)
	if err != nil {
		return err
	}
	if code != 0 {
		return errs.Newf("prune.registry", errs.ExitInternal, "the registry's garbage collection failed: %s", lastLine(string(out)))
	}
	return nil
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "\n"); i >= 0 {
		return s[i+1:]
	}
	return s
}
