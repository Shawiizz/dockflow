# ADR-0024: Provisioning stays within what Dockflow needs

- Status: Accepted (supersedes the hardening part of [ADR-0013](0013-servers-access-security.md))
- Date: 2026-10-27, revised 2026-10-29 (SSH hardening becomes opt-in)

## Context

[ADR-0013](0013-servers-access-security.md) had provisioning harden the server the way real projects' hardening scripts did: an SSH drop-in, fail2ban for SSH, unattended security updates and time synchronisation. Built and run on real servers, the last three proved to be the administration of the server rather than what Dockflow needs:

- **fail2ban adds little once passwords are off**, which the SSH drop-in does: a brute force against keys does not succeed. It costs, though. The first real-server run was banned by it: a client that tried the deploy user while the first boot was still creating it. A CI pipeline with a wrong key would be locked out the same way, and a CI runner shares its address with other people's jobs.
- **Unattended security updates and time synchronisation are already on** in the images Dockflow installs Docker on (Ubuntu's, and Debian's cloud images): the steps did nothing on most servers.
- **A server managed with Ansible or its own scripts** does not expect a deploy tool to install and configure system services.

## Decision

- **Provisioning installs what Dockflow uses:** Docker, the deploy user and its key, `/var/lib/dockflow`, the port filter's boot unit, the Cloudflare ranges' timer (it does nothing unless the edge is `cloudflare`, and only root can install it, while the edge can be changed later as the deploy user), nginx and its sudo rules with `--nginx`, and the switch, the registry and the watchdog.
- **SSH hardening is opt-in** (revised 2026-10-29). The server's security is its administrator's, so `server init` and `server cloud-init` leave SSH's settings alone unless `--harden-ssh` is given (`--no-hardening` is gone). With it, provisioning writes a drop-in that refuses passwords and lets root in by key only, once the administrator's account has a key:
  - **No lockout.** While the administrator's account has no authorized key, passwords stay accepted. When that account is root, `PermitRootLogin` is not set either, and nothing is written: root still logs in with its password. The output says so.
  - **It takes precedence.** sshd keeps the first value it reads, and providers ship their own drop-ins (`50-cloud-init.conf` sets `PasswordAuthentication yes` on some images). The drop-in is `/etc/ssh/sshd_config.d/01-dockflow.conf`, read before them.
  - **It is verified.** After writing it, provisioning reads the values sshd uses (`sshd -T`) and warns about each one that did not take effect, rather than claiming success. A file the administrator named to be read first still wins.
  - **Existing servers.** A `50-dockflow.conf` written by an earlier version stays where it is: Dockflow does not remove what an administrator may rely on. The documentation's server layout page says how to remove it.
- **fail2ban, unattended upgrades and time synchronisation are left to the server's administrator,** and so is checking them: `server check` checks what Dockflow needs (Docker, its tmpfs, its state, its containers, its filter, the switch's ports), not the server's security.

## Consequences

- Provisioning changes less on a server, and nothing that bans a client.
- Dockflow neither changes nor reports the rest of the server's administration, unless asked to with `--harden-ssh`.
- Servers provisioned by a development build of M3 that installed fail2ban keep it: Dockflow does not remove packages, and no release ever installed it.
