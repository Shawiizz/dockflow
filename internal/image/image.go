// Package image is the port through which Dockflow builds images and sends them to a registry
// (ADR-0009). The buildx adapter lives in image/buildx, the registry client in image/oci.
package image

import (
	"fmt"
	"strings"
)

import "context"

// Build is how to build the image of one service: the Compose build keys, interpolated.
type Build struct {
	Service            string            `json:"service"`
	Context            string            `json:"context"` // an absolute path or a URL
	Dockerfile         string            `json:"dockerfile,omitempty"`
	DockerfileInline   string            `json:"dockerfile_inline,omitempty"`
	Args               map[string]string `json:"args,omitempty"`
	Labels             map[string]string `json:"labels,omitempty"`
	Target             string            `json:"target,omitempty"`
	CacheFrom          []string          `json:"cache_from,omitempty"`
	CacheTo            []string          `json:"cache_to,omitempty"`
	NoCache            bool              `json:"no_cache,omitempty"`
	NoCacheFilter      []string          `json:"no_cache_filter,omitempty"`
	AdditionalContexts map[string]string `json:"additional_contexts,omitempty"`
	Pull               bool              `json:"pull,omitempty"`
	ExtraHosts         []string          `json:"extra_hosts,omitempty"`
	Network            string            `json:"network,omitempty"`
	SSH                []string          `json:"ssh,omitempty"` // id=path, or default
	ShmSize            int64             `json:"shm_size,omitempty"`
	Entitlements       []string          `json:"entitlements,omitempty"`
	// Secrets reach the build without staying in the image (ADR-0012).
	Secrets []BuildSecret `json:"secrets,omitempty"`
}

// BuildSecret is a secret a build mounts: a file, or a value handed to the builder through its
// environment, never its command line.
type BuildSecret struct {
	ID    string `json:"id"`
	File  string `json:"file,omitempty"`
	Value string `json:"-"`
}

// SecretFlags returns the builder's secret flags (id=…,src=… or id=…,env=…) and the environment
// that carries the values.
func (b Build) SecretFlags() (flags, env []string) {
	for i, s := range b.Secrets {
		if s.File != "" {
			flags = append(flags, "id="+s.ID+",src="+s.File)
			continue
		}
		name := fmt.Sprintf("DOCKFLOW_BUILD_SECRET_%d_%s", i, strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(b.Service)))
		flags = append(flags, "id="+s.ID+",env="+name)
		env = append(env, name+"="+s.Value)
	}
	return flags, env
}

// Built is a built image: an OCI image layout on the local disk, or an image loaded into the
// daemon the build ran on.
type Built struct {
	Service string
	Layout  string
	// Image is the name of the loaded image, for a build that loads instead of writing a layout.
	Image string
}

// Builder builds images for one platform.
type Builder interface {
	// Build builds every image, writing each to an OCI layout under dir. log receives the build
	// output, line by line.
	Build(ctx context.Context, builds []Build, platform, dir string, log func(service, line string)) ([]Built, error)
}

// Destination is where an image is pushed.
type Destination struct {
	// Repository is the image's name without tag: 127.0.0.1:5959/shop/web, ghcr.io/acme/shop/web.
	Repository string
	Tags       []string
	Username   string
	Password   string
	// Insecure pushes over plain HTTP (the server-local registry, through the SSH tunnel).
	Insecure bool
}

// Pushed is the result of a push.
type Pushed struct {
	// Ref is the image pinned by digest: <repository>@sha256:….
	Ref          string
	Digest       string
	BlobsSent    int
	BlobsSkipped int
}

// Pusher sends built images to a registry, skipping the blobs it already has.
type Pusher interface {
	Push(ctx context.Context, b Built, d Destination) (*Pushed, error)
}
