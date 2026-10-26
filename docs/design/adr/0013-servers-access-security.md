# ADR-0013: Servers: connection strings, provisioning and an honest security model

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (connection strings kept, after review by the project owner)

## Context

Dockflow 1.x has these weaknesses:

- **Sudo rules contain nothing.** It adds the deploy user to the `docker` group, which already gives root, and then writes narrow sudo rules on top.
- **A private key stays on the server.** Setup generates the deploy user's private key on the server and leaves it there.
- **Host keys are not checked unless pinned.**
- **Provisioning is incomplete:** it installs Docker but leaves out log rotation, SSH hardening, security updates and time sync. Real projects fill the gap with their own scripts (ValientRP's `harden.sh`: SSH by key only, fail2ban, ufw, log rotation).

Its connection string is practical, and the project owner wants it kept:

- `dockflow setup` prints one base64 value;
- the user stores it as one CI secret or in `.env.dockflow`;
- no address or user appears in the repository.

## Decision

### The security model, stated

Whoever can reach a manager's Docker socket is root on the cluster. Dockflow does not try to reduce that with sudo rules. It limits **who holds the keys** and **what a key can do**.

### Connection strings

An environment's connection string is the base64 of a JSON document:

```json
{
  "v": 2,
  "nodes": [
    { "name": "main", "host": "203.0.113.10", "port": 22, "user": "dockflow", "role": "manager", "host_key": "SHA256:Xq…" },
    { "name": "worker1", "host": "203.0.113.11", "port": 22, "user": "dockflow", "role": "worker", "host_key": "SHA256:Lm…" }
  ],
  "private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\n…"
}
```

- **Where it lives:** the `<ENV>_CONNECTION` secret (`PRODUCTION_CONNECTION`), read like any other secret ([ADR-0012](0012-secrets-sops.md)): a CI variable, `DOCKFLOW_SECRETS`, `.env.dockflow` or the SOPS file.
- **What it holds:** one value per environment, for all its servers. Managers are tried in order, and workers are used only by the commands that need a node directly: `ssh`, host hooks and node-specific `exec`.
- **Host keys:** it carries every node's host key fingerprint, and every connection verifies it. Nothing is ever trusted on first use.
- **Node names** (`^[a-z][a-z0-9_]*$`) are the Swarm node names, and key per-node values (`node_vars`, `PRODUCTION_MAIN_X`).
- **Passwords:** a `password` field may replace `private_key` for servers that only accept password authentication, as 1.x allowed. `server init` warns that keys are safer.
- **How it is produced:** `dockflow server init` prints it at the end. `dockflow server connection <env>` rebuilds it, for example after `cluster join` adds a node.
- **The alternative:** listing the nodes in `dockflow.yml` (`nodes:`) and authenticating with `ssh-agent`, `~/.ssh/config` or `DOCKFLOW_SSH_KEY`, for teams that prefer it. When both are present, the connection string wins.

### Keys

- The deploy user is `dockflow` by default, in the `docker` group, with no sudo except the rules a feature needs (the port filter, [ADR-0014](0014-networking-port-filter.md)). Those rules are documented as convenience, not containment.
- **Its key:**
  - it is generated on the administrator's machine, or by `server init` on the CLI's machine, never on a server;
  - it is installed with the options `restrict,port-forwarding,pty`, which re-enable only what the CLI uses;
  - an optional `from=` restricts the source addresses;
  - one key per environment is recommended.

### Provisioning

`dockflow server init [<admin>@<host>]` is interactive when options are missing, as 1.x's `setup` was:

- without a host, it runs on the server itself, as root;
- with a host, it connects as root or as a sudo user, uploads the binary ([ADR-0020](0020-releasing-dockflow.md)) and runs `dockflow provision` there.

`--host`, `--user`, `--deploy-key`, `--password-file`, `--skip-docker-install` and `--yes` make it non-interactive.

Provisioning does the following, and every step is idempotent:

- install Docker from Docker's signed repository (Debian 12 and 13, Ubuntu 22.04, 24.04 and 26.04), unless `--skip-docker-install`;
- write `/etc/docker/daemon.json` with log rotation;
- create the deploy user and install its key with the options above;
- add an SSH hardening drop-in (no password authentication, root only by key) and fail2ban for SSH;
- enable unattended security updates and time synchronisation;
- install the published-port filter ([ADR-0014](0014-networking-port-filter.md)), unless `--no-port-filter`;
- with `--nginx`, install nginx, refuse unknown hosts by default, and add the narrow sudo rules the `nginx` plugin needs ([ADR-0017](0017-plugins.md)).

`dockflow server cloud-init` prints the equivalent cloud-init user-data, for servers that are ready on first boot.

### Clusters

- `dockflow cluster init` creates the Swarm, its system networks and services, and the cluster record.
- `dockflow cluster join` adds a provisioned server.
- `dockflow cluster label` sets node labels.

Provisioning and cluster commands build their shell commands with a typed command builder that quotes every value.

## Consequences

- The 1.x experience is kept: one secret per environment, nothing about the servers in the repository.
- Host keys are always verified, because the connection string carries them.
- No private key is left on a server.
- A leaked connection string gives root on that environment's servers. The documentation says so and recommends one key per environment and `from=` restrictions.

## Alternatives considered

- **Nodes in `dockflow.yml` and a key in `ssh-agent` only (first draft of this ADR).** Kept as an option, not as the default, at the project owner's request.
- **A forced-command wrapper exposing only some Docker operations.** Rejected: any access to the Docker API can start a privileged container.
- **Rootless Docker.** Rejected for v1: Swarm's overlay networks and host-mode ports don't work with it.

## Open questions

- Whether `restrict,port-forwarding,pty` leaves stream-local forwarding enabled on every supported OpenSSH version. Verified in M1.
