// Package podman builds images with `podman build` on the machine running the CLI, one service
// after the other, from the Compose build keys Dockflow has already interpolated (ADR-0009). Each
// image is exported as an OCI image layout, which the registry client pushes as it does bake's.
package podman

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/image"
)

// Builder runs podman.
type Builder struct {
	// Podman is the podman CLI; default "podman".
	Podman string
	// Args are passed to podman before the subcommand (--storage-driver, for example).
	Args []string
	// Env is added to podman's environment.
	Env []string
}

var _ image.Builder = (*Builder)(nil)

// BuildArgs returns the arguments of `podman build` for b. file is the Dockerfile to use when b
// gives it inline.
func BuildArgs(b image.Build, platform, iidfile, file string) []string {
	args := []string{"build", "--platform", platform, "--iidfile", iidfile, "-t", "localhost/dockflow-build/" + b.Service}
	switch {
	case file != "":
		args = append(args, "-f", file)
	case b.Dockerfile != "" && filepath.IsAbs(b.Dockerfile):
		args = append(args, "-f", b.Dockerfile)
	case b.Dockerfile != "":
		args = append(args, "-f", filepath.Join(b.Context, b.Dockerfile))
	}
	for _, k := range sorted(b.Args) {
		args = append(args, "--build-arg", k+"="+b.Args[k])
	}
	for _, k := range sorted(b.Labels) {
		args = append(args, "--label", k+"="+b.Labels[k])
	}
	for _, k := range sorted(b.AdditionalContexts) {
		args = append(args, "--build-context", k+"="+b.AdditionalContexts[k])
	}
	if b.Target != "" {
		args = append(args, "--target", b.Target)
	}
	for _, c := range b.CacheFrom {
		args = append(args, "--cache-from", c)
	}
	for _, c := range b.CacheTo {
		args = append(args, "--cache-to", c)
	}
	if b.NoCache {
		args = append(args, "--no-cache")
	}
	if b.Pull {
		args = append(args, "--pull")
	}
	if b.Network != "" {
		args = append(args, "--network", b.Network)
	}
	for _, h := range b.ExtraHosts {
		args = append(args, "--add-host", h)
	}
	for _, s := range b.SSH {
		args = append(args, "--ssh", s)
	}
	if b.ShmSize > 0 {
		args = append(args, "--shm-size", strconv.FormatInt(b.ShmSize, 10)+"b")
	}
	return append(args, b.Context)
}

func sorted(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Build builds every image and writes each to an OCI layout under dir.
func (p *Builder) Build(ctx context.Context, builds []image.Build, platform, dir string, log func(service, line string)) ([]image.Built, error) {
	built := make([]image.Built, 0, len(builds))
	for _, b := range builds {
		iid := filepath.Join(dir, b.Service+".iid")
		file := ""
		if b.DockerfileInline != "" {
			file = filepath.Join(dir, b.Service+".Dockerfile")
			if err := os.WriteFile(file, []byte(b.DockerfileInline), 0o600); err != nil {
				return nil, errs.Internal("write the Dockerfile of %s: %v", b.Service, err)
			}
		}
		if err := p.run(ctx, b.Service, BuildArgs(b, platform, iid, file), log); err != nil {
			return nil, failure(ctx, err)
		}
		id, err := os.ReadFile(iid)
		if err != nil {
			return nil, errs.Internal("read the image ID of %s: %v", b.Service, err)
		}
		layout := filepath.Join(dir, b.Service)
		if err := p.run(ctx, b.Service, []string{"push", "--quiet", strings.TrimSpace(string(id)), "oci:" + layout}, log); err != nil {
			return nil, failure(ctx, err)
		}
		built = append(built, image.Built{Service: b.Service, Layout: layout})
	}
	return built, nil
}

func failure(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return errs.New("run.cancelled", errs.ExitInterrupted, "the build was cancelled")
	}
	if e, ok := err.(*errs.Error); ok {
		return e
	}
	return errs.New("build.failed", errs.ExitBuild, "the build failed").WithCause(err).
		WithHint("the build output above says why; nothing was changed on the server")
}

func (p *Builder) run(ctx context.Context, service string, args []string, log func(service, line string)) error {
	bin := p.Podman
	if bin == "" {
		bin = "podman"
	}
	cmd := exec.CommandContext(ctx, bin, append(append([]string(nil), p.Args...), args...)...)
	cmd.Env = append(os.Environ(), p.Env...)
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
		for sc.Scan() {
			if log != nil {
				log(service, sc.Text())
			}
		}
		io.Copy(io.Discard, pr)
	}()
	if err := cmd.Start(); err != nil {
		pw.Close()
		wg.Wait()
		return errs.New("build.no_podman", errs.ExitBuild, "cannot run podman").WithCause(err).
			WithHint("build.engine: podman needs Podman on this machine")
	}
	err := cmd.Wait()
	pw.Close()
	wg.Wait()
	return err
}
