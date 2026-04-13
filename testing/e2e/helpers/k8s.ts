/**
 * Kubernetes assertion helpers for k3s E2E tests.
 * All commands run via `docker exec` against the k3s container.
 */

import { exec } from "./cluster";
import { K3S_MANAGER_CONTAINER } from "./connection";

const KUBECONFIG = "/var/lib/dockflow/k3s.yaml";

/**
 * Run a kubectl command inside the k3s container.
 */
export async function kubectlExec(args: string[]): Promise<string> {
  return exec([
    "docker", "exec", K3S_MANAGER_CONTAINER,
    "kubectl", "--kubeconfig", KUBECONFIG, ...args,
  ]);
}

/**
 * Get deployment replicas as "ready/desired" string.
 */
export async function getDeploymentReplicas(
  ns: string,
  name: string,
): Promise<string> {
  const output = await kubectlExec([
    "get", "deployment", name, "-n", ns, "-o", "json",
  ]);
  const dep = JSON.parse(output);
  const ready = dep.status?.readyReplicas ?? 0;
  const desired = dep.spec?.replicas ?? 0;
  return `${ready}/${desired}`;
}

/**
 * Wait for a deployment to reach expected replicas (e.g. "1/1").
 */
export async function waitForDeployment(
  ns: string,
  name: string,
  expected: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const replicas = await getDeploymentReplicas(ns, name);
      if (replicas === expected) return;
    } catch {
      // Deployment may not exist yet
    }
    await Bun.sleep(2000);
  }

  const current = await getDeploymentReplicas(ns, name).catch(() => "???");
  throw new Error(
    `Deployment ${ns}/${name} did not reach ${expected} within ${timeoutMs}ms (current: ${current})`,
  );
}

/**
 * Get running pod names for a deployment.
 */
export async function getPodNames(
  ns: string,
  label: string,
): Promise<string[]> {
  const output = await kubectlExec([
    "get", "pods", "-n", ns,
    "-l", label,
    "--field-selector=status.phase=Running",
    "-o", "json",
  ]);
  const data = JSON.parse(output);
  return data.items.map((pod: any) => pod.metadata.name);
}

/**
 * Verify deployment stability: no pod restarts during observation period.
 */
export async function isDeploymentStable(
  ns: string,
  name: string,
  durationMs = 5000,
): Promise<boolean> {
  const getPods = async () => {
    const output = await kubectlExec([
      "get", "pods", "-n", ns,
      "-l", `app=${name}`,
      "--field-selector=status.phase=Running",
      "-o", "json",
    ]);
    const data = JSON.parse(output);
    return data.items
      .map((pod: any) => pod.metadata.name)
      .sort()
      .join(",");
  };

  const before = await getPods();
  await Bun.sleep(durationMs);
  const after = await getPods();

  return before === after;
}

/**
 * Dump debug information for k3s cluster diagnostics.
 */
export async function dumpK3sDebug(ns: string): Promise<void> {
  const run = async (label: string, args: string[]) => {
    try {
      const out = await kubectlExec(args);
      console.log(`[k3s-debug] ${label}:\n${out}`);
    } catch (e: any) {
      console.log(`[k3s-debug] ${label}: FAILED - ${e.message?.slice(0, 200)}`);
    }
  };

  // Check images in containerd
  try {
    const images = await exec([
      "docker", "exec", K3S_MANAGER_CONTAINER,
      "k3s", "ctr", "-n", "k8s.io", "images", "ls",
    ]);
    console.log(`[k3s-debug] containerd images (k8s.io):\n${images}`);
  } catch (e: any) {
    console.log(`[k3s-debug] containerd images: FAILED - ${e.message?.slice(0, 200)}`);
  }

  await run("pods", ["get", "pods", "-n", ns, "-o", "wide"]);
  await run("pod events", ["get", "events", "-n", ns, "--sort-by=.lastTimestamp"]);
  await run("describe pods", ["describe", "pods", "-n", ns]);
}

/**
 * Check if a namespace exists.
 */
export async function namespaceExists(ns: string): Promise<boolean> {
  try {
    await kubectlExec(["get", "namespace", ns]);
    return true;
  } catch {
    return false;
  }
}
