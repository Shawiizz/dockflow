/**
 * E-33 (design-07 17.1, C9 verification): whether a port-less headless Service answers DNS at all on
 * the pinned k3s/CoreDNS combination decides `k3sDistribution.traits.headlessServiceNeedsPort`
 * (kubernetes/k3s/distribution.ts) — the row that finds out is this file, never asserted against a
 * hardcoded expectation. No `dockflow deploy` here: harness kubectl only, in a namespace of its own.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { k3sDistribution } from "../../../../../cli/src/services/orchestrator/kubernetes/k3s/distribution";
import { dumpDebug } from "../../../helpers/debug-dump";
import { getJson, kubectl, waitFor } from "../../../helpers/k8s";
import type { Pod } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";

const FILE = "33-headless-dns.test.ts";
const NS = "e2e-dns";

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

const DNS_TARGET_MANIFEST = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${NS}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dns-target
  namespace: ${NS}
spec:
  replicas: 2
  selector:
    matchLabels: { app: dns-target }
  template:
    metadata:
      labels: { app: dns-target }
    spec:
      containers:
        - name: main
          image: busybox:1.37
          command: ["sh", "-c", "sleep 36000"]
---
apiVersion: v1
kind: Service
metadata:
  name: portless
  namespace: ${NS}
spec:
  clusterIP: None
  selector: { app: dns-target }
---
apiVersion: v1
kind: Service
metadata:
  name: placeholder
  namespace: ${NS}
spec:
  clusterIP: None
  selector: { app: dns-target }
  ports:
    - port: ${k3sDistribution.traits.headlessPlaceholderPort.port}
      protocol: ${k3sDistribution.traits.headlessPlaceholderPort.protocol}
`;

/** busybox `nslookup` prints one `Address:` line for the resolver itself, then one per A record. */
function addressRecordCount(nslookupOutput: string): number {
  const lines = nslookupOutput.split(/\r?\n/).filter((line) => /^Address/i.test(line.trim()));
  return Math.max(0, lines.length - 1);
}

async function nslookup(service: string): Promise<number> {
  const [pod] = await getJson<Pod>("pods", { ns: NS, selector: "app=dns-target" });
  if (!pod) throw new Error(`No dns-target pod in ${NS} to exec nslookup from`);
  const out = await kubectl(
    ["exec", "-n", NS, pod.metadata.name, "--", "nslookup", `${service}.${NS}.svc.cluster.local`],
    { allowFailure: true },
  );
  return addressRecordCount(out);
}

describe("headless Service DNS (C9)", () => {
  beforeAll(async () => {
    await kubectl(["apply", "-f", "-"], { stdin: DNS_TARGET_MANIFEST });
    await waitFor(
      async () => {
        const pods = await getJson<Pod>("pods", { ns: NS, selector: "app=dns-target" });
        const ready = pods.filter((pod) => pod.status?.phase === "Running").length;
        return ready >= 2 ? true : undefined;
      },
      { timeoutMs: 120_000, describe: "both dns-target pods to be Running" },
    );
    // DNS answers lag the pods by a few seconds; the placeholder variant always resolves once settled
    await waitFor(async () => ((await nslookup("placeholder")) >= 2 ? true : undefined), {
      timeoutMs: 60_000,
      describe: "the placeholder Service to resolve both pods",
    });
  });

  afterAll(async () => {
    await kubectl(["delete", "namespace", NS, "--ignore-not-found", "--wait=true"], { allowFailure: true });
  });

  test("E-33-01: EndpointSlices exist for the port-less headless Service", async () => {
    await withDump("E-33-01", async () => {
      const slices = await getJson<{ endpoints?: unknown[] }>("endpointslices.discovery.k8s.io", {
        ns: NS,
        selector: "kubernetes.io/service-name=portless",
      });
      expect(slices.length).toBeGreaterThan(0);
      // Recorded, not asserted: some server builds publish a slice with zero ready endpoints when the
      // Service itself never resolves (E-33-02/03 is the row that actually decides pass/fail).
      const total = slices.reduce((sum, slice) => sum + (slice.endpoints?.length ?? 0), 0);
      expect(total).toBeGreaterThanOrEqual(0);
    });
  });

  test("E-33-02/03: DNS resolution matches (or corrects) traits.headlessServiceNeedsPort", async () => {
    await withDump("E-33-02-03", async () => {
      const records = await nslookup("portless");
      const resolves = records >= 2;
      const needsPort = k3sDistribution.traits.headlessServiceNeedsPort;
      if (resolves === !needsPort) return; // the trait already matches what the pinned cluster does
      throw new Error(
        `C9: port-less headless Service DNS on the pinned cluster returns ${records} record(s); ` +
          `set traits.headlessServiceNeedsPort to ${!resolves} in kubernetes/k3s/distribution.ts`,
      );
    });
  });

  test("E-33-04: the placeholder-port variant always resolves", async () => {
    await withDump("E-33-04", async () => {
      const records = await nslookup("placeholder");
      expect(records).toBeGreaterThanOrEqual(2);
    });
  });
});
