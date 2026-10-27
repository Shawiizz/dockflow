# ADR-0013: Servers: connection strings, provisioning and an honest security model

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (connection strings kept at the project owner's request; single server, no cluster commands)

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

Whoever can reach the server's Docker socket is root on it. Dockflow does not try to reduce that with sudo rules. It limits **who holds the keys** and **what a key can do**.

### Connection strings

An environment's connection string is the base64 of a JSON document:

```json
{
  "v": 2,
  "servers": [
    { "name": "main", "host": "203.0.113.10", "port": 22, "user": "dockflow", "host_key": "SHA256:Xq…" }
  ],
  "private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\n…"
}
```

- **Where it lives:** the `<ENV>_CONNECTION` secret (`PRODUCTION_CONNECTION`), read like any other secret ([ADR-0012](0012-secrets-sops.md)): a CI variable, `DOCKFLOW_SECRETS`, `.env.dockflow` or the SOPS file.
- **Servers:** `servers` holds exactly one server in v1. The list leaves room for several later ([ADR-0023](0023-several-servers-later.md)).
- **Host keys:** it carries the server's host key fingerprint, and every connection verifies it. Nothing is ever trusted on first use.
- **Passwords:** a `password` field may replace `private_key` for servers that only accept password authentication, as 1.x allowed. `server init` warns that keys are safer.
- **How it is produced:** `dockflow server init` prints it at the end, and `dockflow server connection` prints it again.
- **The alternative:** the server can be described in `dockflow.yml` (`server:`), with the key from `ssh-agent`, `~/.ssh/config` or `DOCKFLOW_SSH_KEY`, for teams that prefer it. When both exist, the connection string wins.

### Keys

- The deploy user is `dockflow` by default, in the `docker` group, with no sudo except the narrow rules a feature needs (the `nginx` and `systemd` plugins). Those rules are documented as convenience, not containment.
- **Its key:**
  - it is generated on the administrator's machine, or by `server init` on the CLI's machine, never on the server;
  - it is installed with the options `restrict,port-forwarding,pty`, which re-enable only what the CLI uses;
  - an optional `from=` restricts the source addresses.

### Provisioning

`dockflow server init [<admin>@<host>]` is interactive when options are missing, as 1.x's `setup` was:

- without a host, it runs on the server itself, as root;
- with a host, it connects as root or as a sudo user, uploads the binary ([ADR-0020](0020-releasing-dockflow.md)) and runs `dockflow provision` there.

`--host`, `--user`, `--deploy-key`, `--password-file`, `--skip-docker-install`, `--edge`, `--nginx` and `--yes` make it non-interactive.

Provisioning does the following, and every step is idempotent:

- install Docker from Docker's signed repository (Debian 12 and 13, Ubuntu 22.04, 24.04 and 26.04), unless `--skip-docker-install`;
- write `/etc/docker/daemon.json` with log rotation;
- create the deploy user and install its key with the options above;
- add an SSH hardening drop-in (no password authentication, root only by key); fail2ban, unattended security updates and time synchronisation were dropped by [ADR-0024](0024-provisioning-scope.md);
- create `/var/lib/dockflow`;
- start the switch with the chosen edge ([ADR-0011](0011-switch-and-edge.md)), the local registry ([ADR-0009](0009-images.md)) and the watchdog ([ADR-0010](0010-rollout-health-jobs.md)), each one optional;
- install the published-port filter ([ADR-0014](0014-networking-port-filter.md)), unless `--no-port-filter`;
- with `--nginx`, install nginx, refuse unknown hosts, and add the sudo rules of the `nginx` plugin ([ADR-0017](0017-plugins.md)).

`dockflow server cloud-init` prints the equivalent cloud-init user-data, for servers that are ready on first boot. `dockflow server upgrade` upgrades the switch, the registry and the watchdog to the CLI's version.

Provisioning commands build their shell commands with a typed command builder that quotes every value.

### Implementation status (M2)

`dockflow server init <admin>@<host>` ships in M2 with part of the provisioning above: Docker from Docker's repository on Debian and Ubuntu (with log rotation when Docker is freshly installed), the deploy user in the `docker` group, its key generated on the CLI's machine and installed with `restrict,port-forwarding,pty`, then the switch and the registry as the deploy user, and the connection string printed at the end. It differs from the plan in two points:

- the steps run as one shell script sent over the administrator's SSH session (`sh -s`, or `sudo -n sh -s`), built with the typed builder (`internal/shell`), rather than by uploading the binary and running `dockflow provision`: nothing is left on the server, and the script is contract-tested in Debian and Alpine containers;
- `--deploy-key` takes a private key file, not a public one, since the connection string must hold the private key.

`sudo dockflow server init`, without an argument and outside a project, runs the same script on the server itself, with `sh -s`. The connection string takes the server's public address (the source address of its route to the internet, refused when private: `--host` then), the SSH port of `sshd_config` (`--port`), and the fingerprint of the local host key, ed25519 first. The deploy key is generated there, in memory, printed and never written to disk; the deploy user is then reached through the SSH server on 127.0.0.1 with that key and host key, which checks both as the CI will.

The rest (interactive mode, running on the server itself, `from=`, SSH hardening, fail2ban, unattended updates, time synchronisation, the port filter, the watchdog, `--nginx`, `server cloud-init`) stays in M3.

### Implementation (M3)

- **Hardening**, unless `--no-hardening`: `/etc/ssh/sshd_config.d/50-dockflow.conf` (checked with `sshd -t` before the reload, removed when refused) turns password authentication off only when the administrator's account has an authorized key, so provisioning never locks it out; it writes the file only when it changed, so a second run says nothing. (fail2ban, `20auto-upgrades` and `timedatectl set-ntp true` shipped here first, then were dropped by [ADR-0024](0024-provisioning-scope.md).)
- **`from=`** prefixes the deploy key's options; a key already installed with other options is replaced.
- **`--nginx`** installs nginx, replaces the distribution's default site with one that refuses unknown host names (`return 444`, `ssl_reject_handshake`), and installs `/etc/sudoers.d/dockflow-nginx`, checked with `visudo -c`. It implies `--edge external` unless an edge is given.
- **Interactive mode** asks for the edge, and nginx with the external edge, when provisioning on a terminal without `--edge`; Enter keeps the server's.
- **`server cloud-init`** generates the deploy key and the server's ed25519 host key on the CLI's machine: the user-data holds the host key and the provisioning script with the deploy key's public part, and the connection string pins the host key. The switch, registry and watchdog need the agent, so they follow with `server init <env>` once the server is up.
- The script still runs over the administrator's session, as in M2; the hardening steps are contract-tested in Debian with stand-ins for the commands that need a network or systemd.
- **`server upgrade`** is `server init <env>` with every setting kept and the images' tags pulled again: the switch and the registry are replaced only when the pulled image differs, and a server that cannot pull keeps its image with a warning. **`server edge`** is `server init <env> --edge`. **`server status`** and **`server check`** are read-only agent operations; `check` probes ports 80 and 443 from a helper container on the host's network.
- **`server uninstall`** takes the server lock and every environment's lock, removes the environments (their volumes with `--volumes`), the switch, the registry, the watchdog, the shared networks, the filter's rules and the state; the agent's own container mounts the switch's admin volume, so the CLI removes it, and the finished agents, once the agent has exited.

## Consequences

- The 1.x experience is kept: one secret per environment, nothing about the server in the repository.
- Host keys are always verified, because the connection string carries them.
- No private key is left on a server.
- A leaked connection string gives root on that server. The documentation says so and recommends one key per environment and `from=` restrictions.

## Alternatives considered

- **A forced-command wrapper exposing only some Docker operations.** Rejected: any access to the Docker API can start a privileged container.
- **Rootless Docker.** Possible later, behind the `Engine` port. Not in v1: binding ports 80 and 443 and the port filter need root.

## Open questions

- Whether `restrict,port-forwarding,pty` leaves stream-local forwarding enabled on every supported OpenSSH version. Verified in M1.
