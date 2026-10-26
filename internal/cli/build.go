package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"regexp"
	"runtime"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/image"
	"github.com/Shawiizz/dockflow/internal/image/buildx"
	"github.com/Shawiizz/dockflow/internal/image/oci"
	"github.com/Shawiizz/dockflow/internal/project"
)

// buildTail is how many lines of a failed build are shown without --verbose.
const buildTail = 40

// build builds the images of l for platform, keeping only the services in only when given.
// The layouts live in dir.
func (a *app) build(ctx context.Context, l *project.Loaded, platform, dir string, only []string) ([]image.Built, error) {
	builds, err := selectBuilds(l.Builds, only)
	if err != nil || len(builds) == 0 {
		return nil, err
	}
	names := make([]string, 0, len(builds))
	for _, b := range builds {
		names = append(names, b.Service)
	}
	a.emitter.Info(events.BuildStarted, fmt.Sprintf("building %s for %s", strings.Join(names, ", "), platform),
		map[string]any{"services": names, "platforms": []string{platform}})
	var tail []string
	log := func(svc, line string) {
		tail = append(tail, line)
		if len(tail) > buildTail {
			tail = tail[1:]
		}
		a.emitter.Debug(events.BuildLog, line, map[string]any{"service": svc, "line": line})
	}
	built, err := (&buildx.Builder{}).Build(ctx, builds, platform, dir, log)
	if err != nil {
		if !a.verbose {
			for _, line := range tail {
				a.emitter.Errorf(events.BuildLog, line, map[string]any{"line": line})
			}
		}
		return nil, err
	}
	for _, b := range built {
		img, err := oci.Image(b.Layout)
		if err != nil {
			return nil, errs.Internal("read the image of %s: %v", b.Service, err)
		}
		d, _ := img.Digest()
		a.emitter.Info(events.BuildFinished, b.Service+" built", map[string]any{"service": b.Service, "digest": d.String()})
	}
	return built, nil
}

func selectBuilds(all []image.Build, only []string) ([]image.Build, error) {
	if len(only) == 0 {
		return all, nil
	}
	byName := map[string]image.Build{}
	for _, b := range all {
		byName[b.Service] = b
	}
	var out []image.Build
	for _, name := range only {
		b, ok := byName[name]
		if !ok {
			return nil, errs.Usage("%s is not a service with a build", name)
		}
		out = append(out, b)
	}
	return out, nil
}

var tagUnsafe = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

// imageTag is the version label as an image tag.
func imageTag(version string) string {
	t := strings.TrimLeft(tagUnsafe.ReplaceAllString(version, "-"), ".-")
	if t == "" {
		t = "latest"
	}
	if len(t) > 128 {
		t = t[:128]
	}
	return t
}

// destination is where the image of service goes: the external registry, or the server's own
// through the SSH tunnel.
func destination(l *project.Loaded, service string) image.Destination {
	tag := imageTag(l.Version)
	if r := l.Config.Registry; r != nil {
		return image.Destination{
			Repository: r.URL + "/" + l.Config.App + "/" + service, Tags: append([]string{tag}, r.AdditionalTags...),
			Username: r.Username, Password: r.Password,
		}
	}
	return image.Destination{Repository: agent.RegistryAddr + "/" + l.Config.App + "/" + service, Tags: []string{tag}, Insecure: true}
}

// ship builds the session's images, pushes them, and pins each built service to its digest.
func (s *session) ship(ctx context.Context, only []string) error {
	l := s.loaded
	if len(l.Builds) == 0 {
		return nil
	}
	dir, err := os.MkdirTemp("", "dockflow-build-")
	if err != nil {
		return errs.Internal("temporary directory: %v", err)
	}
	defer os.RemoveAll(dir)
	built, err := s.app.build(ctx, l, "linux/"+s.info.Arch, dir, only)
	if err != nil {
		return err
	}
	pusher := &oci.Pusher{}
	if l.Config.Registry == nil {
		pusher.Dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return s.ssh.DialContext(ctx, "tcp", agent.RegistryAddr)
		}
	}
	for _, b := range built {
		d := destination(l, b.Service)
		p, err := pusher.Push(ctx, b, d)
		if err != nil {
			return err
		}
		s.app.emitter.Info(events.PushFinished, fmt.Sprintf("%s pushed (%d layers sent, %d already there)", b.Service, p.BlobsSent, p.BlobsSkipped),
			map[string]any{"image": p.Ref, "digest": p.Digest, "blobs_sent": p.BlobsSent, "blobs_skipped": p.BlobsSkipped})
		svc, _ := l.App.Service(b.Service)
		svc.Spec.Image = p.Ref
	}
	return nil
}

// registryAuth are the credentials the agent pulls with, for an external registry.
func registryAuth(l *project.Loaded) *engine.RegistryAuth {
	r := l.Config.Registry
	if r == nil || r.Username == "" {
		return nil
	}
	host, _, _ := strings.Cut(r.URL, "/")
	return &engine.RegistryAuth{Server: host, Username: r.Username, Password: r.Password}
}

func (a *app) buildCmd() *cobra.Command {
	var only []string
	var push bool
	var platform string
	cmd := &cobra.Command{
		Use:   "build [<env>]",
		Short: "Build the images, without deploying",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if push {
				s, err := a.connect(ctx, envArg(args), "")
				if err != nil {
					return err
				}
				defer s.Close()
				if len(s.loaded.Builds) == 0 {
					return errs.Usage("no service of %s has a build", s.loaded.Config.Env)
				}
				return s.ship(ctx, only)
			}
			l, err := a.load(ctx, envArg(args), "")
			if err != nil {
				return err
			}
			if len(l.Builds) == 0 {
				return errs.Usage("no service of %s has a build", l.Config.Env)
			}
			if platform == "" {
				platform = "linux/" + runtime.GOARCH
			}
			dir, err := os.MkdirTemp("", "dockflow-build-")
			if err != nil {
				return errs.Internal("temporary directory: %v", err)
			}
			defer os.RemoveAll(dir)
			_, err = a.build(ctx, l, platform, dir, only)
			return err
		},
	}
	f := cmd.Flags()
	f.StringSliceVar(&only, "only", nil, "build these services only")
	f.BoolVar(&push, "push", false, "also push the images to the registry the environment deploys from")
	f.StringVar(&platform, "platform", "", "the platform to build for, without --push (default linux/<this machine's architecture>)")
	return cmd
}
