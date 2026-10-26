// Package oci pushes OCI image layouts to registries with go-containerregistry (ADR-0009): blobs
// the registry already has are skipped.
package oci

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/layout"
	"github.com/google/go-containerregistry/pkg/v1/remote"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/image"
)

// Pusher pushes to registries. Dial, when set, opens every connection: the SSH tunnel to the
// server-local registry.
type Pusher struct {
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
}

var _ image.Pusher = (*Pusher)(nil)

// Image reads the single image of an OCI layout.
func Image(dir string) (v1.Image, error) {
	p, err := layout.FromPath(dir)
	if err != nil {
		return nil, err
	}
	idx, err := p.ImageIndex()
	if err != nil {
		return nil, err
	}
	m, err := idx.IndexManifest()
	if err != nil {
		return nil, err
	}
	if len(m.Manifests) != 1 {
		return nil, errs.Internal("%s holds %d images, not one", dir, len(m.Manifests))
	}
	return idx.Image(m.Manifests[0].Digest)
}

// Push sends the image of b to d and returns it pinned by digest.
func (p *Pusher) Push(ctx context.Context, b image.Built, d image.Destination) (*image.Pushed, error) {
	img, err := Image(b.Layout)
	if err != nil {
		return nil, errs.Internal("read the image of %s: %v", b.Service, err)
	}
	digest, err := img.Digest()
	if err != nil {
		return nil, errs.Internal("digest of %s: %v", b.Service, err)
	}
	var opts []name.Option
	if d.Insecure {
		opts = append(opts, name.Insecure)
	}
	tags := d.Tags
	if len(tags) == 0 {
		tags = []string{"latest"}
	}
	counter := &counting{base: p.transport()}
	ropts := []remote.Option{remote.WithContext(ctx), remote.WithTransport(counter)}
	if d.Username != "" || d.Password != "" {
		ropts = append(ropts, remote.WithAuth(&authn.Basic{Username: d.Username, Password: d.Password}))
	} else {
		ropts = append(ropts, remote.WithAuth(authn.Anonymous))
	}
	for i, tag := range tags {
		ref, err := name.NewTag(d.Repository+":"+tag, opts...)
		if err != nil {
			return nil, errs.Config("%s:%s is not a valid image name", d.Repository, tag).WithCause(err)
		}
		if i == 0 {
			err = remote.Write(ref, img, ropts...)
		} else {
			err = remote.Tag(ref, img, ropts...)
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil, errs.New("run.cancelled", errs.ExitInterrupted, "the push was cancelled")
			}
			return nil, errs.Newf("push.failed", errs.ExitBuild, "cannot push %s to %s", b.Service, d.Repository).WithCause(err).
				WithHint("%s", pushHint(d))
		}
	}
	layers, err := img.Layers()
	if err != nil {
		return nil, errs.Internal("layers of %s: %v", b.Service, err)
	}
	blobs := len(layers) + 1 // and the config
	sent := min(int(counter.sent.Load()), blobs)
	return &image.Pushed{
		Ref: d.Repository + "@" + digest.String(), Digest: digest.String(),
		BlobsSent: sent, BlobsSkipped: blobs - sent,
	}, nil
}

func pushHint(d image.Destination) string {
	if d.Insecure {
		return "check that the server's registry runs (`dockflow server init` installs it) and that SSH allows TCP forwarding"
	}
	return "check registry.url and its credentials"
}

func (p *Pusher) transport() http.RoundTripper {
	t := http.DefaultTransport.(*http.Transport).Clone()
	if p.Dial != nil {
		t.DialContext = p.Dial
		t.Proxy = nil
	}
	t.ResponseHeaderTimeout = 5 * time.Minute
	return t
}

// counting counts the blobs a push sends.
type counting struct {
	base http.RoundTripper
	sent atomic.Int64
}

func (c *counting) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := c.base.RoundTrip(r)
	if err != nil {
		return resp, err
	}
	if r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/blobs/uploads/") && resp.StatusCode == http.StatusCreated {
		c.sent.Add(1)
	}
	return resp, err
}
