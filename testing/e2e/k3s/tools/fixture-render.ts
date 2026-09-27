/**
 * Objects the fixture recorders put on the cluster, rendered by Dockflow's own normalizer and
 * translator and applied the way a deploy applies them (server-side, field manager `dockflow`).
 */

import { tmpdir } from "os";
import { FIXTURE_PROJECT, FIXTURE_RELEASE, FIXTURE_SERVERS } from "../../../../cli/src/__tests__/kubernetes/support/kubectl-fixtures";
import { loadFromString } from "../../../../cli/src/services/compose";
import { DiagnosticSink } from "../../../../cli/src/services/orchestrator/diagnostics";
import { createFileResolver } from "../../../../cli/src/services/orchestrator/file-resolver";
import type { StackRole } from "../../../../cli/src/services/orchestrator/interfaces";
import { K8S_PROGRESS_DEADLINE_S } from "../../../../cli/src/services/orchestrator/kubernetes/constants";
import type { DistributionTraits } from "../../../../cli/src/services/orchestrator/kubernetes/distribution";
import { k3sDistribution } from "../../../../cli/src/services/orchestrator/kubernetes/k3s/distribution";
import type { StackIdentity } from "../../../../cli/src/services/orchestrator/kubernetes/model/types";
import { normalizeStack } from "../../../../cli/src/services/orchestrator/kubernetes/normalize";
import { revisionHistoryLimitFor } from "../../../../cli/src/services/orchestrator/kubernetes/render";
import type { ManifestObject } from "../../../../cli/src/services/orchestrator/kubernetes/resources/registry";
import { translateStack } from "../../../../cli/src/services/orchestrator/kubernetes/translate";
import { kubectl } from "../../helpers/k8s";

/** servers.yml keys of the recording lane; `node.hostname == agent_1` pins a pod to node agent-1 */
export const SERVER_NAMES = Object.values(FIXTURE_SERVERS);

export function identityOf(ns: string): StackIdentity {
  return { project: FIXTURE_PROJECT, env: "production", stackName: `${FIXTURE_PROJECT}-production`, namespace: ns, version: FIXTURE_RELEASE };
}

export interface RenderOptions {
  role?: StackRole;
  traits?: Partial<DistributionTraits>;
}

/** The objects a deploy of `compose` applies for `role`, rendered into `ns`: render.ts without the artifact. */
export function render(ns: string, compose: string, options: RenderOptions = {}): ManifestObject[] {
  const role = options.role ?? "app";
  const file = role === "app" ? "docker-compose.yml" : "accessories.yml";
  const traits: DistributionTraits = { ...structuredClone(k3sDistribution.traits), ...options.traits };
  const sink = new DiagnosticSink();
  const refuse = (): never => {
    const errors = sink.list().filter((d) => d.severity === "error");
    throw new Error(`The ${file} of ${ns} does not render:\n${errors.map((d) => `  - ${d.path}: ${d.message}`).join("\n")}`);
  };
  const { stack } = normalizeStack({
    compose: loadFromString(compose, file),
    role,
    identity: identityOf(ns),
    proxy: undefined,
    sibling: { services: [], volumes: [], middlewares: [] },
    serverNames: [...SERVER_NAMES],
    imageDelivery: "import",
    files: createFileResolver(new Map(), tmpdir()),
    traits,
    sink,
  });
  if (sink.hasErrors()) refuse();
  const { objects } = translateStack(stack, {
    pullSecretName: null,
    revisionHistoryLimit: revisionHistoryLimitFor(undefined),
    progressDeadlineS: K8S_PROGRESS_DEADLINE_S,
    traits,
    extraReservedHostPorts: [{ port: 22, protocol: "TCP", reason: "SSH" }],
    traefikOnCluster: false,
    serverNames: [...SERVER_NAMES],
    sink,
  });
  if (sink.hasErrors()) refuse();
  return objects;
}

/** Applied as a deploy applies (runtime/kubectl.ts): server-side, field manager dockflow. */
export async function apply(objects: readonly object[]): Promise<void> {
  const list = { apiVersion: "v1", kind: "List", items: objects };
  await kubectl(["apply", "--server-side", "--field-manager=dockflow", "--force-conflicts", "-f", "-"], { stdin: JSON.stringify(list) });
}
