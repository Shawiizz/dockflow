# ADR-0013: Servers: access, provisioning and an honest security model

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x adds the deploy user to the `docker` group and writes narrow sudo rules. The `docker` group already gives root, so the sudo rules contain nothing. Setup generates the deploy user's private key on the server and leaves it there. Host keys are not checked unless pinned. Connection strings are base64 JSON with the key inside. Provisioning installs Docker but leaves out log rotation, SSH hardening, updates and time sync.

## Decision

### The security model, stated

Whoever can reach a manager's Docker socket is root on the cluster. Dockflow does not try to reduce that with sudo rules. It limits **who holds the keys** and **what the key can do**.

### Access

- The deploy user is `dockflow` by default, in the `docker` group, with no sudo.
- **Its keys:**
  - they are generated on the administrator's machine, never on a server;
  - one key per environment is recommended;
  - they are installed with the options `restrict,port-forwarding,pty`, which re-enable only what the CLI uses;
  - an optional `from=` restricts the source addresses.
- **The CLI authenticates with:**
  - `ssh-agent`;
  - identities from `~/.ssh/config`;
  - in CI, `DOCKFLOW_SSH_KEY` or `DOCKFLOW_SSH_KEY_<ENV>`.

  Environment names are restricted ([config spec](../spec/config-v1.md)) so that variable name is always valid.
- **Host keys are always verified:**
  - against `host_key` in `dockflow.yml` (a `SHA256:` fingerprint), or against the user's `known_hosts`;
  - an unknown or changed key is an error that prints the fingerprint;
  - nothing is trusted silently.

### Provisioning

`dockflow server init <admin>@<host>` connects as root or as a sudo user, uploads the binary ([ADR-0020](0020-releasing-dockflow.md)) and runs `dockflow provision` on the host as root. Provisioning does the following, and every step is idempotent:

- install Docker from Docker's signed apt repository. Supported in v1: Debian 12 and 13, Ubuntu 22.04, 24.04 and 26.04; any other system is refused;
- write `/etc/docker/daemon.json` with the `local` log driver and size limits;
- create the deploy user and install its public key with the options above;
- add an SSH hardening drop-in: no password authentication, root only by key;
- enable unattended security updates and time synchronisation;
- install the published-port filter ([ADR-0014](0014-networking-port-filter.md)).

`dockflow server cloud-init` prints the equivalent cloud-init user-data (download the binary, verify it, run `dockflow provision`), for creating servers that are ready on first boot at DigitalOcean, Hetzner and others.

### Clusters

- `dockflow cluster init <host>` creates the Swarm, its system networks and services, and the cluster record.
- `dockflow cluster join <host> --role manager|worker` adds a provisioned server.
- `dockflow cluster label <node> key=value` sets node labels, such as `dockflow.ingress=true` or the labels placement constraints use.

Provisioning and cluster commands are the only ones that run shell commands on servers. They build them with a typed command builder that quotes every value. They are run by an administrator, never by CI.

## Consequences

- No private key is ever left on a server, and no key is trusted without verification.
- A leaked CI key gives root on that environment's managers; the documentation says so and recommends one key per environment and `from=` restrictions.
- A provisioned server has rotated logs, hardened SSH, security updates and a correct clock, which also keeps the lock leases sane ([state spec](../spec/state-v1.md#lock)).

## Alternatives considered

- **A forced-command wrapper that exposes only some Docker operations.** Rejected: any access to the Docker API can start a privileged container.
- **Rootless Docker.** Rejected for v1: it doesn't support overlay networks and host-mode ports the way Swarm needs them.
- **Short-lived SSH certificates.** Deferred: worth it for agencies, but a CA is one more thing to run.

## Open questions

- Whether `restrict,port-forwarding,pty` leaves stream-local forwarding enabled on every supported OpenSSH version. Verified in M1; if not, the options are adjusted.
