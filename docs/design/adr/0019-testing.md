# ADR-0019: Testing strategy

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x has 1,742 unit tests, many of which assert on the text of shell commands (about 273 `toContain` assertions). They break under refactors and prove nothing about Docker. Its e2e suite (a two-node Swarm in Docker-in-Docker) is its strongest test asset.

## Decision

| Level | What | How |
|---|---|---|
| **Domain and planner** | `plan = f(desired, actual)`, the Compose converter, configuration validation | Pure Go tests. Golden files: an input fixture and the expected plan or service specs, compared as JSON and updated with `-update`. No mocks |
| **Adapters** | The Swarm `Engine`, the state store (lock, releases), the registry push, the proxy reconciler | Contract tests against a real Docker Engine in Docker-in-Docker. One test suite per port, so a future adapter must pass the same tests |
| **End to end** | User journeys: deploy, redeploy with no change, failed health check and rollback, Ctrl+C, a dead agent, two apps on one cluster, backup and restore | The compiled binary against a three-node DinD cluster (one manager, two workers). One test per journey |
| **Real cluster** | Provisioning, cloud-init, TLS with Let's Encrypt staging, the port filter on real interfaces | The compiled binary against fresh DigitalOcean droplets, run by hand before each release, later on a schedule |

Rules:

- No test asserts on the text of a command sent to a server.
- The lock and the state store are tested for contention: concurrent acquirers, a holder that stops renewing, a takeover.
- Every user-facing feature lands with its e2e test and its documentation.
- Releases are tested as built: the e2e suite runs on the release binaries, a practice kept from 1.x.

## Consequences

- Refactors don't break tests that only described the old code.
- Contract tests need Docker in CI. The pure tests run anywhere in seconds.
- Real-cluster tests need provider credentials and cost a few cents per run.
