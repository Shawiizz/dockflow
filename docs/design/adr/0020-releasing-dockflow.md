# ADR-0020: Releasing Dockflow itself: signed binaries, version-pinned agent

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 and 2026-10-28 (version numbers)

## Context

The CLI ships its own Linux binary to servers ([ADR-0004](0004-ephemeral-agent.md)) and to servers being provisioned ([ADR-0013](0013-servers-access-security.md)), so it needs that binary for the server's architecture, at exactly its own version. Dockflow 1.x checks downloads against a `SHA256SUMS` file from the same release, which proves integrity but not origin. Its npm wrapper depends on a postinstall script.

## Decision

### Release artifacts

- A git tag `vX.Y.Z` builds static binaries for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64 and windows/amd64, then publishes them with a `SHA256SUMS` file.
- The checksums are signed with Sigstore cosign, keyless, bound to the repository's release workflow identity.
- The release runs only after the e2e suite has passed on those binaries.

### How the CLI gets the Linux binary

- If the CLI is itself the Linux binary for the target's architecture, it sends itself.
- Otherwise it downloads the agent binary of its own version and caches it in the user cache directory (`~/.cache/dockflow/<version>/`). A release builds its two Linux agent binaries first, then every CLI with their SHA-256 (`-ldflags`); the CLI checks the download against them. The agent then comes from the CLI's own build, whose origin the installer checked (revised 2026-10-28: this replaces checking the Sigstore signature in the CLI, which would have taken the sigstore-go library and its TUF client, for no more assurance than the CLI's own). A CLI built without them checks against the release's `SHA256SUMS`.
- `DOCKFLOW_AGENT_BINARY=<path>` overrides this for development builds, which have no published release. `DOCKFLOW_RELEASES_URL` replaces the release download URL (a mirror).

### Installation channels

- A `curl | sh` installer and a PowerShell one, both verifying the signature when cosign is installed, the checksum always.
- Homebrew, from a formula committed in this repository by the release workflow: the repository is its own tap.
- An npm package built on per-platform `optionalDependencies`, as esbuild and Biome do, so it needs no postinstall script and works behind proxies.

### Versioning

- Semantic versioning. The tag of a release is `v<semver>`, as Go and GitHub Actions expect; the version the binary reports, the npm package and the documentation write it without the `v` (`1.0.0`).
- Numbering starts at **1.0.0**: the roadmap's v1.0 milestone ships as `v1.0.0`, and until then releases are pre-releases, one or more per milestone: `v1.0.0-alpha.N`. "v2" stays the name of the rewrite, not a version number.
- The tags and releases of Dockflow 1.x (up to 3.1.1, tagged without a `v`) and the first alphas of the rewrite (`v4.0.0-alpha.1` to `.10`) are deleted, so the repository's releases are this line's alone. The commits stay in the history. The npm versions of `@dockflow-tools/cli` up to 3.1.1 cannot be deleted, so they are deprecated; 1.0.0 was never published under that name.
- The configuration format, the state format and the event schema have their own version numbers (`version: 1`, `schema: 1`, `v: 1`) and change only in a major release.

## Consequences

- A server only ever runs a binary whose origin is verified.
- The CLI and the agent are always the same version, so their protocol is internal.
- Development builds need either a Linux machine or the override variable.

## Implementation status (M2)

- `.github/workflows/release.yml` runs on a tag `v*`, or on a commit of `main` that writes the version into `.github/release` (the release then creates the tag on that commit): the whole CI on the released commit, then the binaries, `SHA256SUMS` signed keyless with cosign (`SHA256SUMS.sigstore.json`), and a GitHub release. Releases are never marked as the repository's latest; a tag with a pre-release suffix makes a pre-release.
- `install.sh` checks the binary against `SHA256SUMS`, and `SHA256SUMS` against its signature when cosign is installed (identity: this repository's release workflow, at a `v` tag or on `main`).
- The CLI downloads the agent binary over HTTPS and checks it against `SHA256SUMS`.

## Implementation status (v1.0)

- A release holds `dockflow-agent-linux-amd64` and `-arm64`, built first, and the CLIs built with their checksums (`Makefile`, `snapshot`). The CLI checks the agent it downloads against them.
- `install.ps1` installs on Windows, as `install.sh` does. Both are attached to each release.
- After the release, the workflow writes `Formula/dockflow.rb` from `SHA256SUMS`, installs it with Homebrew on Linux, and commits it on `main`.
- The npm packages are built from the release's binaries by `packaging/npm/pack.sh` and published with provenance by `.github/workflows/publish-cli.yml`, which the release starts as a run of its own. It holds no token: npm trusts that workflow by its file name (trusted publishing), set in each package's settings on npmjs.com, as Dockflow 1.x's workflow of the same name was. `@dockflow-tools/cli` runs the binary of `@dockflow-tools/cli-<os>-<arch>`, its optional dependency for the platform, from a Node script, without a postinstall script.

## Embedding the Linux binaries

Decided in M1: not embedded. The CLI downloads the binary it needs, as above. Embedding both Linux binaries would add about 40 MB to every CLI, for the benefit of offline machines that deploy from macOS or Windows, which `DOCKFLOW_AGENT_BINARY` already covers.
