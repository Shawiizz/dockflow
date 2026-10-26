package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/connection"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/image"
	"github.com/Shawiizz/dockflow/internal/image/buildx"
	"github.com/Shawiizz/dockflow/internal/image/oci"
	"github.com/Shawiizz/dockflow/internal/image/podman"
	"github.com/Shawiizz/dockflow/internal/project"
	"github.com/Shawiizz/dockflow/internal/render"
)

// buildTail is how many lines of a failed build are shown without --verbose.
const buildTail = 40

// workspace renders the templates in a temporary copy of the build contexts and upload
// sources (ADR-0006).
func workspace(l *project.Loaded) (*render.Workspace, error) {
	dirs := make([]string, 0, len(l.Builds)+len(l.Config.Uploads))
	for _, b := range l.Builds {
		dirs = append(dirs, b.Context)
	}
	for _, u := range l.Config.Uploads {
		dirs = append(dirs, filepath.Join(l.Config.Dir, u.Src))
	}
	return render.Prepare(l.Config.Dir, l.Config.Templates, l.Values, dirs)
}

// build builds the images of l for platform with bld, keeping only the services in only when
// given, from the rendered workspace. The layouts live in dir. digest names the built image's
// content for the build.finished event.
func (a *app) build(ctx context.Context, l *project.Loaded, ws *render.Workspace, platform, dir string, only []string,
	bld image.Builder, digest func(image.Built) (string, error)) ([]image.Built, error) {
	builds, err := selectBuilds(l.Builds, only)
	if err != nil || len(builds) == 0 {
		return nil, err
	}
	for i := range builds {
		b := &builds[i]
		if filepath.IsAbs(b.Dockerfile) {
			b.Dockerfile = ws.Path(b.Dockerfile)
		}
		b.Context = ws.Path(b.Context)
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
	built, err := bld.Build(ctx, builds, platform, dir, log)
	if err != nil {
		if !a.verbose {
			for _, line := range tail {
				a.emitter.Errorf(events.BuildLog, line, map[string]any{"line": line})
			}
		}
		return nil, err
	}
	for _, b := range built {
		d, err := digest(b)
		if err != nil {
			return nil, err
		}
		a.emitter.Info(events.BuildFinished, b.Service+" built", map[string]any{"service": b.Service, "digest": d})
	}
	return built, nil
}

// localBuilder is the builder of the machine running the CLI.
func localBuilder(l *project.Loaded) image.Builder {
	if l.Config.Build.Engine == "podman" {
		return &podman.Builder{}
	}
	return &buildx.Builder{}
}

// layoutDigest is the digest of an image written as an OCI layout.
func layoutDigest(b image.Built) (string, error) {
	img, err := oci.Image(b.Layout)
	if err != nil {
		return "", errs.Internal("read the image of %s: %v", b.Service, err)
	}
	d, err := img.Digest()
	if err != nil {
		return "", errs.Internal("read the image of %s: %v", b.Service, err)
	}
	return d.String(), nil
}

func selectBuilds(all []image.Build, only []string) ([]image.Build, error) {
	if len(only) == 0 {
		// a copy: the caller points contexts at the rendered workspace
		return append([]image.Build(nil), all...), nil
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

// ship builds the session's images, sends them to the server, and pins each built service to
// its content.
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
	ws, err := s.workspace()
	if err != nil {
		return err
	}
	if l.Config.Build.Builder == "remote" {
		return s.buildRemote(ctx, ws, dir, only)
	}
	built, err := s.app.build(ctx, l, ws, "linux/"+s.info.Arch, dir, only, localBuilder(l), layoutDigest)
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

// buildRemote builds on the server's Docker, reached through a local socket forwarded over SSH
// (ADR-0009). The images land in the server's daemon; with an external registry, the server
// pushes them there too.
func (s *session) buildRemote(ctx context.Context, ws *render.Workspace, dir string, only []string) error {
	l := s.loaded
	sock, err := connection.Forward(connection.DockerDialer(s.ssh))
	if err != nil {
		return err
	}
	defer sock.Close()
	bx := &buildx.Builder{
		Env:  []string{"DOCKER_HOST=unix://" + sock.Path, "DOCKER_CONTEXT=", "BUILDX_BUILDER="},
		Load: func(service string) []string { return remoteNames(l, service) },
	}
	id := func(b image.Built) (string, error) {
		img, err := s.engine.InspectImage(ctx, b.Image)
		return img.ID, err
	}
	built, err := s.app.build(ctx, l, ws, "linux/"+s.info.Arch, dir, only, bx, id)
	if err != nil {
		return err
	}
	for _, b := range built {
		img, err := s.engine.InspectImage(ctx, b.Image)
		if err != nil {
			return err
		}
		ref := img.ID
		if l.Config.Registry != nil {
			d := destination(l, b.Service)
			for _, name := range remoteNames(l, b.Service) {
				if err := s.engine.PushImage(ctx, name, registryAuth(l)); err != nil {
					return err
				}
			}
			if img, err = s.engine.InspectImage(ctx, b.Image); err != nil {
				return err
			}
			for _, rd := range img.Digests {
				if repo, digest, ok := strings.Cut(rd, "@"); ok && repo == d.Repository {
					ref = d.Repository + "@" + digest
				}
			}
			s.app.emitter.Info(events.PushFinished, b.Service+" pushed from the server",
				map[string]any{"image": ref, "digest": strings.TrimPrefix(ref, d.Repository+"@")})
		}
		svc, _ := l.App.Service(b.Service)
		svc.Spec.Image = ref
	}
	return nil
}

// remoteNames are the names of an image built on the server: those of its external registry, or
// a local name the server never pulls (services run it by image ID).
func remoteNames(l *project.Loaded, service string) []string {
	if l.Config.Registry == nil {
		return []string{"localhost/" + l.Config.App + "/" + service + ":" + imageTag(l.Version)}
	}
	d := destination(l, service)
	names := make([]string, 0, len(d.Tags))
	for _, t := range d.Tags {
		names = append(names, d.Repository+":"+t)
	}
	return names
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
	var push, skipHooks bool
	var platform string
	cmd := &cobra.Command{
		Use:   "build [<env>]",
		Short: "Build the images, without deploying",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			l, err := a.load(ctx, envArg(args), "")
			if err != nil {
				return err
			}
			if len(l.Builds) == 0 {
				return errs.Usage("no service of %s has a build", l.Config.Env)
			}
			// a remote build lands on the server: it is pushed by nature
			if push || l.Config.Build.Builder == "remote" {
				s, err := a.connect(ctx, envArg(args), "")
				if err != nil {
					return err
				}
				defer s.Close()
				var hookList []domain.Hook
				if !skipHooks {
					if hookList, err = s.hooks(); err != nil {
						return err
					}
				}
				hk := s.hookRunner()
				if err := hk.Run(ctx, domain.HookBeforeBuild, hookList); err != nil {
					return err
				}
				if err := s.ship(ctx, only); err != nil {
					return err
				}
				return hk.Run(ctx, domain.HookAfterBuild, hookList)
			}
			if platform == "" {
				platform = "linux/" + runtime.GOARCH
			}
			dir, err := os.MkdirTemp("", "dockflow-build-")
			if err != nil {
				return errs.Internal("temporary directory: %v", err)
			}
			defer os.RemoveAll(dir)
			ws, err := workspace(l)
			if err != nil {
				return err
			}
			defer ws.Close()
			_, err = a.build(ctx, l, ws, platform, dir, only, localBuilder(l), layoutDigest)
			return err
		},
	}
	f := cmd.Flags()
	f.StringSliceVar(&only, "only", nil, "build these services only")
	f.BoolVar(&push, "push", false, "also push the images to the registry the environment deploys from")
	f.BoolVar(&skipHooks, "skip-hooks", false, "do not run the before_build and after_build hooks")
	f.StringVar(&platform, "platform", "", "the platform to build for, without --push (default linux/<this machine's architecture>)")
	return cmd
}
