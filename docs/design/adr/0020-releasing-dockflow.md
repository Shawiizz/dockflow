# ADR-0020: Releasing Dockflow itself: signed binaries, version-pinned agent

- Status: Accepted
- Date: 2026-10-25

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
- `DOCKFLOW_AGENT_BINARY=<path>` overrides this for development builds, which have no published release.

### Installation channels

- A `curl | sh` installer and a PowerShell one, both verifying the signature.
- Homebrew.
- An npm package built on per-platform `optionalDependencies`, as esbuild and Biome do, so it needs no postinstall script and works behind proxies.

### Versioning

- Semantic versioning.
- The configuration format, the state format and the event schema have their own version numbers (`version: 1`, `schema: 1`, `v: 1`) and change only in a major release.

## Consequences

- A server only ever runs a binary whose origin is verified.
- The CLI and the agent are always the same version, so their protocol is internal.
- Development builds need either a Linux machine or the override variable.

## Embedding the Linux binaries

Decided in M1: not embedded. The CLI downloads the binary it needs, as above. Embedding both Linux binaries would add about 40 MB to every CLI, for the benefit of offline machines that deploy from macOS or Windows, which `DOCKFLOW_AGENT_BINARY` already covers.
