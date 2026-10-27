# ADR-0019: Testing strategy

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x has 1,742 unit tests, many of which assert on the text of shell commands (about 273 `toContain` assertions). They break under refactors and prove nothing about Docker. Its e2e suite (Docker-in-Docker servers driven by the real binary) is its strongest test asset.

## Decision

| Level | What | How |
|---|---|---|
| **Domain and planner** | `plan = f(desired, actual)`, the Compose converter, configuration validation | Pure Go tests. Golden files: an input fixture and the expected plan or service specs, compared as JSON and updated with `-update`. No mocks |
| **Adapters** | The Docker `Engine`, the state store (lock, releases), the registry push, the switch's configuration | Contract tests against a real Docker Engine in Docker-in-Docker. One test suite per port, so a future adapter must pass the same tests |
| **End to end** | User journeys: deploy, redeploy with no change, **zero downtime under load** (a client hammering the app during a deploy sees no failed request), failed health check and rollback, Ctrl+C, a dead agent, two apps on one server, the `external` edge behind nginx, backup and restore | The compiled binary against a Docker-in-Docker server reached over SSH. One test per journey |
| **Real server** | Provisioning, cloud-init, TLS with Let's Encrypt staging, the port filter on real interfaces | The compiled binary against fresh DigitalOcean droplets, run by hand before each release, later on a schedule |

Rules:

- No test asserts on the text of a command sent to a server.
- The lock and the state store are tested for contention: concurrent acquirers, a holder killed mid-run, a manual lock.
- The rollout is tested for every strategy and failure point: unhealthy new containers, a crash loop, a failed job, a failed public check, a killed agent between the switch and the commit.
- Every user-facing feature lands with its e2e test and its documentation.
- Releases are tested as built: the e2e suite runs on the release binaries, a practice kept from 1.x.

### Real servers (M3)

`test/real/`, behind the `real` build tag, creates one droplet per journey through DigitalOcean's API, tagged `dockflow-real`, and deletes it when the journey ends; a run first deletes the tagged droplets older than three hours, left by an interrupted run. Without `DIGITALOCEAN_TOKEN`, it skips. Domains are `<ip>.sslip.io`, so no DNS is needed, and the switch takes its certificates from Let's Encrypt's staging (`server init --acme-ca`). The journeys:

- `server init root@<ip>` on a blank droplet, `deploy`, HTTPS with a staging certificate and the redirect from HTTP; SSH refusing passwords; a published port closed until `firewall.public_ports` lists it; `server check`; the cloudflare edge closing port 443 to the test machine; `server uninstall`;
- `server cloud-init --nginx` as the droplet's user-data, then `server init <env> --edge external` and a deploy with the `nginx` plugin, nginx refusing unknown host names.

`make real` runs them, and the "Real servers" workflow, started by hand, with the repository secret `DIGITALOCEAN_TOKEN`.

## Consequences

- Refactors don't break tests that only described the old code.
- Contract tests need Docker in CI. The pure tests run anywhere in seconds.
- Real-server tests need provider credentials and cost a few cents per run.
