/**
 * k3s-multinode / 45-refusals (design-07 17.4 E-45): two config.yml combinations `dockflow validate`
 * must refuse before touching any server — `options.remote_build` on k3s, and a `helm:` section on a
 * non-k3s orchestrator.
 *
 * Both scenarios are pure config-schema violations (DESIGN-CORE 7.1); `validate <env>` never
 * connects for either (design-07's "validate <env> is offline"), so this file needs no cluster state
 * beyond the servers.yml `makeFixture` generates for the lane topology.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import type { Fixture } from "../../../helpers/fixtures";
import { multinodeFixture } from "./fixture";

const ENV = "e2e";

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`45-refusals.test.ts:${name}`).catch(() => {});
    throw error;
  }
}

describe("config refusals", () => {
  const fixtures: Fixture[] = [];

  afterAll(() => {
    for (const fixture of fixtures) fixture.cleanup();
  });

  test("options.remote_build is refused on orchestrator: k3s", async () => {
    await withDump("remote_build refusal", async () => {
      const fixture = await multinodeFixture();
      fixtures.push(fixture);
      fixture.patchConfig((text) => `${text}\noptions:\n  remote_build: true\n`);

      const result = await runCLI(["validate", ENV], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(result.exitCode).toBe(11);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toContain("options.remote_build is not supported with orchestrator: k3s");
    });
  }, 60_000);

  test("a helm: section is refused off orchestrator: k3s", async () => {
    await withDump("helm requires k3s", async () => {
      const fixture = await multinodeFixture();
      fixtures.push(fixture);
      fixture.patchConfig(
        (text) =>
          `${text.replace("orchestrator: k3s", "orchestrator: swarm")}\nhelm:\n  releases:\n    - name: sample\n      chart: sample-chart\n      repo: "https://charts.example.com"\n      version: "1.0.0"\n`,
      );

      const result = await runCLI(["validate", ENV], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(result.exitCode).toBe(11);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toContain("helm releases require orchestrator: k3s");
    });
  }, 60_000);
});
