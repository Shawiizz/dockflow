# ADR-0020: Releasing Dockflow itself: signed binaries, version-pinned agent

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (version numbers)

## Context

The CLI ships its own Linux binary to servers ([ADR-0004](0004-ephemeral-agent.md)) and to servers being provisioned ([ADR-0013](0013-servers-access-security.md)), so it needs that binary for the server's architecture, at exactly its own version. Dockflow 1.x checks downloads against a `SHA256SUMS` file from the same release, which proves integrity but not origin. Its npm wrapper depends on a postinstall script.

## Decision

### Release artifacts

- A git tag `vX.Y.Z` builds static binaries for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64 and windows/amd64, then publishes them with a `SHA256SUMS` file.
- The checksums are signed with Sigstore cosign, keyless, bound to the repository's release workflow identity.
- The release runs only after the e2e suite has passed on those binaries.

### How the CLI gets the Linux binary

- If the CLI is itself the Linux binary for the target's architecture, it sends itself.
- Otherwise it downloads the binary of its own version, verifies the checksum and the signature, and caches it in the user cache directory (`~/.cache/dockflow/<version>/`).
- `DOCKFLOW_AGENT_BINARY=<path>` overrides this for development builds, which have no published release. `DOCKFLOW_RELEASES_URL` replaces the release download URL (a mirror).

### Installation channels

- A `curl | sh` installer and a PowerShell one, both verifying the signature.
- Homebrew.
- An npm package built on per-platform `optionalDependencies`, as esbuild and Biome do, so it needs no postinstall script and works behind proxies.

### Versioning

- Semantic versioning, with tags `v<semver>`.
- Release numbers continue the repository's sequence: its earlier releases go up to 3.x, so this line starts at **4.0.0**. A package manager, an installer or a person comparing numbers then sees it as newer, and no number is published twice (npm refuses that). "v2" stays the name of the rewrite and of its branch, not a version number.
- Until the roadmap's v1.0 milestone, releases are pre-releases, one or more per milestone: `v4.0.0-alpha.N`. The v1.0 milestone ships as `v4.0.0`.
- The configuration format, the state format and the event schema have their own version numbers (`version: 1`, `schema: 1`, `v: 1`) and change only in a major release.

## Consequences

- A server only ever runs a binary whose origin is verified.
- The CLI and the agent are always the same version, so their protocol is internal.
- Development builds need either a Linux machine or the override variable.

## Implementation status (M2)

- `.github/workflows/v2-release.yml` runs on a tag `v*`, or on a commit of the `v2` branch that writes the version into `.github/release` (the release then creates the tag on that commit): the whole CI on the released commit, then the binaries, `SHA256SUMS` signed keyless with cosign (`SHA256SUMS.sigstore.json`), and a GitHub release. Releases are never marked as the repository's latest; a tag with a pre-release suffix makes a pre-release.
- `install.sh` checks the binary against `SHA256SUMS`, and `SHA256SUMS` against its signature when cosign is installed (identity: this repository's release workflow, at a `v` tag or on the `v2` branch).
- The CLI downloads the agent binary over HTTPS and checks it against `SHA256SUMS`; it does not check the signature yet. That check, the PowerShell installer, Homebrew and the npm package come with the signed releases of v1.0 ([roadmap](../roadmap.md)).

## Embedding the Linux binaries

Decided in M1: not embedded. The CLI downloads the binary it needs, as above. Embedding both Linux binaries would add about 40 MB to every CLI, for the benefit of offline machines that deploy from macOS or Windows, which `DOCKFLOW_AGENT_BINARY` already covers.
