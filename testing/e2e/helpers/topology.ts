/**
 * k3s e2e topologies and network plan: which node containers a lane starts, their servers.yml keys,
 * addresses and SSH ports, and the auxiliary containers that share the lane network.
 *
 * Container names follow docker compose (`<project>-<service>-1`), so the shared lanes (project
 * `dockflow-k3s`) and the setup lane (project `dockflow-k3s-setup`) can use the same compose file.
 */

export type NodeKey = "server_1" | "server_2" | "server_3" | "agent_1" | "agent_2";
export type NodeRole = "manager" | "worker";
export type TopologyName = "duo" | "trio" | "ha";

export const NODE_KEYS: readonly NodeKey[] = ["server_1", "server_2", "server_3", "agent_1", "agent_2"];
export const TOPOLOGY_NAMES: readonly TopologyName[] = ["duo", "trio", "ha"];

/** Where a set of node containers lives: compose project, /24 subnet and host SSH ports. */
export interface NetworkPlan {
  readonly project: string;
  /** first three octets of the /24 subnet, e.g. `172.30.0` */
  readonly net: string;
  readonly sshPorts: Readonly<Record<NodeKey, number>>;
}

/** k3s-core, k3s-lifecycle, k3s-day2, k3s-multinode, k3s-proxy-helm and k3s-ha. */
export const SHARED_LANE: NetworkPlan = {
  project: "dockflow-k3s",
  net: "172.30.0",
  sshPorts: { server_1: 32230, server_2: 32231, server_3: 32232, agent_1: 32233, agent_2: 32234 },
};

/** k3s-setup: fresh containers per test file, SSH ports 32240-32249. */
export const SETUP_LANE: NetworkPlan = {
  project: "dockflow-k3s-setup",
  net: "172.31.0",
  sshPorts: { server_1: 32240, server_2: 32241, server_3: 32242, agent_1: 32243, agent_2: 32244 },
};

export interface TopologyNode {
  /** servers.yml key */
  readonly key: NodeKey;
  /** compose service and hostname, which is also the Kubernetes node name */
  readonly service: string;
  readonly role: NodeRole;
  /** address on the lane network, used as servers.yml `private_host` */
  readonly ip: string;
  /** host port mapped to the container's port 22 */
  readonly sshPort: number;
  readonly container: string;
  /** servers.yml `node_labels` */
  readonly labels: Readonly<Record<string, string>>;
}

export interface Topology {
  readonly name: TopologyName;
  readonly project: string;
  readonly net: string;
  readonly nodes: readonly TopologyNode[];
}

const NODE_OCTETS: Readonly<Record<NodeKey, number>> = {
  server_1: 11,
  server_2: 12,
  server_3: 13,
  agent_1: 21,
  agent_2: 22,
};

const MEMBERS: Readonly<Record<TopologyName, readonly NodeKey[]>> = {
  duo: ["server_1", "agent_1"],
  trio: ["server_1", "agent_1", "agent_2"],
  ha: ["server_1", "server_2", "server_3", "agent_1"],
};

const NODE_LABELS: Readonly<Record<TopologyName, Partial<Record<NodeKey, Readonly<Record<string, string>>>>>> = {
  duo: {},
  trio: { agent_1: { zone: "a" }, agent_2: { zone: "b" } },
  ha: {},
};

export function serviceFor(key: NodeKey): string {
  return key.replace("_", "-");
}

export function roleFor(key: NodeKey): NodeRole {
  return key.startsWith("server_") ? "manager" : "worker";
}

export function containerName(project: string, service: string): string {
  return `${project}-${service}-1`;
}

export function isTopologyName(value: string): value is TopologyName {
  return (TOPOLOGY_NAMES as readonly string[]).includes(value);
}

