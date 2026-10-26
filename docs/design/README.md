# Design

The design of Dockflow v2, written before any code ([roadmap, M0](roadmap.md#m0-design-this-branch-now)).

| Document | Contents |
|---|---|
| [vision.md](vision.md) | The one-sentence pitch, who it is for, goals, non-goals, the code budget |
| [adr/](adr/README.md) | Twenty-two architecture decisions, each with its context, consequences and rejected alternatives |
| [roadmap.md](roadmap.md) | Milestones M1 to M5 and v1.0, with exit criteria |
| [parity.md](parity.md) | Every 1.x feature and its v2 equivalent: nothing is lost |

## Specifications

| Specification | Contents |
|---|---|
| [spec/config-v1.md](spec/config-v1.md) | `dockflow.yml`, interpolation, the secrets file, `x-dockflow`, which Compose keys are supported |
| [spec/state-v1.md](spec/state-v1.md) | The Swarm objects that hold Dockflow's state, the lock algorithm, the release record |
| [spec/events-v1.md](spec/events-v1.md) | The event stream every interface reads |
| [spec/cli-v1.md](spec/cli-v1.md) | Commands, options, exit codes |

## How a deploy works, end to end

1. **The CLI loads** `dockflow.yml`, the environment's Compose files, its secrets (CI variables, `.env.dockflow`, SOPS) and its connection string, and resolves interpolation. A missing variable or an unsupported key stops it here.
2. **It builds** images with buildx bake and pushes them, to an external registry or to the cluster registry through an SSH tunnel to a manager.
3. **It connects** to the first manager that answers, verifies its host key and reaches its Docker API through the SSH connection.
4. **It computes the plan** from the desired state and what the cluster actually runs, and shows it. On a terminal, it asks for confirmation.
5. **It starts the agent:** the Dockflow binary is imported as an image on the manager if needed. The CLI runs it in a container and writes the plan and the secrets to its stdin.
6. **The agent takes the environment's lock** in the Raft store and creates a release record with status `applying`.
7. **It applies the plan:**
   - networks, volumes, secrets and configs;
   - `before` jobs;
   - stateful services, then the others, each waited for through the event stream;
   - HTTP health checks from inside the cluster;
   - `after` jobs;
   - routes pushed to Caddy;
   - removals and pruning.
8. **It records the outcome.** On success, the release becomes `active`. On failure, the agent restores the previous release's exact service specs and marks the failed release `rolled-back`.
9. **It releases the lock and exits.** The CLI renders the events as they come. If it disconnects, the agent finishes anyway, and `dockflow attach` follows it again.
