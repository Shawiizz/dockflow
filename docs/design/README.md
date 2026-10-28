# Design

The design of Dockflow v2, written before any code ([roadmap, M0](roadmap.md#m0-design-this-branch-now)).

| Document | Contents |
|---|---|
| [vision.md](vision.md) | The one-sentence pitch, who it is for, goals, non-goals, principles |
| [adr/](adr/README.md) | Twenty-three architecture decisions, each with its context, consequences and rejected alternatives |
| [roadmap.md](roadmap.md) | Milestones M1 to M5 and v1.0, with exit criteria |
| [parity.md](parity.md) | Every 1.x feature and its v2 equivalent: nothing is lost |

## Specifications

| Specification | Contents |
|---|---|
| [spec/config-v1.md](spec/config-v1.md) | `dockflow.yml`, interpolation, the secrets file, `x-dockflow`, which Compose keys are supported |
| [spec/state-v1.md](spec/state-v1.md) | The files and Docker labels that hold Dockflow's state on a server, the lock, the release record |
| [spec/events-v1.md](spec/events-v1.md) | The event stream every interface reads |
| [spec/cli-v1.md](spec/cli-v1.md) | Commands, options, exit codes |

## How a deploy works, end to end

1. **The CLI loads** `dockflow.yml`, the environment's Compose files, its secrets (CI variables, `.env.dockflow`, SOPS) and its connection string, and resolves interpolation. A missing variable or an unsupported key stops it here.
2. **It builds** images with buildx bake and sends their missing layers to the server's local registry through an SSH tunnel, or pushes to an external registry.
3. **It connects** to the server, verifies its host key and reaches its Docker API through the SSH connection.
4. **It computes the plan** from the desired state and what the server actually runs, and shows it. On a terminal, it asks for confirmation.
5. **It starts the agent:** the Dockflow binary is imported as an image on the server if needed. The CLI runs it in a container and writes the plan and the secrets to its stdin.
6. **The agent takes the environment's lock** (a `flock` under `/var/lib/dockflow`) and writes a release record with status `applying`.
7. **It applies the plan:**
   - networks, volumes, secret and config files;
   - jobs that other services depend on (migrations);
   - for each service, in `depends_on` order, its strategy:
     - `switch`: new containers next to the old ones, healthy, internal HTTP checks, traffic switched by the switch, old ones drained and stopped;
     - `start-first`;
     - `stop-first`;
   - public checks, `after` jobs and hooks;
   - removals and pruning.
8. **It records the outcome.** On success, the release becomes `active` and the old containers are removed. On failure, the switch goes back to the old containers, which were kept until then, and the failed release is marked `rolled_back`.
9. **It releases the lock and exits.** The CLI renders the events as they come. If it disconnects, the agent finishes anyway, and `dockflow attach` follows it again.
