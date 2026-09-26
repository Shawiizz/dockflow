/**
 * Lane k3s-proxy-helm, file 50 (design-07 17.5 E-50-01..16): the cluster-wide, Dockflow-managed
 * Traefik, driven end to end through one project's chain of deploys plus a second, non-owning
 * stack (K21).
 *
 * A handful of design-04 4.3 sub-checks this row set does not spell out byte for byte are adapted
 * rather than skipped (noted inline): dashboard auth credentials are not derivable from the harness,
 * so the dashboard check accepts either a served page or a basic-auth challenge; the literal
 * 2 640 s stale `pending-install` wait of design-04 4.4 is a test-machine-only scenario, so E-50-15
 * here waits only for the ordinary "operation in progress" refusal before recovering.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { runCLI, runCLIInBackground } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { curlFrom, deleteStackCompletely, getJson, helm, kubectl, nodeExec, nsFor, waitFor, waitWorkloadReady } from "../../../helpers/k8s";
import { auxAddress, currentTopology } from "../../../helpers/topology";
import { K8S_PROXY_RELEASE, K8S_SYSTEM_NAMESPACE, LABELS } from "../../../../../cli/src/services/orchestrator/kubernetes/constants";
import { TRAEFIK_CHART_PIN } from "../../../../../cli/src/services/orchestrator/kubernetes/versions";
import type { Deployment } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/apps";
import type { IngressRoute, IngressRouteRoute, Middleware } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/traefik";
import type { Container, PersistentVolumeClaim, Pod, Secret } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";

const FILE = "50-proxy.test.ts";
const ENV = "e2e";
const ENV2 = "e2e2";
const NS = nsFor("shop");
const NS2 = nsFor("shop-second", ENV2);
const DOMAIN = "k3s.e2e.test";

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

interface HelmListEntry {
  name: string;
  revision: number;
  status: string;
}

async function releaseEntry(name: string, ns = K8S_SYSTEM_NAMESPACE): Promise<HelmListEntry | undefined> {
  const raw = await helm(["list", "-n", ns, "-o", "json"]);
  return (JSON.parse(raw) as HelmListEntry[]).find((entry) => entry.name === name);
}

async function traefikDeployment(): Promise<Deployment | undefined> {
  const [deployment] = await getJson<Deployment>("deployments.apps", { ns: K8S_SYSTEM_NAMESPACE, name: K8S_PROXY_RELEASE });
  return deployment;
}

async function ingressRoutesOf(ns: string): Promise<IngressRoute[]> {
  return getJson<IngressRoute>("ingressroutes", { ns });
}

function configYml(body: string): string {
  return `project_name: "shop"\norchestrator: k3s\n\n${body}`;
}

/**
 * Full `docker-compose.yml` content, so E-50-10/11's patches never risk a second, colliding
 * `deploy:` key. Router labels go under the top-level `labels:` (not `deploy.labels`): design-01
 * 7.1 — Kubernetes reads `labels`, Swarm's Traefik provider reads `deploy.labels` only.
 */
function composeYml(portMapping: string, extraLabels: readonly string[] = []): string {
  const lines = [
    "services:",
    "  web:",
    "    image: proxy-e2e-app",
    "    build:",
    "      context: ../..",
    "      dockerfile: .dockflow/docker/Dockerfile.web",
    "    ports:",
    `      - "${portMapping}"`,
  ];
  if (extraLabels.length > 0) lines.push("    labels:", ...extraLabels.map((label) => `      ${label}`));
  lines.push(
    "    deploy:",
    "      replicas: 1",
    "      update_config:",
    "        parallelism: 1",
    "        delay: 2s",
    "        monitor: 2s",
    "      restart_policy:",
    "        condition: on-failure",
    "",
  );
  return lines.join("\n");
}

