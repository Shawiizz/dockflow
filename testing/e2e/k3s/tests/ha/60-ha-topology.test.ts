/**
 * HA topology (design-07 17.6, E-60): the `ha` topology's 3 servers carry k3s's own control-plane
 * and embedded-etcd role labels (design-05 1216), the agent carries neither, and every node is
 * Ready; each server's own Dockflow kubeconfig (DESIGN-CORE 6.7 K8S_KUBECONFIG_PATH) exists, the
 * agent's does not — it never coordinates an orchestrator command (core 6.6 step 2).
 *
 * No deploy happens in this file: it only inspects the cluster the lane preload already provisioned.
 */

import { describe, expect, test } from "bun:test";
import { dumpDebug } from "../../../helpers/debug-dump";
import { getJson, kubectl, nodeExec } from "../../../helpers/k8s";
import { currentTopology, managersOf, type NodeKey } from "../../../helpers/topology";

const FILE = "60-ha-topology.test.ts";

// K/constants.ts K8S_KUBECONFIG_PATH (DESIGN-CORE 6.7): the deploy identity's own kubeconfig, written
// by setup only on servers — never on an agent, which cannot coordinate orchestrator commands.
const K8S_KUBECONFIG_PATH = "/var/lib/dockflow/kube/config";

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${name}`).catch(() => {});
    throw error;
  }
}

interface NodeLike {
  metadata: { name: string; labels?: Record<string, string> };
  status?: { conditions?: { type: string; status: string }[] };
}

async function kubeconfigPresent(node: NodeKey): Promise<boolean> {
  const result = await nodeExec(node, `test -f '${K8S_KUBECONFIG_PATH}' && echo yes || echo no`);
  return result.stdout.trim() === "yes";
}

describe("HA topology", () => {
  test("E-60-01: servers carry the control-plane and etcd role labels, the agent carries neither, and every node is Ready", async () => {
    await withDump("E-60-01", async () => {
      const topo = currentTopology();
      expect(topo.name).toBe("ha");
      expect(managersOf(topo).length).toBe(3);

      const nodes = await getJson<NodeLike>("nodes");
      expect(nodes.length).toBe(topo.nodes.length);

      for (const node of topo.nodes) {
        const live = nodes.find((candidate) => candidate.metadata.name === node.service);
        expect(live).toBeDefined();

        const ready = live?.status?.conditions?.find((condition) => condition.type === "Ready");
        expect(ready?.status).toBe("True");

        const labels = live?.metadata.labels ?? {};
        if (node.role === "manager") {
          expect(labels["node-role.kubernetes.io/control-plane"]).toBe("true");
          expect(labels["node-role.kubernetes.io/etcd"]).toBe("true");
        } else {
          expect(labels["node-role.kubernetes.io/control-plane"]).toBeUndefined();
          expect(labels["node-role.kubernetes.io/etcd"]).toBeUndefined();
        }
      }
    });
  });

  test("E-60-02: /readyz is ok on every server; the Dockflow kubeconfig exists on each server and is absent on the agent", async () => {
    await withDump("E-60-02", async () => {
      const topo = currentTopology();

      for (const server of managersOf(topo)) {
        const body = await kubectl(["get", "--raw=/readyz"], { node: server.key });
        expect(body.trim()).toBe("ok");
        expect(await kubeconfigPresent(server.key)).toBe(true);
      }

      const agent = topo.nodes.find((node) => node.role === "worker");
      expect(agent).toBeDefined();
      if (agent) expect(await kubeconfigPresent(agent.key)).toBe(false);
    });
  });
});
