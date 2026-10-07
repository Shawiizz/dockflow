# E2E Tests

Two independent suites, each owning its cluster lifecycle; each can run in isolation
(CI runs them as parallel jobs).

```
e2e/
  swarm/        # 2-node Docker-in-Docker Swarm (compose project: dockflow-swarm)
    bunfig.toml #   preload: setup.ts (build CLI, reset cluster, pre-deploy test-app)
    tests/      #   01-build … 11-public-ports
  setup/        # host provisioning on a clean ubuntu container
    bunfig.toml #   preload: setup.ts (cross-compile the Linux binary)
    tests/      #   20-setup (get.docker.com, deploy user, idempotent re-run)
  helpers/      # shared: CLI runner, cluster lifecycle, fixtures, assertions
  fixtures/     # READ-ONLY templates — never written to by tests
  docker/       # images + compose files for the test clusters
  teardown.ts   # stops all test containers
```

## Running

```bash
cd testing/e2e/swarm && bun test tests/    # Swarm suite
cd testing/e2e/setup && bun test tests/    # setup/provisioning suite
bun run testing/e2e/teardown.ts            # stop all test containers
```

Works on Linux, WSL and Windows (requires Docker Desktop).

## Conventions

**Fixtures are immutable templates.** Tests never write inside `fixtures/`.
Use `makeFixture(name)` from `helpers/fixtures.ts` to get a throwaway temp
copy (with `.env.dockflow` pre-written) and call `fixture.cleanup()` in
`afterAll`. If a test needs to patch config, it patches its temp copy.

**The Swarm happy-path chain shares one stack.** Files 01→05 form an ordered
scenario (build → deploy → backup → health checks) against the shared
`test-app-test` stack. The suite preload pre-deploys version `1.0.0-e2e` so
files stay order-independent. Use `sharedAppDir()` to target it.

**Destructive or negative scenarios get their own stack.** Anything that
makes a deploy fail, mutates config, or tests rollback must use its own
fixture copy — and, if it would interfere with the shared stack (Traefik
routes, service names), its own `project_name`. See the failing-endpoint
test in `05-http-healthcheck.test.ts` for the pattern.

**Ports are statically allocated** (`helpers/connection.ts`): Swarm manager
:32222, worker :32223, Traefik HTTP :38080, e2e registry :35000.

**The e2e registry** (`registry:2`, anonymous) runs inside the manager DinD
node with its port published in cascade, so the single image name
`localhost:35000/...` resolves from the host (CLI push) and from the
manager's inner daemon (service pull) — loopback registries are TLS-exempt,
no daemon configuration needed. Registry-mode fixtures must pin their
services to the manager.