const BASE_PROXY_BLOCK = [
  "proxy:",
  "  enabled: true",
  '  email: "ops@example.com"',
  "  acme: false",
  "  domains:",
  `    e2e: "${DOMAIN}"`,
].join("\n");

describe("50-proxy", () => {
  let fixture: Fixture;

  afterAll(async () => {
    fixture?.cleanup();
    await deleteStackCompletely(NS);
    await deleteStackCompletely(NS2);
    await kubectl(["delete", "namespace", K8S_SYSTEM_NAMESPACE, "--ignore-not-found=true", "--wait=false"], { allowFailure: true });
  });

  test("E-50-01: deploy installs the cluster Traefik from the cached chart", async () => {
    await withDump("E-50-01", async () => {
      fixture = makeFixture("test-app-k3s-proxy", { cluster: "k3s" });
      fixture.write(".dockflow/config.yml", configYml(BASE_PROXY_BLOCK));
      const result = await runCLI(["deploy", ENV, "1.0.0", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(K8S_SYSTEM_NAMESPACE, "deployment", K8S_PROXY_RELEASE, 1);
      await waitWorkloadReady(NS, "deployment", "web", 1);

      const status = await helm(["status", K8S_PROXY_RELEASE, "-n", K8S_SYSTEM_NAMESPACE]);
      expect(status).toContain(`traefik-${TRAEFIK_CHART_PIN.version}`);
      expect(status).toContain("STATUS: deployed");

      const deployment = await traefikDeployment();
      const image = deployment?.spec.template.spec.containers.find((c: Container) => c.name === "traefik")?.image;
      expect(image).toBe(`docker.io/traefik:${TRAEFIK_CHART_PIN.appVersion}`);
    });
  }, 220_000);

  test("E-50-02: k3s's own bundled Traefik was never installed", async () => {
    await withDump("E-50-02", async () => {
      // matches setup/k3s/verify.ts's own 10.1 absence check: both the app and CRD HelmCharts.
      const charts = await getJson<{ metadata: { name: string } }>("helmcharts.helm.cattle.io", { ns: "kube-system" });
      expect(charts.some((c) => c.metadata.name === "traefik" || c.metadata.name === "traefik-crd")).toBe(false);
      const pods = await getJson<Pod>("pods", { ns: "kube-system" });
      expect(pods.some((pod) => pod.metadata.name.startsWith("traefik"))).toBe(false);
    });
  }, 30_000);

  test("E-50-03: the default route is an IngressRoute on `web`", async () => {
    await withDump("E-50-03", async () => {
      const routes = await ingressRoutesOf(NS);
      const route = routes.find((r) => r.spec.routes.some((rt: IngressRouteRoute) => rt.match.includes(`\`${DOMAIN}\``)));
      expect(route).toBeDefined();
      expect(route?.spec.entryPoints).toEqual(["web"]);
    });
  }, 30_000);

  test("E-50-04: the app answers on both nodes", async () => {
    await withDump("E-50-04", async () => {
      for (const node of ["server_1", "agent_1"] as const) {
        const response = await curlFrom(node, "http://127.0.0.1/", { host: DOMAIN });
        expect(response.code).toBe(200);
        expect(response.body).toContain("DOCKFLOW_E2E_PROXY_APP_DEPLOYED");
      }
    });
  }, 30_000);

  test("E-50-05: an identical redeploy leaves Traefik untouched", async () => {
    await withDump("E-50-05", async () => {
      const before = await traefikDeployment();
      const beforeEntry = await releaseEntry(K8S_PROXY_RELEASE);
      const [pod] = await getJson<Pod>("pods", { ns: K8S_SYSTEM_NAMESPACE, selector: `app.kubernetes.io/name=traefik` });

      const result = await runCLI(["deploy", ENV, "1.0.1", "--force"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(result.exitCode).toBe(0);

      const after = await traefikDeployment();
      const afterEntry = await releaseEntry(K8S_PROXY_RELEASE);
      const [podAfter] = await getJson<Pod>("pods", { ns: K8S_SYSTEM_NAMESPACE, selector: `app.kubernetes.io/name=traefik` });
      expect(afterEntry?.revision).toBe(beforeEntry?.revision);
      expect(after?.metadata.generation).toBe(before?.metadata.generation);
      expect(podAfter?.metadata.uid).toBe(pod?.metadata.uid);
    });
  }, 120_000);

  test("E-50-06: enabling the dashboard adds exactly one revision and a served route", async () => {
    await withDump("E-50-06", async () => {
      const beforeEntry = await releaseEntry(K8S_PROXY_RELEASE);
      fixture.write(
        ".dockflow/config.yml",
        configYml(`${BASE_PROXY_BLOCK}\n  dashboard:\n    enabled: true\n    domain: "dashboard.${DOMAIN}"\n`),
      );
      const result = await runCLI(["deploy", ENV, "1.0.2", "--force"], { cwd: fixture.dir, timeoutMs: 150_000 });
      expect(result.exitCode).toBe(0);
      const afterEntry = await releaseEntry(K8S_PROXY_RELEASE);
      expect(afterEntry?.revision).toBe((beforeEntry?.revision ?? 0) + 1);

      const response = await curlFrom("server_1", "http://127.0.0.1/", { host: `dashboard.${DOMAIN}` });
      // No harness credential exists for the owner-auth challenge: a served page or a 401 challenge
      // both prove the dashboard route exists and is live.
      expect([200, 401]).toContain(response.code);
    });
  }, 180_000);

  describe("E-50-07/07b: ACME against Pebble only", () => {
    const net = currentTopology().net;
    const acmeIp = auxAddress(net, "acme");

    async function pebbleRoot(): Promise<string> {
      await nodeExec("server_1", `curl -sk https://${acmeIp}:15000/roots/0 -o /tmp/e2e-pebble-root.pem`);
      return "/tmp/e2e-pebble-root.pem";
    }

    test("E-50-07: ACME on with Pebble issues and serves a real certificate", async () => {
      await withDump("E-50-07", async () => {
        fixture.write(
          ".dockflow/config.yml",
          configYml(
            [
              "proxy:",
              "  enabled: true",
              '  email: "ops@example.com"',
              "  acme: true",
              "  domains:",
              `    e2e: "${DOMAIN}"`,
              "  dashboard:",
              "    enabled: true",
              `    domain: "dashboard.${DOMAIN}"`,
              `  acme_ca_server: "https://${acmeIp}:14000/dir"`,
              '  acme_ca_bundle: ".dockflow/acme/pebble.minica.pem"',
            ].join("\n"),
          ),
        );
        const result = await runCLI(["deploy", ENV, "1.0.3", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
        expect(result.exitCode).toBe(0);

        const values = JSON.parse(await helm(["get", "values", K8S_PROXY_RELEASE, "-n", K8S_SYSTEM_NAMESPACE, "-o", "json"]));
        const dump = JSON.stringify(values);
        expect(dump).toContain("letsencrypt");
        expect(dump).toContain(`https://${acmeIp}:14000/dir`);
        expect(dump).toContain("LEGO_CA_CERTIFICATES");

        const secrets = await getJson<Secret>("secrets", { ns: K8S_SYSTEM_NAMESPACE });
        expect(secrets.some((s) => /^dockflow-traefik-acme-ca-[0-9a-f]{8}$/.test(s.metadata.name))).toBe(true);

        const [pvc] = await getJson<PersistentVolumeClaim>("persistentvolumeclaims", { ns: K8S_SYSTEM_NAMESPACE, name: K8S_PROXY_RELEASE });
        expect(pvc?.status?.phase).toBe("Bound");
        expect(pvc?.spec.storageClassName).toBe("dockflow-local");

        const deployment = await traefikDeployment();
        expect(deployment?.spec.strategy?.type).toBe("Recreate");

        const headers = await nodeExec("server_1", `curl -s -o /dev/null -D - -H 'Host: ${DOMAIN}' http://127.0.0.1/`);
        expect(headers.stdout).toMatch(/HTTP\/\S+ 30[18]/);
        expect(headers.stdout).toMatch(/[Ll]ocation:\s*https:\/\//);

        const routes = await ingressRoutesOf(NS);
        const secure = routes.find((r) => r.spec.entryPoints?.includes("websecure"));
        expect(secure?.spec.tls?.certResolver).toBeTruthy();

        const rootPath = await pebbleRoot();
        await waitFor(
          async () => {
            const check = await nodeExec("server_1", `curl -s --cacert ${rootPath} https://${DOMAIN}/ -o /tmp/e2e-body -w '%{http_code}'`);
            if (check.stdout.trim() !== "200") return undefined;
            const body = await nodeExec("server_1", "cat /tmp/e2e-body");
            return body.stdout.includes("DOCKFLOW_E2E_PROXY_APP_DEPLOYED") ? true : undefined;
          },
          { timeoutMs: 120_000, intervalMs: 3000, describe: `Pebble to issue a certificate for ${DOMAIN}` },
        );
      });
    }, 220_000);

    test("E-50-07b: a Traefik restart keeps the same certificate", async () => {
      await withDump("E-50-07b", async () => {
        const rootPath = await pebbleRoot();
        const before = await nodeExec(
          "server_1",
          `curl -s --cacert ${rootPath} https://${DOMAIN}/ -o /dev/null -w '%{certs}' 2>/dev/null; echo | openssl s_client -connect 127.0.0.1:443 -servername ${DOMAIN} 2>/dev/null | openssl x509 -noout -serial`,
        );
        await kubectl(["rollout", "restart", `deployment/${K8S_PROXY_RELEASE}`, "-n", K8S_SYSTEM_NAMESPACE]);
        await kubectl(["rollout", "status", `deployment/${K8S_PROXY_RELEASE}`, "-n", K8S_SYSTEM_NAMESPACE, "--timeout=120s"]);
        await waitFor(
          async () => {
            const check = await nodeExec("server_1", `curl -s --cacert ${rootPath} https://${DOMAIN}/ -o /dev/null -w '%{http_code}'`);
            return check.stdout.trim() === "200" ? true : undefined;
          },
          { timeoutMs: 60_000, describe: "Traefik to serve again after the restart" },
        );
        const after = await nodeExec(
          "server_1",
          `echo | openssl s_client -connect 127.0.0.1:443 -servername ${DOMAIN} 2>/dev/null | openssl x509 -noout -serial`,
        );
        expect(after.stdout.trim()).toBe(before.stdout.trim());
      });
    }, 150_000);
  });

  test("E-50-08: turning ACME back off removes the redirect", async () => {
    await withDump("E-50-08", async () => {
      fixture.write(".dockflow/config.yml", configYml(`${BASE_PROXY_BLOCK}\n  dashboard:\n    enabled: true\n    domain: "dashboard.${DOMAIN}"\n`));
      const result = await runCLI(["deploy", ENV, "1.0.4", "--force"], { cwd: fixture.dir, timeoutMs: 150_000 });
      expect(result.exitCode).toBe(0);
      const response = await curlFrom("server_1", "http://127.0.0.1/", { host: DOMAIN });
      expect(response.code).toBe(200);
      const routes = await ingressRoutesOf(NS);
      const route = routes.find((r) => r.spec.routes.some((rt: IngressRouteRoute) => rt.match.includes(`\`${DOMAIN}\``)));
      expect(route?.spec.entryPoints).toEqual(["web"]);
    });
  }, 180_000);

  test("E-50-09: a proxy-disabled project ignores its own Traefik labels", async () => {
    await withDump("E-50-09", async () => {
      const before = await releaseEntry(K8S_PROXY_RELEASE);
      const second = makeFixture("test-app-k3s-proxy/second-env", { cluster: "k3s", envs: [ENV2] });
      const result = await runCLI(["deploy", ENV2, "1.0.0", "--force"], { cwd: second.dir, timeoutMs: 150_000 });
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("routing.proxy-disabled");
      const routes = await ingressRoutesOf(NS2);
      expect(routes).toEqual([]);
      const after = await releaseEntry(K8S_PROXY_RELEASE);
      expect(after?.revision).toBe(before?.revision);
      second.cleanup();
    });
  }, 180_000);

  test("E-50-10: a host port conflict with Traefik is a validation error", async () => {
    await withDump("E-50-10", async () => {
      fixture.write(".dockflow/docker/docker-compose.yml", composeYml("80:80"));
      try {
        const result = await runCLI(["deploy", ENV, "1.0.5", "--force"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(result.exitCode).toBe(60);
      } finally {
        fixture.write(".dockflow/docker/docker-compose.yml", composeYml("8080:80"));
      }
    });
  }, 90_000);

  test("E-50-11: a stripprefix router label rewrites the path Traefik forwards", async () => {
    await withDump("E-50-11", async () => {
      fixture.write(
        ".dockflow/docker/docker-compose.yml",
        composeYml("8080:80", [
          'traefik.enable: "true"',
          `traefik.http.routers.web-strip.rule: "Host(\`${DOMAIN}\`) && PathPrefix(\`/api\`)"`,
          'traefik.http.routers.web-strip.middlewares: "webstrip"',
          'traefik.http.middlewares.webstrip.stripprefix.prefixes: "/api"',
        ]),
      );
      const result = await runCLI(["deploy", ENV, "1.0.6", "--force"], { cwd: fixture.dir, timeoutMs: 150_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web", 1);

      const middlewares = await getJson<Middleware>("middlewares", { ns: NS });
      expect(middlewares.some((m) => (m.spec.stripPrefix as { prefixes?: string[] } | undefined)?.prefixes?.includes("/api"))).toBe(true);

      const response = await curlFrom("server_1", "http://127.0.0.1/api/x", { host: DOMAIN });
      expect(response.code).toBe(200);
      await waitFor(
        async () => {
          const logs = await kubectl(["logs", "deployment/web", "-n", NS, "--tail=100"], { allowFailure: true });
          return logs.includes("GET /x ") ? true : undefined;
        },
        { timeoutMs: 20_000, describe: "nginx access log to show the stripped path" },
      );
    });
  }, 180_000);

  test("E-50-12/16: an accessory's own router works and default injection is skipped by role", async () => {
    await withDump("E-50-12", async () => {
      const before = await releaseEntry(K8S_PROXY_RELEASE);
      const result = await runCLI(["deploy", ENV, "1.0.7", "--all", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "admin", 1);

      const routes = await ingressRoutesOf(NS);
      const adminRoutes = routes.filter((r) => r.spec.routes.some((rt: IngressRouteRoute) => rt.match.includes(`\`admin.${DOMAIN}\``)));
      // exactly one route for the accessory: the explicit label router, never a second, auto-injected
      // default one (E-50-16: injection is skipped by role, not by a null ProxyIntent.domain).
      expect(adminRoutes.length).toBe(1);
      expect(adminRoutes[0]?.metadata.labels?.[LABELS.role]).toBe("accessory");

      const response = await curlFrom("server_1", "http://127.0.0.1/", { host: `admin.${DOMAIN}` });
      expect(response.code).toBe(200);
      expect(response.body).toContain("DOCKFLOW_E2E_PROXY_APP_DEPLOYED");

      const after = await releaseEntry(K8S_PROXY_RELEASE);
      expect(after?.revision).toBe(before?.revision);
    });
  }, 200_000);

  test("E-50-13: a second environment deploys without touching the managed Traefik", async () => {
    await withDump("E-50-13", async () => {
      const before = await releaseEntry(K8S_PROXY_RELEASE);
      const second = makeFixture("test-app-k3s-proxy/second-env", { cluster: "k3s", envs: [ENV2] });
      second.write(
        ".dockflow/config.yml",
        [
          'project_name: "shop-second"',
          'orchestrator: k3s',
          "",
          "proxy:",
          "  enabled: true",
          "  manage: false",
          "  acme: false",
          "  domains:",
          `    ${ENV2}: "staging.${DOMAIN}"`,
          "",
        ].join("\n"),
      );
      const result = await runCLI(["deploy", ENV2, "1.0.0", "--force"], { cwd: second.dir, timeoutMs: 150_000 });
      expect(result.exitCode).toBe(0);

      const response = await curlFrom("server_1", "http://127.0.0.1/", { host: `staging.${DOMAIN}` });
      expect(response.code).toBe(200);

      const after = await releaseEntry(K8S_PROXY_RELEASE);
      expect(after?.revision).toBe(before?.revision);
      const [pod] = await getJson<Pod>("pods", { ns: K8S_SYSTEM_NAMESPACE, selector: "app.kubernetes.io/name=traefik" });
      expect(pod).toBeDefined();
      second.cleanup();
    });
  }, 180_000);

  test("E-50-14: a capability the owner lacks is refused as incompatible, not as a conflict", async () => {
    await withDump("E-50-14", async () => {
      const second = makeFixture("test-app-k3s-proxy/second-env", { cluster: "k3s", envs: [ENV2] });
      second.write(
        ".dockflow/config.yml",
        [
          'project_name: "shop-second"',
          'orchestrator: k3s',
          "",
          "proxy:",
          "  enabled: true",
          "  manage: false",
          "  acme: true",
          '  email: "second@example.com"',
          "  domains:",
          `    ${ENV2}: "staging.${DOMAIN}"`,
          "",
        ].join("\n"),
      );
      const result = await runCLI(["deploy", ENV2, "1.0.0", "--force"], { cwd: second.dir, timeoutMs: 60_000 });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("E-PX-INCOMPATIBLE");
      expect(result.stderr).not.toContain("E-PX-CONFLICT");
      second.cleanup();
    });
  }, 90_000);

  describe("E-50-15: pending-install recovery", () => {
    test("an interrupted first install refuses a redeploy until recovered", async () => {
      await withDump("E-50-15", async () => {
        const uninstall = await runCLI(["helm", "uninstall", ENV, "--system", "--force", "--yes"], {
          cwd: fixture.dir,
          timeoutMs: 120_000,
        });
        expect(uninstall.exitCode).toBe(0);

        const background = runCLIInBackground(["deploy", ENV, "1.0.8", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
        // Long enough for the deploy pipeline to reach `helm upgrade --install` on Traefik and mark
        // the release pending-install, short enough to reliably interrupt it before it completes.
        await Bun.sleep(8000);
        background.kill();
        await background.done.catch(() => undefined);

        const refused = await runCLI(["deploy", ENV, "1.0.8", "--force"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain(`Traefik in ${K8S_SYSTEM_NAMESPACE}`);

        const recover = await runCLI(["helm", "uninstall", ENV, "--system", "--force", "--yes"], {
          cwd: fixture.dir,
          timeoutMs: 120_000,
        });
        expect(recover.exitCode).toBe(0);

        const redeploy = await runCLI(["deploy", ENV, "1.0.8", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
        expect(redeploy.exitCode).toBe(0);
        await waitWorkloadReady(K8S_SYSTEM_NAMESPACE, "deployment", K8S_PROXY_RELEASE, 1);
      });
    }, 300_000);
  });

  afterAll(async () => {
    await nodeExec("server_1", "rm -f /tmp/e2e-pebble-root.pem /tmp/e2e-body", { user: "root" });
  });
});
