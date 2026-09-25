/**
 * E-36 (design-07 17.1 36-security-nondestructive.test.ts): secret handling and the deploy identity,
 * every step read-only against cluster-level state (K67 (a)) — the destructive identity-recovery
 * checks that used to live here (E-36-10..12) now run in the setup lane as `77-identity-recovery`
 * against a container that exists only for them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { K8S_KUBECONFIG_DIR, K8S_KUBECONFIG_PATH } from "../../../../../cli/src/services/orchestrator/kubernetes/constants";
import { K3S_SUDO_COMMANDS, renderK3sSudoers } from "../../../../../cli/src/services/orchestrator/kubernetes/k3s/sudoers";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { deleteStackCompletely, decodeRelease, nodeExec, nsFor } from "../../../helpers/k8s";
import { watchProcesses } from "../../../helpers/leak-watch";
import { currentTopology } from "../../../helpers/topology";

const FILE = "36-security-nondestructive.test.ts";
const NS = nsFor("k3s-security");
const SECRET_ENV_MARKER = "E2E_SECRET_ENV_7f3a9c";
const SECRET_FILE_MARKER = "E2E_SECRET_FILE_7f3a9c";

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

describe("E-36 secret handling and deploy identity (non-destructive)", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture("test-app-k3s-security", { cluster: "k3s", topology: currentTopology() });
  });

  afterAll(async () => {
    await runCLI(["stop", "e2e", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
    await deleteStackCompletely(NS);
    fixture.cleanup();
  });

  test("E-36-01/02: no secret marker crosses the wire or the CLI's own output during deploy e2e 1.0.0", async () => {
    await withDump("E-36-01-02", async () => {
      const watch = watchProcesses(["server_1", "agent_1"], [new RegExp(SECRET_ENV_MARKER), new RegExp(SECRET_FILE_MARKER)]);
      const result = await runCLI(["deploy", "e2e", "1.0.0"], { cwd: fixture.dir, timeoutMs: 240_000 });
      const hits = await watch.stop();
      expect(hits).toEqual([]);
      expect(result.exitCode).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).not.toContain(SECRET_ENV_MARKER);
      expect(out).not.toContain(SECRET_FILE_MARKER);
    });
  });

  test("E-36-03: the decoded release metadata carries no secret marker", async () => {
    await withDump("E-36-03", async () => {
      const release = await decodeRelease(NS, "1.0.0");
      const text = JSON.stringify(release.metadata);
      expect(text).not.toContain(SECRET_ENV_MARKER);
      expect(text).not.toContain(SECRET_FILE_MARKER);
    });
  });

  test("E-36-04: the deploy identity's kubeconfig is 0600 on server-1 only, in a 0700 directory", async () => {
    await withDump("E-36-04", async () => {
      const stat = await nodeExec("server_1", `stat -c '%a %U' ${K8S_KUBECONFIG_PATH}`, { user: "root" });
      expect(stat.exitCode).toBe(0);
      expect(stat.stdout.trim()).toBe("600 deploytest");
      const dirStat = await nodeExec("server_1", `stat -c '%a %U' ${K8S_KUBECONFIG_DIR}`, { user: "root" });
      expect(dirStat.stdout.trim()).toBe("700 deploytest");

      const agentStat = await nodeExec("agent_1", `test -e ${K8S_KUBECONFIG_PATH} && echo present || echo absent`, { user: "root" });
      expect(agentStat.stdout.trim()).toBe("absent");
    });
  });

  test("E-36-05: the sudoers file matches renderK3sSudoers exactly, and the effective grant is the closed set", async () => {
    await withDump("E-36-05", async () => {
      const expected = renderK3sSudoers("deploytest");
      const content = await nodeExec("server_1", "cat /etc/sudoers.d/dockflow-k3s", { user: "root" });
      expect(content.stdout).toBe(expected);
      const mode = await nodeExec("server_1", "stat -c %a /etc/sudoers.d/dockflow-k3s", { user: "root" });
      expect(mode.stdout.trim()).toBe("440");
      const visudo = await nodeExec("server_1", "visudo -cf /etc/sudoers.d/dockflow-k3s", { user: "root" });
      expect(visudo.exitCode).toBe(0);

      const listed = await nodeExec("server_1", "sudo -n -l -U deploytest", { user: "root" });
      expect(listed.exitCode).toBe(0);
      for (const command of K3S_SUDO_COMMANDS) {
        const head = command.split(" ").slice(0, 3).join(" ");
        expect(listed.stdout).toContain(head);
      }
      expect(listed.stdout).not.toMatch(/\(ALL\s*:\s*ALL\)/);
      expect(listed.stdout).not.toMatch(/NOPASSWD:\s*ALL\b/);
      expect(listed.stdout).not.toContain("cat /var/lib/rancher/k3s/server/node-token");
      expect(listed.stdout).not.toMatch(/k3s ctr -n k8s\.io images \*/);
    });
  });

  test("E-36-06: the deploy user cannot read the join token, the admin kubeconfig, or export images", async () => {
    await withDump("E-36-06", async () => {
      const token = await nodeExec("server_1", "cat /var/lib/rancher/k3s/server/token", { user: "deploytest" });
      expect(token.exitCode).not.toBe(0);
      const adminConfig = await nodeExec("server_1", "cat /etc/rancher/k3s/k3s.yaml", { user: "deploytest" });
      expect(adminConfig.exitCode).not.toBe(0);
      const exportImage = await nodeExec(
        "server_1",
        "sudo -n /usr/local/bin/k3s ctr -n k8s.io images export /tmp/x.tar docker.io/library/busybox:1.37",
        { user: "deploytest" },
      );
      expect(exportImage.exitCode).not.toBe(0);
    });
  });

  test("E-36-07: secrets-encrypt is enabled", async () => {
    await withDump("E-36-07", async () => {
      const status = await nodeExec("server_1", "k3s secrets-encrypt status", { user: "root" });
      expect(status.stdout).toContain("Encryption Status: Enabled");
    });
  });

  test("E-36-08: the deploy identity's kubeconfig authenticates as the dockflow-deployer service account", async () => {
    await withDump("E-36-08", async () => {
      const whoami = await nodeExec(
        "server_1",
        `/usr/local/bin/k3s kubectl --kubeconfig=${K8S_KUBECONFIG_PATH} auth whoami -o json`,
        { user: "deploytest" },
      );
      expect(whoami.exitCode).toBe(0);
      const parsed = JSON.parse(whoami.stdout) as { status?: { userInfo?: { username?: string } } };
      expect(parsed.status?.userInfo?.username).toBe("system:serviceaccount:dockflow-system:dockflow-deployer");
    });
  });

  test("E-36-09: a crashing deploy never leaks the secret, redacted only with --debug", async () => {
    await withDump("E-36-09", async () => {
      fixture.patchCompose((text) => text.replace("MODE: serve", "MODE: crash"));

      const plain = await runCLI(["deploy", "e2e", "1.0.1"], { cwd: fixture.dir, timeoutMs: 240_000 });
      expect(plain.exitCode).toBe(53);
      const plainOut = plain.stdout + plain.stderr;
      expect(plainOut).not.toContain(SECRET_ENV_MARKER);

      // Same crashing version redeployed with --debug: the row checks that --debug is what turns the
      // redaction on, not that the crash produces different output otherwise.
      const debugRun = await runCLI(["deploy", "e2e", "1.0.1", "--debug"], { cwd: fixture.dir, timeoutMs: 240_000 });
      expect(debugRun.exitCode).toBe(53);
      const debugOut = debugRun.stdout + debugRun.stderr;
      expect(debugOut).not.toContain(SECRET_ENV_MARKER);
      expect(debugOut).toContain("***");
    });
  });

  test("E-36-13: the pre-deploy hook receives the documented environment in its own private directory", async () => {
    await withDump("E-36-13", async () => {
      fixture.patchCompose((text) => text.replace("MODE: crash", "MODE: serve"));
      const result = await runCLI(["deploy", "e2e", "1.0.2"], { cwd: fixture.dir, timeoutMs: 240_000 });
      expect(result.exitCode).toBe(0);

      const output = await nodeExec("server_1", "cat $HOME/e2e-hook-output-1.0.2.txt", { user: "deploytest" });
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toContain("DOCKFLOW_ORCHESTRATOR=k3s");
      expect(output.stdout).toContain(`DOCKFLOW_NAMESPACE=${NS}`);
      expect(output.stdout).toContain("DOCKFLOW_STACK=k3s-security-e2e");
      expect(output.stdout).toContain("DOCKFLOW_VERSION=1.0.2");
      expect(output.stdout).toContain(`KUBECONFIG=${K8S_KUBECONFIG_PATH}`);
      expect(output.stdout).toContain("DOCKFLOW_KUBECTL=/usr/local/bin/k3s kubectl");
      expect(output.stdout).toContain("NS_OK=1");
      const pwdLine = output.stdout.split(/\r?\n/).find((line) => line.startsWith("PWD="));
      const workingDir = pwdLine?.slice("PWD=".length) ?? "";
      expect(workingDir).toContain("/var/lib/dockflow/hooks/");

      const dirStat = await nodeExec("server_1", `stat -c '%a %U' '${workingDir}'`, { user: "root" });
      expect(dirStat.stdout.trim()).toBe("700 deploytest");
    });
  });

  test("E-36-14: exec output and a --debug transcript never carry a kubectl/helm stdout payload", async () => {
    await withDump("E-36-14", async () => {
      // exec's own debug transcript, not the container's output: `env` in the container prints
      // SECRET_ENV because the compose file sets it, which is the user's data
      const execDebug = await runCLI(["exec", "e2e", "web", "--", "true"], { cwd: fixture.dir, timeoutMs: 30_000, env: { DEBUG: "true" } });
      expect(execDebug.exitCode).toBe(0);
      const execOut = execDebug.stdout + execDebug.stderr;
      expect(execOut).not.toContain(SECRET_ENV_MARKER);
      expect(execOut).not.toMatch(/^apiVersion:/m);

      const debugDeploy = await runCLI(["deploy", "e2e", "1.0.2", "--debug"], { cwd: fixture.dir, timeoutMs: 240_000 });
      const out = debugDeploy.stdout + debugDeploy.stderr;
      expect(out).not.toContain(SECRET_ENV_MARKER);
      expect(out).not.toContain(SECRET_FILE_MARKER);
      expect(out).not.toMatch(/^apiVersion:/m);
    });
  });
});
