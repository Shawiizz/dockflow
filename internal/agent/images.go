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
	DefaultSwitchImage = "caddy:2.11.9@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b"
	// DefaultRegistryImage is the CNCF distribution registry: the server-local registry.
	DefaultRegistryImage = "registry:3.1.2@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c"
	// DefaultResticImage is restic's official image, which backups run.
	DefaultResticImage = "restic/restic:0.20.0@sha256:93999df80d4ac6cb148e82d2ef1fe6a81996f17ff535e772723538211b31555a"
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
