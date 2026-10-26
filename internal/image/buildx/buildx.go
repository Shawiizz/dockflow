// Package buildx builds images with `docker buildx bake` on the machine running the CLI
// (ADR-0009). It writes the bake definition itself, from the Compose build keys Dockflow has
// already interpolated, so variables and secrets apply to builds as they do to services.
package buildx

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/image"
)

// builderName is the docker-container builder Dockflow creates when the default builder cannot
// export OCI images (the docker driver without the containerd image store).
const builderName = "dockflow"

// Builder runs buildx bake.
type Builder struct {
	// Docker is the docker CLI; default "docker".
	Docker string
	// Env is added to bake's environment (SOURCE_DATE_EPOCH, for example).
	Env []string
	// Load, when set, loads each image into the daemon bake reaches, under the names it returns,
	// instead of writing OCI layouts: remote builds, where Env points DOCKER_HOST at the server.
	Load func(service string) []string
}

var _ image.Builder = (*Builder)(nil)

type target struct {
	Context          string            `json:"context"`
	Contexts         map[string]string `json:"contexts,omitempty"`
	Dockerfile       string            `json:"dockerfile,omitempty"`
	DockerfileInline string            `json:"dockerfile-inline,omitempty"`
	Args             map[string]string `json:"args,omitempty"`
	Labels           map[string]string `json:"labels,omitempty"`
	Target           string            `json:"target,omitempty"`
	CacheFrom        []string          `json:"cache-from,omitempty"`
	CacheTo          []string          `json:"cache-to,omitempty"`
	NoCache          bool              `json:"no-cache,omitempty"`
	NoCacheFilter    []string          `json:"no-cache-filter,omitempty"`
	Pull             bool              `json:"pull,omitempty"`
	ExtraHosts       map[string]string `json:"extra-hosts,omitempty"`
	Network          string            `json:"network,omitempty"`
	SSH              []string          `json:"ssh,omitempty"`
	ShmSize          string            `json:"shm-size,omitempty"`
	Entitlements     []string          `json:"entitlements,omitempty"`
	Platforms        []string          `json:"platforms"`
	Output           []string          `json:"output"`
}

type definition struct {
	Group  map[string]map[string][]string `json:"group"`
	Target map[string]target              `json:"target"`
}

// Definition returns the bake definition for builds, written as OCI layouts under dir, or loaded
// under the names load returns when it is set.
func Definition(builds []image.Build, platform, dir string, load func(service string) []string) ([]byte, error) {
	def := definition{Group: map[string]map[string][]string{"default": {"targets": {}}}, Target: map[string]target{}}
	for _, b := range builds {
		t := target{
			Context: b.Context, Contexts: b.AdditionalContexts, Dockerfile: b.Dockerfile, DockerfileInline: b.DockerfileInline,
			Args: b.Args, Labels: b.Labels, Target: b.Target, CacheFrom: b.CacheFrom, CacheTo: b.CacheTo,
			NoCache: b.NoCache, NoCacheFilter: b.NoCacheFilter, Pull: b.Pull, Network: b.Network, SSH: b.SSH,
			Entitlements: b.Entitlements, Platforms: []string{platform},
			Output: []string{"type=oci,tar=false,dest=" + filepath.Join(dir, b.Service)},
		}
		if load != nil {
			t.Output = []string{`type=docker,"name=` + strings.Join(load(b.Service), ",") + `"`}
		}
		if b.ShmSize > 0 {
			t.ShmSize = strconv.FormatInt(b.ShmSize, 10) + "b"
		}
		if len(b.ExtraHosts) > 0 {
			t.ExtraHosts = map[string]string{}
			for _, h := range b.ExtraHosts {
				if name, ip, ok := strings.Cut(h, ":"); ok {
					t.ExtraHosts[name] = ip
				}
			}
		}
		def.Group["default"]["targets"] = append(def.Group["default"]["targets"], b.Service)
		def.Target[b.Service] = t
	}
	sort.Strings(def.Group["default"]["targets"])
	return json.MarshalIndent(def, "", "  ")
}

