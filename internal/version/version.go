// Package version holds the version of the binary, set at build time with
// -ldflags "-X github.com/Shawiizz/dockflow/internal/version.Version=1.0.0".
// The version has no "v"; the tag of its release does (v1.0.0).
package version

// Version is "dev" for builds that are not releases.
var Version = "dev"
