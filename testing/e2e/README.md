# E2E Tests

Two independent suites, one per orchestrator. Each suite owns its cluster
lifecycle and can run in isolation (CI runs them as parallel jobs).

```
e2e/
  swarm/        # 2-node Docker-in-Docker Swarm (compose project: dockflow-swarm)
    bunfig.toml #   preload: setup.ts (build CLI, reset cluster, pre-deploy test-app)
    tests/      #   01-build … 07-uploads
  k3s/          # single-node k3s-in-Docker (compose project: dockflow-k3s)
    bunfig.toml #   preload: setup.ts (build CLI only — tests own the cluster lifecycle)
    tests/      #   10-k3s-deploy
  helpers/      # shared: CLI runner, cluster lifecycle, fixtures, assertions
  fixtures/     # READ-ONLY templates — never written to by tests
  docker/       # images + compose files for the test clusters
  teardown.ts   # stops both clusters
```

## Running

```bash
cd testing/e2e/swarm && bun test tests/    # Swarm suite
cd testing/e2e/k3s   && bun test tests/    # k3s suite
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
:32222, worker :32223, k3s :32224, Traefik HTTP :38080. The two clusters use
separate compose projects and networks and can run simultaneously.
