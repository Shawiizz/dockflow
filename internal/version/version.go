// Package version holds the version of the binary, set at build time with
// -ldflags "-X github.com/Shawiizz/dockflow/internal/version.Version=1.0.0".
// The version has no "v"; the tag of its release does (v1.0.0).
package version

import "strings"

// Version is "dev" for builds that are not releases.
var Version = "dev"

// Agents holds the SHA-256 of the agent binaries built with this one, set at build time:
// "amd64=<hex>,arm64=<hex>". The CLI checks the agent it downloads against it, so a server
// only runs a binary from the CLI's own build (ADR-0020).
var Agents = ""

// AgentSum returns the SHA-256 of the agent binary for linux/arch, or "" when the build has none.
func AgentSum(arch string) string {
	for _, kv := range strings.Split(Agents, ",") {
		if a, sum, ok := strings.Cut(kv, "="); ok && a == arch {
			return sum
		}
	}
	return ""
}
