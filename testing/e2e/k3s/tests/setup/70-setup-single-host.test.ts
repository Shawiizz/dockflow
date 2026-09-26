/**
 * Lane k3s-setup, E-70 (design-07 17.7; design-05 22.3 E1): the local single-host k3s flow
 * (`dockflow setup --orchestrator k3s --host <ip> --user <user> --generate-key`), run as root
 * *inside* one bare node container rather than through the cluster coordinator — there is no SSH
 * transport in this mode, the binary provisions the machine it runs on (design-05 4.8).
 *
 * This file owns its own container (`setup-single`, <setup net>.31) and destroys it in `afterAll`; no
 * other setup-lane file may assume it is still there.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, test } from "bun:test";
import { HELM_PIN } from "../../../../../cli/src/services/orchestrator/kubernetes/versions";
import { K3S_PIN } from "../../../../../cli/src/services/orchestrator/kubernetes/k3s/versions";
import { renderK3sSudoers } from "../../../../../cli/src/services/orchestrator/kubernetes/k3s/sudoers";
import { K8S_STORAGE_CLASS, K8S_SYSTEM_NAMESPACE, K8S_DEPLOYER_SERVICE_ACCOUNT, K8S_DEPLOYER_CLUSTER_ROLE_BINDING, K8S_DEPLOYER_TOKEN_SECRET } from "../../../../../cli/src/services/orchestrator/kubernetes/constants";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { exec, tryExec, startStandaloneNode, stopTopology, type ExecResult } from "../../../helpers/cluster";
import { connectionEnvKey, encodeConnection, type SshConnection } from "../../../helpers/connection";
import { dumpDebug } from "../../../helpers/debug-dump";
import { serversYml } from "../../../helpers/fixtures";
import { SETUP_LANE, standaloneNode, type TopologyNode } from "../../../helpers/topology";

const FILE = "70-setup-single-host.test.ts";
const DEPLOY_USER = "deploytest";
const DOCKFLOW_BIN = "/usr/local/bin/dockflow-e2e";

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${name}`).catch(() => {});
    throw error;
  }
}

const node: TopologyNode = standaloneNode(SETUP_LANE, {
  key: "server_1",
  name: "setup-single",
  octet: 31,
  sshPort: SETUP_LANE.sshPorts.server_1,
});

async function rootExec(command: string): Promise<ExecResult> {
  return tryExec(["docker", "exec", "--user", "root", node.container, "sh", "-c", command]);
}

async function mustRootExec(command: string): Promise<string> {
  return exec(["docker", "exec", "--user", "root", node.container, "sh", "-c", command]);
}

/** The local flow runs `dockflow` in-process against this machine; each call is a fresh docker exec. */
async function runLocalSetup(args: string[], timeoutMs = 600_000): Promise<ExecResult> {
  return tryExec(["docker", "exec", "--user", "root", node.container, DOCKFLOW_BIN, ...args], { timeoutMs });
}

async function kubectlOn(args: string[]): Promise<string> {
  return exec(["docker", "exec", node.container, "/usr/local/bin/k3s", "kubectl", ...args]);
}

interface StatInfo {
  owner: string;
  group: string;
  mode: string;
}

async function statOn(path: string): Promise<StatInfo | null> {
  const result = await tryExec(["docker", "exec", node.container, "stat", "-c", "%U %G %a", path]);
  if (result.exitCode !== 0) return null;
  const [owner, group, mode] = result.stdout.trim().split(/\s+/);
  return owner && group && mode ? { owner, group, mode } : null;
}

