// Package version holds the version of the binary, set at build time with
// -ldflags "-X github.com/Shawiizz/dockflow/internal/version.Version=1.0.0".
// The version has no "v"; the tag of its release does (v1.0.0).
package version

import (
	"strconv"
	"strings"
)

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

// Valid tells whether v is a version: 1.2, 1.2.3 or 1.2.3-alpha.1, without a v.
func Valid(v string) bool {
	_, _, ok := parse(v)
	return ok
}

// AtLeast tells whether v is min or later, by semantic versioning: a pre-release comes before
// its release (1.0.0-alpha.3 is before 1.0.0). known is false when v is not a release version,
// such as a development build: nothing can be said of it.
func AtLeast(v, min string) (ok, known bool) {
	vc, vp, vok := parse(v)
	mc, mp, mok := parse(min)
	if !vok || !mok {
		return false, false
	}
	for i := range vc {
		if vc[i] != mc[i] {
			return vc[i] > mc[i], true
		}
	}
	return comparePre(vp, mp) >= 0, true
}

// parse splits 1.2.3-alpha.1 into its numbers and its pre-release; 1.2 is 1.2.0.
func parse(v string) (core [3]int, pre string, ok bool) {
	v, pre, _ = strings.Cut(v, "-")
	parts := strings.Split(v, ".")
	if len(parts) < 2 || len(parts) > 3 {
		return core, "", false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || p == "" || (len(p) > 1 && p[0] == '0') {
			return core, "", false
		}
		core[i] = n
	}
	return core, pre, true
}

// comparePre orders pre-releases as semantic versioning does: none is the release, after all of
// them; numeric identifiers compare as numbers, before alphanumeric ones.
func comparePre(a, b string) int {
	switch {
	case a == b:
		return 0
	case a == "":
		return 1
	case b == "":
		return -1
	}
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		an, aerr := strconv.Atoi(as[i])
		bn, berr := strconv.Atoi(bs[i])
		switch {
		case aerr == nil && berr == nil && an != bn:
			if an < bn {
				return -1
			}
			return 1
		case aerr == nil && berr != nil:
			return -1
		case aerr != nil && berr == nil:
			return 1
		case aerr != nil && as[i] != bs[i]:
			return strings.Compare(as[i], bs[i])
		}
	}
	return len(as) - len(bs)
}
