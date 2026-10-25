# ADR-0014: Networking and the published-port filter

- Status: Accepted
- Date: 2026-10-25

## Context

Docker publishes ports by writing NAT rules that bypass the host firewall (ufw, firewalld), so a port published by mistake is open to the internet. Dockflow 1.x has a filter for this, the best part of its provisioning: its own chain jumped to from `DOCKER-USER`, matching the original destination port with conntrack, installed by a systemd unit ordered before Docker. It filters only interfaces that carry a default route, fails open on nodes where it is missing, and is updated over SSH on every node.

Swarm's own ports (2377, 7946, 4789) are opened to everyone by 1.x, and overlay traffic is not encrypted.

## Decision

### Networks

| Network | Type | Members |
|---|---|---|
| `dockflow-system` | overlay, attachable, internal, encrypted | agents, the proxy's admin API |
| `dockflow-ingress` | overlay, attachable, encrypted | the proxy, routed services |
| `<stack>_default` and the networks a Compose file declares | overlay, attachable, encrypted | the app's services; the agent joins them for health checks |

Overlay encryption (`encrypted`) is on by default. A cluster can turn it off at `cluster init` when its nodes share a private network and the cost matters.

### The filter

The filter is carried over from 1.x, with these changes:

- **What it allows from outside:**
  - the ports published by Dockflow-managed services, read from the state of every app on the cluster;
  - 80 and 443 on ingress nodes;
  - SSH.

  Every other port Docker has DNATed is dropped.
- **Where it applies:** to every interface except loopback, Docker's own bridges and the private interfaces or CIDRs declared at `cluster init`. No guessing from the default route.
- **Swarm ports:** 2377/tcp, 7946/tcp and udp, 4789/udp and ESP (IP protocol 50) are accepted only from the cluster's node addresses.
- **How it is updated:** by a global job, `dockflow-filter`, that the agent runs on every node when the published ports change. It runs on the host network with `NET_ADMIN`, writes the allowed ports to `/etc/dockflow/` and applies the chain atomically with `iptables-restore --noflush`. The systemd unit reapplies that file at boot, before Docker starts.
- **It fails closed:** a node where the job fails is reported, and the run fails before routes switch.
- **Backend:** iptables (including iptables-nft) in v1.

The filter does not manage the rest of the host's `INPUT` chain. The documentation recommends the provider's firewall (DigitalOcean Cloud Firewalls, Hetzner Firewalls) as the outer layer.

## Consequences

- The CLI never connects to workers to update the filter.
- A published port that Dockflow did not create stays closed to the internet.
- Swarm's control and data planes are closed to anything outside the cluster.

## Open questions

- A native nftables backend, once Docker's own nftables support is the default on supported systems. After v1.
