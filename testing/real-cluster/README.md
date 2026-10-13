# Checks on a real Swarm cluster

Scripts for what the e2e suites cannot settle: they run on the maintainer's own cluster and print a
short report to paste back.

## check-swarm-assumptions.sh

Two assumptions Dockflow makes about Docker Swarm, checked against the Docker version your cluster
really runs. POSIX `sh`; run it on a manager:

```sh
scp testing/real-cluster/check-swarm-assumptions.sh <manager>:
ssh <manager> sh check-swarm-assumptions.sh 2>&1 | tee swarm-check.txt
```

It needs to pull a small image (`alpine:3` by default; `CHECK_IMAGE=<image> sh check-swarm-assumptions.sh`
uses another one that the nodes have, or can pull).

**What it does.** Everything it creates is named `dockflow-check-*` and is removed when it ends,
including when you interrupt it. It never touches anything else, and it refuses to start when objects
with that prefix already exist. It asks for nothing and changes no setting of the cluster.

1. **Log format.** It starts a service of two replicas that prints numbered lines, one with a ` | ` in
   its message, one whose message looks like a timestamp and an empty one. It prints the raw output of
   `docker service logs --timestamps` (with `cat -vet`, so tabs and line ends show) for the two commands
   Dockflow runs: the API's (`--tail N --timestamps --no-trunc`) and the `logs` command's (without
   `--no-trunc`). It then tells whether every line reads `timestamp, <task>@<node> |, message` or
   `<task>@<node> |, timestamp, message`, and whether the numbered lines of each task come in order.
   `splitServiceLogsContext` and `splitTimestamp` in `cli/src/utils/docker-logs.ts` accept both orders;
   the report shows the one your Docker uses and whether the two odd lines survive.

2. **Network name collision.** Accessories are a stack named `<stack>-accessories`, and Swarm creates
   `<stack>-accessories_default` for a stack whose services name no network. The script creates an
   overlay network with that name the way Dockflow creates an external network (`docker network create
   --driver overlay --attachable`, as in `ensureExternalNetworks` and `createExternalResources`), then
   deploys a throwaway stack of that name:
   - **A** with a service that names no network: does `docker stack deploy` collide with the existing
     network, or does it adopt it?
   - **B** with the network declared as the stack's external default: does that route work?

**Reading the report.** The last block (`REPORT`) holds one line per check; paste the whole output
back, the raw lines above it are what settles a doubt. Nothing in it is secret: it lists the Docker
version, the number of nodes and the throwaway objects.
