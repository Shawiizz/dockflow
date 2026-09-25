/**
 * k3s-day2 lane (design-07 17.3, E-38): the WebUI's local API server (`dockflow ui`) against the
 * same `k3s-day2` stack 37-day2.test.ts deployed — files in a shared-cluster lane run in their own
 * process (design-07 16.9), but the cluster and its stacks persist between them, so this file only
 * needs a fresh fixture copy (same config.yml, same project) to point the server at it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCLI, runCLIInBackground, type CLIBackgroundHandle } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { nsFor, podsForService, waitFor } from "../../../helpers/k8s";

const FILE = "38-api.test.ts";
const ENV = "e2e";
const PROJECT = "k3s-day2";
const NS = nsFor(PROJECT);
const PORT = 39090;
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ORIGIN}${path}`, init);
}

async function wsMessageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

describe("WebUI API", () => {
  let fixture: Fixture;
  let ui: CLIBackgroundHandle;

  beforeAll(async () => {
    fixture = makeFixture("test-app-k3s-day2", { cluster: "k3s" });
    ui = runCLIInBackground(["ui", "--port", String(PORT), "--no-open"], { cwd: fixture.dir, timeoutMs: 15 * 60_000 });

    await waitFor(
      async () => {
        try {
          const response = await api("/api/health");
          return response.status === 200 ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { timeoutMs: 30_000, describe: "the WebUI API server to answer /api/health" },
    );
  }, 60_000);

  afterAll(async () => {
    ui?.kill();
    await ui?.done.catch(() => {});
    fixture?.cleanup();
  });

  test("E-38-01: /api/services lists web with structured replicas", async () => {
    await withDump("services list", async () => {
      const response = await api(`/api/services?env=${ENV}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { services: { name: string; replicas: number; replicasRunning: number }[] };
      const web = body.services.find((s) => s.name === "web");
      expect(web).toBeDefined();
      expect(web?.replicas).toBeGreaterThan(0);
      expect(typeof web?.replicasRunning).toBe("number");
    });
  });

  test("E-38-02: restart route changes web's pod UIDs", async () => {
    await withDump("restart route", async () => {
      const before = new Set((await podsForService(NS, "web")).map((p) => p.metadata.uid));
      const response = await api(`/api/services/web/restart?env=${ENV}`, { method: "POST" });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean };
      expect(body.success).toBe(true);

      await waitFor(
        async () => {
          const after = new Set((await podsForService(NS, "web")).map((p) => p.metadata.uid));
          return [...after].some((uid) => uid && !before.has(uid)) ? true : undefined;
        },
        { timeoutMs: 60_000, describe: "web's pod UIDs to change after the restart route" },
      );
    });
  }, 90_000);

  test("E-38-03: accessories status lists cache", async () => {
    await withDump("accessories status", async () => {
      const response = await api(`/api/accessories/status?env=${ENV}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { accessories: { name: string; status?: string }[] };
      expect(body.accessories.some((a) => a.name === "cache")).toBe(true);
    });
  });

  test("E-38-04: resources prune of a refused target answers 501, disk usage answers 200", async () => {
    await withDump("resources", async () => {
      const disk = await api(`/api/resources/disk?env=${ENV}`);
      expect(disk.status).toBe(200);
      const diskBody = (await disk.json()) as { raw: string };
      expect(typeof diskBody.raw).toBe("string");

      for (const target of ["volumes", "networks"]) {
        const response = await api("/api/resources/prune", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targets: [target] }),
        });
        expect(response.status).toBe(501);
        const body = (await response.json()) as { success: boolean; message: string; suggestion?: string };
        expect(body.success).toBe(false);
        expect(typeof body.message).toBe("string");
        expect(body.message.length).toBeGreaterThan(0);
      }
    });
  });

  test("E-38-05: server status reports controlPlaneStatus for server_1", async () => {
    await withDump("server status", async () => {
      const response = await api(`/api/servers/server_1/status?env=${ENV}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; controlPlaneStatus?: string };
      expect(body.status).toBe("online");
      expect(body.controlPlaneStatus).toBe("ready");
    });
  });

  test("E-38-06: WebSocket exec on web runs a command and returns its output", async () => {
    await withDump("ws exec", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/exec/web?env=${ENV}`);
      const collected: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for ws exec output")), 20_000);
        ws.addEventListener("message", (event) => {
          void (async () => {
            const text = await wsMessageText(event.data);
            if (text.includes('"type":"connected"')) {
              ws.send("echo e2e-ws\n");
              return;
            }
            collected.push(text);
            if (collected.join("").includes("e2e-ws")) {
              clearTimeout(timer);
              resolve();
            }
          })();
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("ws exec connection error"));
        });
      });

      ws.close();
      expect(collected.join("")).toContain("e2e-ws");
    });
  });

  test("E-38-07: a lock acquired through the API is visible to `lock status`", async () => {
    await withDump("locks", async () => {
      const acquire = await api(`/api/locks/${ENV}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "E-38-07" }),
      });
      expect(acquire.status).toBe(200);
      const acquireBody = (await acquire.json()) as { success: boolean };
      expect(acquireBody.success).toBe(true);

      try {
        const status = await runCLI(["lock", "status", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
        expect(status.exitCode).toBe(0);
        expect(status.stderr).toMatch(/LOCKED/i); // decorative output (printInfo/printWarning) goes to stderr
      } finally {
        await api(`/api/locks/${ENV}`, { method: "DELETE" });
      }
    });
  });

  test("E-38-health: /api/health answers", async () => {
    const response = await api("/api/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
