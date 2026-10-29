package agent

import (
	"strings"

	"github.com/distribution/reference"
)

// The third-party images Dockflow runs on servers by default. Each is pinned to a release and to
// the digest of its multi-platform index, so that every server on a version of Dockflow runs the
// same images, on amd64 and arm64 alike. scripts/bump-images.sh moves each one to the newest
// release of its major version; the CI then runs the e2e suite on them.
const (
	// DefaultSwitchImage is the official Caddy image: the switch, and the server of files routes.
	DefaultSwitchImage = "caddy:2.11.7@sha256:5e5286cb37d44086d651a5363f05f43a692ce4d649d88fb1bd844579f45fa9e8"
	// DefaultRegistryImage is the CNCF distribution registry: the server-local registry.
	DefaultRegistryImage = "registry:3.1.2@sha256:d4032d4cc323c1731c707931ecada07a53076eac38e3b61ae57533f170f2c6c3"
	// DefaultResticImage is restic's official image, which backups run.
	DefaultResticImage = "restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510"
)

// sameRepository tells whether two image references name the same repository, whatever their
// tags and digests: caddy and docker.io/library/caddy are one.
func sameRepository(a, b string) bool {
	if strings.HasPrefix(a, "sha256:") || strings.HasPrefix(b, "sha256:") {
		return false
	}
	na, err := reference.ParseNormalizedNamed(a)
	if err != nil {
		return false
	}
	nb, err := reference.ParseNormalizedNamed(b)
	return err == nil && na.Name() == nb.Name()
}