// Build runs bake for every build and returns the OCI layouts it wrote, or the images it loaded.
func (bx *Builder) Build(ctx context.Context, builds []image.Build, platform, dir string, log func(service, line string)) ([]image.Built, error) {
	if len(builds) == 0 {
		return nil, nil
	}
	def, err := Definition(builds, platform, dir, bx.Load)
	if err != nil {
		return nil, errs.Internal("bake definition: %v", err)
	}
	file := filepath.Join(dir, "bake.json")
	if err := os.WriteFile(file, def, 0o600); err != nil {
		return nil, errs.Internal("write the bake definition: %v", err)
	}
	services := make([]string, 0, len(builds))
	for _, b := range builds {
		services = append(services, b.Service)
	}
	builder := ""
	if bx.Load != nil {
		// the builder of the daemon DOCKER_HOST names, whatever builder this machine uses
		builder = "default"
	}
	out, err := bx.bake(ctx, file, builder, services, log)
	if err != nil && bx.Load == nil && unsupportedExporter(out) {
		if err := bx.ensureBuilder(ctx); err != nil {
			return nil, err
		}
		_, err = bx.bake(ctx, file, builderName, services, log)
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, errs.New("run.cancelled", errs.ExitInterrupted, "the build was cancelled")
		}
		return nil, errs.New("build.failed", errs.ExitBuild, "the build failed").WithCause(err).
			WithHint("the build output above says why; nothing was changed on the server")
	}
	built := make([]image.Built, 0, len(builds))
	for _, b := range builds {
		if bx.Load != nil {
			built = append(built, image.Built{Service: b.Service, Image: bx.Load(b.Service)[0]})
			continue
		}
		built = append(built, image.Built{Service: b.Service, Layout: filepath.Join(dir, b.Service)})
	}
	return built, nil
}

func unsupportedExporter(out string) bool {
	return strings.Contains(out, "exporter is not supported for the docker driver") ||
		strings.Contains(out, "OCI exporter is not supported")
}

func (bx *Builder) docker() string {
	if bx.Docker != "" {
		return bx.Docker
	}
	return "docker"
}

// vertex matches bake's plain progress lines that name a target: "#7 [web 2/4] RUN …".
var vertex = regexp.MustCompile(`^#\d+ \[([a-z][a-z0-9-]*)[ \]]`)

func (bx *Builder) bake(ctx context.Context, file, builder string, services []string, log func(service, line string)) (string, error) {
	args := []string{"buildx", "bake", "-f", file, "--progress=plain"}
	if builder != "" {
		args = append(args, "--builder", builder)
	}
	cmd := exec.CommandContext(ctx, bx.docker(), args...)
	cmd.Env = append(os.Environ(), bx.Env...)
	// the definition and the outputs live in a temporary directory, the contexts in the project:
	// bake's filesystem entitlements would refuse both
	cmd.Env = append(cmd.Env, "BUILDX_BAKE_ENTITLEMENTS_FS=0")
	// a provenance attestation records when the image was built: the same code would make a new
	// image, and a deploy that changes nothing would replace the containers
	cmd.Env = append(cmd.Env, "BUILDX_NO_DEFAULT_ATTESTATIONS=1")
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	known := map[string]bool{}
	for _, s := range services {
		known[s] = true
	}
	var all bytes.Buffer
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		owner := map[string]string{} // vertex number → service
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
		for sc.Scan() {
			line := sc.Text()
			all.WriteString(line + "\n")
			svc := ""
			num, _, _ := strings.Cut(line, " ")
			if m := vertex.FindStringSubmatch(line); m != nil && known[m[1]] {
				owner[num] = m[1]
			}
			svc = owner[num]
			if len(services) == 1 {
				// bake names targets in its output only when it builds several
				svc = services[0]
			}
			if log != nil {
				log(svc, line)
			}
		}
	}()
	if err := cmd.Start(); err != nil {
		pw.Close()
		wg.Wait()
		return "", errs.New("build.no_buildx", errs.ExitBuild, "cannot run docker buildx").WithCause(err).
			WithHint("building images needs Docker with buildx on this machine")
	}
	err := cmd.Wait()
	pw.Close()
	wg.Wait()
	return all.String(), err
}

func (bx *Builder) ensureBuilder(ctx context.Context) error {
	if err := exec.CommandContext(ctx, bx.docker(), "buildx", "inspect", builderName).Run(); err == nil {
		return nil
	}
	out, err := exec.CommandContext(ctx, bx.docker(), "buildx", "create", "--name", builderName, "--driver", "docker-container").CombinedOutput()
	if err != nil {
		return errs.New("build.no_builder", errs.ExitBuild, "cannot create the dockflow buildx builder").
			WithCause(errs.Internal("%s", strings.TrimSpace(string(out)))).
			WithHint("the default builder cannot export images; enable the containerd image store, or create a docker-container builder")
	}
	return nil
}
