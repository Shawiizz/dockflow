# ADR-0024: Provisioning stays within what Dockflow needs

- Status: Accepted (supersedes the hardening part of [ADR-0013](0013-servers-access-security.md))
- Date: 2026-10-27

## Context

[ADR-0013](0013-servers-access-security.md) had provisioning harden the server the way ValientRP's `harden.sh` did: an SSH drop-in, fail2ban for SSH, unattended security updates and time synchronisation. Built and run on real servers, the last three proved to be the administration of the server rather than what Dockflow needs:

- **fail2ban adds little once passwords are off**, which the SSH drop-in does: a brute force against keys does not succeed. It costs, though. The first real-server run was banned by it: a client that tried the deploy user while the first boot was still creating it. A CI pipeline with a wrong key would be locked out the same way, and a CI runner shares its address with other people's jobs.
- **Unattended security updates and time synchronisation are already on** in the images Dockflow installs Docker on (Ubuntu's, and Debian's cloud images): the steps did nothing on most servers.
- **A server managed with Ansible or its own scripts** does not expect a deploy tool to install and configure system services.

## Decision

- **Provisioning installs what Dockflow uses:** Docker, the deploy user and its key, `/var/lib/dockflow`, the port filter's boot unit, the Cloudflare ranges' timer (it does nothing unless the edge is `cloudflare`, and only root can install it, while the edge can be changed later as the deploy user), nginx and its sudo rules with `--nginx`, and the switch, the registry and the watchdog.
- **The one hardening step it keeps is SSH's:** the drop-in that refuses passwords and lets root in by key only, once the administrator's account has a key. Dockflow's access is by key, and this is what makes the server's SSH as strong as that access. `--no-hardening` leaves it out.
- **fail2ban, unattended upgrades and time synchronisation are left to the server's administrator.** `server check` warns when apt installs no security updates on its own, and when the server's clock is more than 30 seconds off the CLI's machine, with the command that fixes it.

## Consequences

- Provisioning changes less on a server, and nothing that bans a client.
- A server where the administrator turned updates or time synchronisation off is reported by `server check`, not changed.
- Servers provisioned by a development build of M3 that installed fail2ban keep it: Dockflow does not remove packages, and no release ever installed it.
