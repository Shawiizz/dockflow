import { describe, test, expect } from "bun:test";
import { runCLI } from "../../helpers/cli";
import {
  waitForService,
  getServiceLabels,
  verifyDeployment,
  dockerExec,
} from "../../helpers/docker";
import { MANAGER_CONTAINER } from "../../helpers/connection";
import { sharedAppDir } from "../../helpers/fixtures";

const TEST_ENV = "test";
const TEST_VERSION = "1.0.0-e2e";
const STACK_NAME = `test-app-${TEST_ENV}`;
const SERVICE_NAME = `${STACK_NAME}_web`;

describe("deploy", () => {
  let deployOutput = "";

  test("deploys app successfully", async () => {
    const result = await runCLI(["deploy", TEST_ENV, TEST_VERSION, "--force"], {
      cwd: sharedAppDir(),
    });

    if (result.exitCode !== 0) {
      console.error("[deploy] STDOUT:", result.stdout.slice(-2000));
      console.error("[deploy] STDERR:", result.stderr.slice(-2000));
    }
    expect(result.exitCode).toBe(0);
    deployOutput = result.stdout + result.stderr;
  }, 180_000);

  test("hooks ran at all four phases with rendered templates", async () => {
    // The fixture hooks each echo a HOOK_TEST line with Nunjucks variables —
    // their presence in the deploy output proves the hook executed AND that
    // template rendering worked (build hooks run locally, deploy hooks on
    // the server with output relayed over SSH).
    //
    // Build hooks run locally and need a real bash: on Windows dev machines
    // the System32 WSL stub shadows Git Bash and local hooks fail (non-fatal)
    // — so the local phases are only asserted where bash works (CI is Linux).
    const phases = process.platform === "win32"
      ? ["pre-deploy", "post-deploy"]
      : ["pre-build", "post-build", "pre-deploy", "post-deploy"];
    for (const phase of phases) {
      expect(deployOutput).toContain(
        `HOOK_TEST: ${phase} executed for test-app version ${TEST_VERSION}`,
      );
    }

    // Deploy-phase hooks run ON the manager: the marker files they write
    // must exist there with the rendered version.
    for (const phase of ["pre-deploy", "post-deploy"]) {
      const marker = await dockerExec(MANAGER_CONTAINER, [
        "cat",
        `/tmp/dockflow-hook-${phase}.txt`,
      ]);
      expect(marker.trim()).toBe(`${phase}:${TEST_VERSION}`);
    }
  }, 30_000);

  test("service reaches 2/2 replicas", async () => {
    await waitForService(SERVICE_NAME, "2/2", { timeoutMs: 90_000 });
  }, 120_000);

  test("deployment is healthy (no failures, stable)", async () => {
    await verifyDeployment({
      stackName: STACK_NAME,
      serviceName: SERVICE_NAME,
      expectedReplicas: "2/2",
      checkDistribution: false,
    });
  }, 30_000);

  test("traefik labels are injected", async () => {
    const labels = await getServiceLabels(SERVICE_NAME);
    expect(labels["traefik.enable"]).toBe("true");
  });

  test("HTTP routing via Traefik works", async () => {
    await waitForService("traefik_traefik", "1/1", { timeoutMs: 60_000 });

    let lastStatus = 0;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      try {
        const res = await fetch("http://localhost:38080/", {
          headers: { Host: "test.local" },
          signal: AbortSignal.timeout(5000),
        });
        lastStatus = res.status;
        if (res.status >= 200 && res.status < 400) {
          return; // Success
        }
      } catch {
        // Connection refused or timeout
      }
      await Bun.sleep(1000);
    }

    throw new Error(`Traefik HTTP routing failed (last status: ${lastStatus})`);
  }, 120_000);
});
