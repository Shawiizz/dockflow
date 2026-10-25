# ADR-0005: Docker is reached through the Engine API, never the `docker` CLI

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x runs `docker` commands over SSH. It splits their `--format` output on `|` and tabs, and recognises errors with regular expressions on stderr. The results depend on the version of the `docker` CLI on each server, need a shell on the remote side, and break on unexpected output.

## Decision

Every interaction with Docker uses the Docker Engine API through the official Moby Go client. That includes images, services, tasks, nodes, networks, volumes, secrets, configs, events, logs and exec.

- **From the CLI**, the client dials the manager's `/var/run/docker.sock` through the SSH connection, with OpenSSH stream-local forwarding (`direct-streamlocal@openssh.com`). If the server refuses stream forwarding, the CLI falls back to running `docker system dial-stdio` over an SSH session, as the `docker` CLI does for `ssh://` hosts.
- **From the agent**, the client uses the mounted socket.
- **Waiting** uses the `/events` stream, plus a periodic read of service `UpdateStatus` and task states as a safety net. There is no fixed polling loop as the primary mechanism.
- **Errors** come back as typed API errors (not found, conflict, invalid parameter) and map to Dockflow errors by type, never by message.

Shell commands remain only in provisioning ([ADR-0013](0013-servers-access-security.md)). There they are built with a typed command builder that quotes every value, a design carried over from 1.x.

## Consequences

- No parsing of text output anywhere in the deploy path.
- No dependency on the `docker` CLI version on the servers, and no shell needed on the remote side for deploys.
- One SSH connection carries many API calls, so there is no limit from OpenSSH's `MaxSessions` on parallel calls.
- The CLI needs `AllowStreamLocalForwarding` (OpenSSH's default is yes) or the `docker` CLI on the server for the fallback.