export function topology(name: TopologyName, plan: NetworkPlan = SHARED_LANE): Topology {
  const nodes = MEMBERS[name].map((key): TopologyNode => {
    const service = serviceFor(key);
    return {
      key,
      service,
      role: roleFor(key),
      ip: `${plan.net}.${NODE_OCTETS[key]}`,
      sshPort: plan.sshPorts[key],
      container: containerName(plan.project, service),
      labels: NODE_LABELS[name][key] ?? {},
    };
  });
  return { name, project: plan.project, net: plan.net, nodes };
}

export const TOPOLOGIES: Readonly<Record<TopologyName, Topology>> = {
  duo: topology("duo"),
  trio: topology("trio"),
  ha: topology("ha"),
};

/**
 * One node started with `docker run` instead of compose (setup lane files that need a host of their
 * own, e.g. `setup-single` on `.31` or the identity-recovery server on `.41`).
 */
export function standaloneNode(
  plan: NetworkPlan,
  spec: { key: NodeKey; name: string; octet: number; sshPort: number; labels?: Record<string, string> },
): TopologyNode {
  return {
    key: spec.key,
    service: spec.name,
    role: roleFor(spec.key),
    ip: `${plan.net}.${spec.octet}`,
    sshPort: spec.sshPort,
    container: `${plan.project}-${spec.name}`,
    labels: spec.labels ?? {},
  };
}

/** The topology of the running lane, published by the lane preload in DOCKFLOW_E2E_TOPOLOGY. */
export function currentTopology(): Topology {
  const name = process.env.DOCKFLOW_E2E_TOPOLOGY;
  if (!name) {
    throw new Error("DOCKFLOW_E2E_TOPOLOGY is not set; run the file through its lane (bun run run.ts <lane>) or set DOCKFLOW_E2E_LANE");
  }
  if (!isTopologyName(name)) {
    throw new Error(`DOCKFLOW_E2E_TOPOLOGY is ${name}; expected one of ${TOPOLOGY_NAMES.join(", ")}`);
  }
  return TOPOLOGIES[name];
}

export function nodeFor(topo: Topology, key: NodeKey): TopologyNode {
  const node = topo.nodes.find((candidate) => candidate.key === key);
  if (!node) throw new Error(`Topology ${topo.name} has no node ${key}`);
  return node;
}

export function managersOf(topo: Topology): TopologyNode[] {
  return topo.nodes.filter((node) => node.role === "manager");
}

// ─── Auxiliary containers ──────────────────────────────────────────

export type AuxService = "registry" | "registry-auth" | "charts" | "acme" | "acme-dns" | "outsider";

const AUX_OCTETS: Readonly<Record<AuxService, number>> = {
  registry: 5,
  "registry-auth": 6,
  charts: 7,
  acme: 8,
  "acme-dns": 9,
  outsider: 99,
};

export function auxAddress(net: string, service: AuxService): string {
  return `${net}.${AUX_OCTETS[service]}`;
}

export function auxContainer(project: string, service: AuxService): string {
  return containerName(project, service);
}

/**
 * Registries answer on the same `localhost:<port>` name from the runner (published port) and from
 * every node (socat forwarder unit baked into the node image), so one image name works for push and pull.
 */
export const REGISTRY_PORT = 35010;
export const REGISTRY_AUTH_PORT = 35011;
export const CHARTS_PORT = 35012;
export const E2E_REGISTRY = `localhost:${REGISTRY_PORT}`;
export const E2E_REGISTRY_AUTH = `localhost:${REGISTRY_AUTH_PORT}`;

export const E2E_REGISTRY_USER = "e2e";
export const E2E_REGISTRY_PASSWORD = "E2E_SECRET_REGISTRY_7f3a9c";
export const E2E_CHARTS_USER = "e2e";
export const E2E_CHARTS_PASSWORD = "E2E_SECRET_CHARTS_7f3a9c";

/** Chart repository URL as the nodes see it (plain HTTP, `private` needs basic auth). */
export function chartRepoUrl(net: string, access: "public" | "private"): string {
  return `http://${auxAddress(net, "charts")}:8080/${access}`;
}