describe("E-70 setup-single-host (local mode)", () => {
  afterAll(async () => {
    await stopTopology(SETUP_LANE.project);
  });

  test("provisions the container and copies the binary under test", async () => {
    await withDump("provision", async () => {
      await startStandaloneNode(SETUP_LANE, node, { timeoutMs: 180_000 });
      await exec(["docker", "cp", resolveCliBinaryPath(), `${node.container}:${DOCKFLOW_BIN}`]);
      await mustRootExec(`chmod 755 ${DOCKFLOW_BIN}`);
    });
  });

  test("E-70-01: local setup exits 0 with a success line", async () => {
    await withDump("E-70-01", async () => {
      const result = await runLocalSetup([
        "setup",
        "--orchestrator",
        "k3s",
        "--yes",
        "--host",
        node.ip,
        "--user",
        DEPLOY_USER,
        "--generate-key",
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`local setup failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/is running on this host|Setup Complete/);
    });
  });

  test("E-70-02: k3s, k3s binary and helm are the pinned versions", async () => {
    await withDump("E-70-02", async () => {
      const version = await mustRootExec("k3s --version");
      expect(version).toContain(K3S_PIN.version);

      const sha = await mustRootExec("sha256sum /usr/local/bin/k3s | awk '{print $1}'");
      expect(sha.trim()).toBe(K3S_PIN.binaries.amd64.sha256);

      const helmVersion = await mustRootExec("/usr/local/lib/dockflow/bin/helm version --short 2>/dev/null || /usr/local/lib/dockflow/bin/helm version");
      expect(helmVersion).toContain(HELM_PIN.version);
    });
  });

  test("E-70-03: the config drop-in enables encryption, 0600 kubeconfig mode and disables traefik, no token value", async () => {
    await withDump("E-70-03", async () => {
      const dropin = await mustRootExec("cat /etc/rancher/k3s/config.yaml.d/50-dockflow.yaml");
      expect(dropin).toContain("secrets-encryption: true");
      expect(dropin).toContain('write-kubeconfig-mode: "0600"');
      expect(dropin).toMatch(/disable:\s*\n(\s*-\s*\S+\n)*\s*-\s*traefik/);
      expect(dropin).not.toMatch(/token:\s*\S/);
    });
  });

  test("E-70-04: file modes on k3s.yaml, the server token and /var/lib/dockflow", async () => {
    await withDump("E-70-04", async () => {
      expect(await statOn("/etc/rancher/k3s/k3s.yaml")).toEqual({ owner: "root", group: "root", mode: "600" });
      expect(await statOn("/var/lib/rancher/k3s/server/token")).toEqual({ owner: "root", group: "root", mode: "600" });
      const dockflowDir = await statOn("/var/lib/dockflow");
      expect(dockflowDir?.owner).toBe(DEPLOY_USER);
      expect(dockflowDir?.mode).toBe("750");
    });
  });

  test("E-70-05: the node registers as setup-single", async () => {
    await withDump("E-70-05", async () => {
      const names = await kubectlOn(["get", "nodes", "-o", "jsonpath={.items[*].metadata.name}"]);
      expect(names.trim().split(/\s+/)).toContain("setup-single");
    });
  });

  test("E-70-06: cluster objects (no traefik, StorageClass, system namespace, deployer identity)", async () => {
    await withDump("E-70-06", async () => {
      const charts = await tryExec(["docker", "exec", node.container, "/usr/local/bin/k3s", "kubectl", "get", "helmcharts.helm.cattle.io", "-n", "kube-system", "-o", "name"]);
      expect(charts.stdout).not.toContain("traefik");

      const scJson = await kubectlOn(["get", "storageclass", K8S_STORAGE_CLASS, "-o", "json"]);
      const sc = JSON.parse(scJson) as { reclaimPolicy?: string; provisioner?: string };
      expect(sc.reclaimPolicy).toBe("Retain");
      expect(sc.provisioner).toBe("rancher.io/local-path");

      const ns = await kubectlOn(["get", "namespace", K8S_SYSTEM_NAMESPACE, "-o", "name"]);
      expect(ns.trim()).toBe(`namespace/${K8S_SYSTEM_NAMESPACE}`);

      const sa = await kubectlOn(["get", "serviceaccount", K8S_DEPLOYER_SERVICE_ACCOUNT, "-n", K8S_SYSTEM_NAMESPACE, "-o", "name"]);
      expect(sa.trim()).toBe(`serviceaccount/${K8S_DEPLOYER_SERVICE_ACCOUNT}`);
      const crb = await kubectlOn(["get", "clusterrolebinding", K8S_DEPLOYER_CLUSTER_ROLE_BINDING, "-o", "name"]);
      expect(crb.trim()).toBe(`clusterrolebinding/${K8S_DEPLOYER_CLUSTER_ROLE_BINDING}`);
      const secret = await kubectlOn(["get", "secret", K8S_DEPLOYER_TOKEN_SECRET, "-n", K8S_SYSTEM_NAMESPACE, "-o", "name"]);
      expect(secret.trim()).toBe(`secret/${K8S_DEPLOYER_TOKEN_SECRET}`);
    });
  });

  test("E-70-07: secrets encryption is enabled", async () => {
    await withDump("E-70-07", async () => {
      const status = await mustRootExec("k3s secrets-encrypt status");
      expect(status).toMatch(/Encryption Status:\s*Enabled/);
    });
  });

  test("E-70-08: sudoers is 440, visudo -c passes and matches renderK3sSudoers", async () => {
    await withDump("E-70-08", async () => {
      const stat = await statOn("/etc/sudoers.d/dockflow-k3s");
      expect(stat?.mode).toBe("440");
      const visudo = await rootExec("visudo -cf /etc/sudoers.d/dockflow-k3s");
      expect(visudo.exitCode).toBe(0);
      // exec trims its output, the trailing newline included
      const content = await mustRootExec("cat /etc/sudoers.d/dockflow-k3s");
      expect(content).toBe(renderK3sSudoers(DEPLOY_USER).trimEnd());
    });
  });

  test("E-70-09: re-running local setup is a no-op", async () => {
    await withDump("E-70-09", async () => {
      const before = await mustRootExec("systemctl show k3s -p ActiveEnterTimestamp");
      const dropinBefore = await mustRootExec("sha256sum /etc/rancher/k3s/config.yaml.d/50-dockflow.yaml");
      const sudoersBefore = await mustRootExec("sha256sum /etc/sudoers.d/dockflow-k3s");
      const kubeconfigBefore = await mustRootExec("sha256sum /etc/rancher/k3s/k3s.yaml");

      const result = await runLocalSetup(["setup", "--orchestrator", "k3s", "--yes", "--host", node.ip, "--user", DEPLOY_USER]);
      expect(result.exitCode).toBe(0);

      const after = await mustRootExec("systemctl show k3s -p ActiveEnterTimestamp");
      expect(after).toBe(before);
      expect(await mustRootExec("sha256sum /etc/rancher/k3s/config.yaml.d/50-dockflow.yaml")).toBe(dropinBefore);
      expect(await mustRootExec("sha256sum /etc/sudoers.d/dockflow-k3s")).toBe(sudoersBefore);
      expect(await mustRootExec("sha256sum /etc/rancher/k3s/k3s.yaml")).toBe(kubeconfigBefore);
    });
  });

  test("E-70-10: a minimal deploy from the runner to this host succeeds", async () => {
    await withDump("E-70-10", async () => {
      // The local flow authorizes a freshly generated key (never the harness's fixed deploy key), so
      // the fixture's connection is built by hand from the key this node actually holds. This host
      // has no deployable template under fixtures/ (test-app-k3s-cluster is setup-only), so the
      // minimal app is built entirely under the OS temp dir, like helpers/fixtures.ts's own factory.
      const privateKey = await mustRootExec(`cat /root/.ssh/${DEPLOY_USER}_key`);
      const dir = mkdtempSync(join(tmpdir(), "dockflow-e2e-k3s-single-"));
      try {
        mkdirSync(join(dir, ".dockflow", "docker"), { recursive: true });
        writeFileSync(join(dir, ".dockflow", "config.yml"), "project_name: k3s-single\norchestrator: k3s\n");
        writeFileSync(
          join(dir, ".dockflow", "docker", "docker-compose.yml"),
          ["services:", "  app:", "    image: busybox:1.36", '    command: ["sh", "-c", "sleep infinity"]', ""].join("\n"),
        );
        writeFileSync(join(dir, ".dockflow", "servers.yml"), serversYml([node], ["e2e"]));
        const conn: SshConnection = { host: "localhost", port: node.sshPort, user: DEPLOY_USER, privateKey };
        writeFileSync(join(dir, ".env.dockflow"), `${connectionEnvKey("e2e", node.key)}=${encodeConnection(conn)}\n`);

        const result = await runCLI(["deploy", "e2e", "1.0.0"], { cwd: dir, timeoutMs: 300_000 });
        if (result.exitCode !== 0) throw new Error(`deploy failed (exit ${result.exitCode}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
        expect(result.exitCode).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
