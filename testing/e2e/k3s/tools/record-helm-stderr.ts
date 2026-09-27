/**
 * Recorder of the helm stderr samples of design-04 3.5.5 (fixtures/helm-stderr), run by
 * record-kubectl-fixtures.ts (`--scenario helm-stderr`). Each sample is what the helm Dockflow
 * installs prints for a call Dockflow makes (the Helm backend's argument builders, the chart
 * puller's pull, repo update and registry login, runtime/host.ts's call directories and chart
 * cache), run by bash on server-1 as the deploy user, once its condition holds: a release another
 * operation holds, a hook or a template that fails, objects another owner holds, a missing chart,
 * wrong credentials, an unreachable repository, an admission webhook, a cluster that is down or
 * refuses the deploy identity. The OCI cases use a TLS registry this recorder starts, and server-1
 * trusts its CA until it is removed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FIXTURE_PROJECT, FIXTURES_ROOT } from "../../../../cli/src/__tests__/kubernetes/support/kubectl-fixtures";
import { helmHistoryMaxFor } from "../../../../cli/src/commands/helm/utils";
import type { ResolvedHelmRelease, StackRole } from "../../../../cli/src/services/orchestrator/interfaces";
import { helmRollbackArgs, helmUninstallArgs, helmUpgradeArgs } from "../../../../cli/src/services/orchestrator/kubernetes/backends/helm";
import { HELM_TMP_DIR, K8S_KUBECONFIG_PATH } from "../../../../cli/src/services/orchestrator/kubernetes/constants";
import { helmValuesStdin } from "../../../../cli/src/services/orchestrator/kubernetes/helm/values-yaml";
import { CHART_REPO_ALIAS, chartCachePath, ociRegistryHost, repositoriesFile } from "../../../../cli/src/services/orchestrator/kubernetes/runtime/chart-archive";
import { HELM_LIST_EVERY_STATUS, type HelmEnvOverrides, helmCommand, helmStderr } from "../../../../cli/src/services/orchestrator/kubernetes/runtime/helm";
import { classifyHelmFailure } from "../../../../cli/src/services/orchestrator/kubernetes/runtime/helm-errors";
import {
  fileSha256Command,
  helmTempDirCommand,
  installFileCommand,
  parseSha256,
  parseTempDir,
  removeTempDirCommand,
  writeSecretFileCommand,
} from "../../../../cli/src/services/orchestrator/kubernetes/runtime/host";
import { namespaceObject } from "../../../../cli/src/services/orchestrator/kubernetes/translate/namespace";
import { HELM_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/versions";
import type { DockflowConfig } from "../../../../cli/src/utils/config";
import { canonicalJson, sha256Hex } from "../../../../cli/src/utils/hash";
import { shellQuote } from "../../../../cli/src/utils/ssh";
import { AUTH_DIR, exec, tryExec } from "../../helpers/cluster";
import { DEPLOY_USER } from "../../helpers/connection";
import { kubectl, waitFor } from "../../helpers/k8s";
import { auxContainer, chartRepoUrl, currentTopology, E2E_CHARTS_PASSWORD, E2E_CHARTS_USER, E2E_REGISTRY_PASSWORD, E2E_REGISTRY_USER } from "../../helpers/topology";
import { apply } from "./fixture-render";
import {
  deleteNamespace,
  HOLD_FINALIZER,
  type Nodes,
  NS,
  nodesOf,
  onNode,
  POLICY_NS,
  type Run,
  readOnNode,
  replaceField,
  Samples,
  startWebhook,
  withKubeconfig,
  withWebhook,
  writeSampleSet,
} from "./record-kubectl-stderr";

const HELM_STDERR_ROOT = join(FIXTURES_ROOT, "helm-stderr");
/** what a config.yml without stack_management gives */
const HISTORY_MAX = helmHistoryMaxFor({} as DockflowConfig);
const WEB = { message: "Hello from the shop" };
const OCI_CONTAINER = "dockflow-fixture-oci";
const OCI_OCTET = 40;
const OCI_PORT = 5000;
/** where server-1 trusts the CA of the recorder's OCI registry for the time of the recording */
const OCI_CA_TRUST = "/usr/local/share/ca-certificates/dockflow-fixture-oci.crt";
const OCI_PUSH_CONFIG = "/tmp/dockflow-fixture-oci-push.json";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** the chart puller's call for a repository without credentials */
function pullArgs(chart: string, repo: string, version: string, destination: string): string[] {
  return ["pull", chart, "--repo", repo, "--version", version, "--destination", destination];
}

interface ReleaseSpec {
  name: string;
  chart: "e2e-web" | "e2e-broken" | "e2e-pvc";
  values: Record<string, unknown>;
  namespace?: string;
  role?: StackRole;
  timeoutS?: number;
}

interface Target {
  release: ResolvedHelmRelease;
  archive: string;
}

/** helm on server-1 as Dockflow runs it: the deploy user, the env prefix and Dockflow's kubeconfig */
class ServerHelm {
  private readonly argsOf = new WeakMap<Run, readonly string[]>();
  private readonly archives = new Map<string, Promise<string>>();

  constructor(
    private readonly nodes: Nodes,
    private readonly publicRepo: string,
  ) {}

  async run(args: string[], options: { env?: HelmEnvOverrides; stdin?: string } = {}): Promise<Run> {
    const run = await onNode(this.nodes.server, helmCommand({ args, ...(options.env ? { env: options.env } : {}) }), {
      user: DEPLOY_USER,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });
    this.argsOf.set(run, args);
    return run;
  }

  /** the reason the executor's stderr gets: Helm's log lines dropped, a failed repo update's causes first */
  classify(run: Run): string {
    return classifyHelmFailure(run.exitCode, helmStderr(this.argsOf.get(run) ?? [], run));
  }

  private async shell(command: string, stdin?: string): Promise<Run> {
    const run = await onNode(this.nodes.server, command, { user: DEPLOY_USER, ...(stdin === undefined ? {} : { stdin }) });
    if (run.exitCode !== 0) throw new Error(`${command} failed on ${this.nodes.server} (exit ${run.exitCode}): ${run.stderr.trim()}`);
    return run;
  }

  async callDir(): Promise<string> {
    const dir = parseTempDir((await this.shell(helmTempDirCommand())).stdout);
    if (dir === null) throw new Error(`mktemp printed no call directory of ${HELM_TMP_DIR}`);
    return dir;
  }

  async writeSecretFile(path: string, content: string): Promise<void> {
    await this.shell(writeSecretFileCommand(path), content);
  }

  /** the chart of the public repository in Dockflow's chart cache, pulled once */
  archive(chart: string, version: string): Promise<string> {
    const key = `${chart}-${version}`;
    let archive = this.archives.get(key);
    if (!archive) {
      archive = this.pullToCache(chart, version);
      this.archives.set(key, archive);
    }
    return archive;
  }

  private async pullToCache(chart: string, version: string): Promise<string> {
    const dir = await this.callDir();
    try {
      const pulled = await this.run(pullArgs(chart, this.publicRepo, version, dir));
      if (pulled.exitCode !== 0) throw new Error(`Pulling ${chart} ${version} failed: ${pulled.stderr.trim()}`);
      const file = `${dir}/${chart}-${version}.tgz`;
      const sha256 = parseSha256(await onNode(this.nodes.server, fileSha256Command(file), { user: DEPLOY_USER }));
      if (sha256 === null) throw new Error(`The pull of ${chart} ${version} left no ${file}`);
      await this.shell(installFileCommand(file, chartCachePath(sha256)));
      return chartCachePath(sha256);
    } finally {
      await this.shell(removeTempDirCommand(dir));
    }
  }

  async target(spec: ReleaseSpec): Promise<Target> {
    const release: ResolvedHelmRelease = {
      name: spec.name,
      role: spec.role ?? "app",
      namespace: spec.namespace ?? NS,
      chart: { kind: "repo", repo: this.publicRepo, chart: spec.chart },
      version: "0.1.0",
      values: spec.values,
      valuesSha256: sha256Hex(canonicalJson(spec.values)),
      timeoutS: spec.timeoutS ?? 180,
      auth: null,
      declaredDigest: null,
    };
    return { release, archive: await this.archive(spec.chart, release.version) };
  }

  /** `extra` as the adoption's server dry run passes it */
  upgrade(target: Target, extra: string[] = []): Promise<Run> {
    const args = helmUpgradeArgs(target.release, target.archive, { historyMax: HISTORY_MAX, stackId: target.release.namespace }, extra);
    return this.run(args, { stdin: helmValuesStdin(target.release.values) });
  }

  async install(spec: ReleaseSpec): Promise<void> {
    const run = await this.upgrade(await this.target(spec));
    if (run.exitCode !== 0) throw new Error(`Installing release ${spec.name} failed: ${run.stderr.trim()}`);
  }

  rollback(namespace: string, name: string, revision: number, timeoutS: number): Promise<Run> {
    return this.run(helmRollbackArgs(namespace, name, revision, { timeoutS, historyMax: HISTORY_MAX }));
  }

  uninstall(namespace: string, name: string, timeoutS: number): Promise<Run> {
    return this.run(helmUninstallArgs(namespace, name, { timeoutS }));
  }

  async status(name: string): Promise<string | undefined> {
    const run = await this.run(["list", ...HELM_LIST_EVERY_STATUS, "-n", NS, "--filter", `^${name}$`, "-o", "json"]);
    return (JSON.parse(run.stdout || "[]") as { status: string }[])[0]?.status;
  }
}

/** a call whose outcome this recording cannot be sure of: a success is reported, not kept */
function keepFailure(samples: Samples, file: string, how: string, run: Run): void {
  if (run.exitCode === 0) log(`[stderr] ${file}: not kept, ${run.command} succeeded`);
  else samples.keep(file, how, run);
}

// ─── the OCI registry this recorder serves ────────────────────────

interface OciRegistry {
  /** `<address>:<port>` */
  host: string;
  stop(): Promise<void>;
}

async function startOciRegistry(nodes: Nodes, project: string, chartArchive: string): Promise<OciRegistry> {
  const address = `${nodes.net}.${OCI_OCTET}`;
  const host = `${address}:${OCI_PORT}`;
  const dir = mkdtempSync(join(tmpdir(), "dockflow-oci-"));
  const file = (name: string): string => join(dir, name);
  const stop = async (): Promise<void> => {
    await tryExec(["docker", "rm", "-f", OCI_CONTAINER]);
    await tryExec(["docker", "exec", nodes.server, "sh", "-c", `rm -f ${OCI_CA_TRUST} ${OCI_PUSH_CONFIG} && update-ca-certificates --fresh >/dev/null`]);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await exec(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file("ca-key.pem"), "-out", file("ca.pem"), "-days", "1", "-subj", "/CN=Dockflow fixture OCI CA"]);
    await exec(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", file("key.pem"), "-out", file("request.pem"), "-subj", "/CN=Dockflow fixture OCI registry"]);
    writeFileSync(file("server.ext"), `subjectAltName=IP:${address}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
    await exec(["openssl", "x509", "-req", "-in", file("request.pem"), "-CA", file("ca.pem"), "-CAkey", file("ca-key.pem"), "-CAcreateserial", "-days", "1", "-extfile", file("server.ext"), "-out", file("cert.pem")]);
    await exec(["chmod", "644", file("key.pem"), file("cert.pem")]);
    const image = (await exec(["docker", "inspect", "-f", "{{.Config.Image}}", auxContainer(project, "registry-auth")])).trim();
    await tryExec(["docker", "rm", "-f", OCI_CONTAINER]);
    await exec([
      "docker", "run", "-d", "--name", OCI_CONTAINER, "--network", `${project}_k3s`, "--ip", address,
      "-v", `${dir}:/certs:ro`, "-v", `${AUTH_DIR}:/auth:ro`,
      "-e", "REGISTRY_HTTP_TLS_CERTIFICATE=/certs/cert.pem", "-e", "REGISTRY_HTTP_TLS_KEY=/certs/key.pem",
      "-e", "REGISTRY_AUTH=htpasswd", "-e", "REGISTRY_AUTH_HTPASSWD_REALM=e2e", "-e", "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
      image,
    ]);
    await exec(["docker", "exec", "-i", nodes.server, "sh", "-c", `cat > ${OCI_CA_TRUST} && update-ca-certificates >/dev/null`], { input: readFileSync(file("ca.pem"), "utf8") });
    await waitFor(
      async () => {
        const probe = await tryExec(["docker", "exec", nodes.server, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", `https://${host}/v2/`]);
        return probe.stdout.trim() === "401" ? true : undefined;
      },
      { timeoutMs: 60_000, describe: `the OCI registry at ${host}` },
    );
    // the chart the pulls look for, pushed with the harness helm
    await exec(["docker", "exec", "-i", nodes.server, "/opt/e2e/bin/helm", "registry", "login", host, "--username", E2E_REGISTRY_USER, "--password-stdin", "--registry-config", OCI_PUSH_CONFIG], {
      input: E2E_REGISTRY_PASSWORD,
    });
    await exec(["docker", "exec", nodes.server, "/opt/e2e/bin/helm", "push", chartArchive, `oci://${host}/charts`, "--registry-config", OCI_PUSH_CONFIG]);
  } catch (error) {
    await stop();
    throw error;
  }
  return { host, stop };
}

// ─── recording ────────────────────────────────────────────────────

async function recordLookups(helm: ServerHelm, samples: Samples, publicRepo: string, privateRepo: string): Promise<void> {
  samples.keep("ReleaseNotFound/1.txt", "no release absent in the stack namespace (history)", await helm.run(["history", "absent", "-n", NS, "--max", "20", "-o", "json"]));
  samples.keep("ReleaseNotFound/2.txt", "no release absent in the stack namespace (deployed values)", await helm.run(["get", "values", "absent", "-n", NS, "-o", "json"]));
  samples.keep("ReleaseNotFound/3.txt", "no release absent in the stack namespace (rollback)", await helm.rollback(NS, "absent", 1, 180));

  const dir = await helm.callDir();
  samples.keep("ChartNotFound/1.txt", "the repository has no version 9.9.9 of the chart", await helm.run(pullArgs("e2e-web", publicRepo, "9.9.9", dir)));
  samples.keep("ChartNotFound/2.txt", "the repository has no chart of that name", await helm.run(pullArgs("e2e-search", publicRepo, "0.1.0", dir)));
  samples.keep("RepoAuth/1.txt", "the repository wants credentials and config.yml gives none", await helm.run(pullArgs("e2e-web", privateRepo, "0.1.0", dir)));
  const closed = publicRepo.replace(/:8080\//, ":9/");
  samples.keep("RepoUnreachable/1.txt", "nothing listens at the repository address", await helm.run(pullArgs("e2e-web", closed, "0.1.0", dir)));
  samples.keep("RepoUnreachable/2.txt", "the repository host name does not resolve", await helm.run(pullArgs("e2e-web", "https://charts.shop.invalid/stable", "0.1.0", dir)));

  // credentials go in a per-call repositories file: `repo update`, then the pull through its alias
  const signedIn = await helm.callDir();
  const env: HelmEnvOverrides = { repositoryConfig: `${signedIn}/repositories.yaml`, repositoryCache: `${signedIn}/cache` };
  await helm.writeSecretFile(`${signedIn}/repositories.yaml`, repositoriesFile(privateRepo, { username: E2E_CHARTS_USER, password: E2E_CHARTS_PASSWORD }));
  const updated = await helm.run(["repo", "update", CHART_REPO_ALIAS], { env });
  if (updated.exitCode !== 0) throw new Error(`repo update of ${privateRepo} failed: ${updated.stderr.trim()}`);
  samples.keep(
    "ChartNotFound/3.txt",
    "the repository with credentials has no version 9.9.9 of the chart",
    await helm.run(["pull", `${CHART_REPO_ALIAS}/e2e-web`, "--version", "9.9.9", "--destination", signedIn], { env }),
  );
  const refused = await helm.callDir();
  const refusedEnv: HelmEnvOverrides = { repositoryConfig: `${refused}/repositories.yaml`, repositoryCache: `${refused}/cache` };
  await helm.writeSecretFile(`${refused}/repositories.yaml`, repositoriesFile(privateRepo, { username: E2E_CHARTS_USER, password: "not-the-password" }));
  samples.keep("RepoAuth/2.txt", "the repository refuses the password", await helm.run(["repo", "update", CHART_REPO_ALIAS], { env: refusedEnv }), { withStdout: true });
}

async function recordCharts(helm: ServerHelm, samples: Samples): Promise<void> {
  samples.keep("RenderError/1.txt", "the values set hook to null, and a template reads hook.enabled", await helm.upgrade(await helm.target({ name: "web", chart: "e2e-web", values: { ...WEB, hook: null } })));
  samples.keep("RenderError/2.txt", "the values remove message, which the chart requires", await helm.upgrade(await helm.target({ name: "web", chart: "e2e-web", values: { message: null } })));
  samples.keep(
    "ValuesSchema/1.txt",
    "storage is a number where the values schema of the chart wants a string",
    await helm.upgrade(await helm.target({ name: "data", chart: "e2e-pvc", values: { storage: 5 }, role: "accessory" })),
  );

  // objects of the release that exist already: made by hand, then by another release
  const web = await helm.target({ name: "web", chart: "e2e-web", values: WEB });
  const configMap = (metadata: object): string => JSON.stringify({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "web-e2e-web", namespace: NS, ...metadata } });
  await kubectl(["apply", "-f", "-"], { stdin: configMap({}) });
  samples.keep("Ownership/1.txt", "ConfigMap web-e2e-web was created by hand before release web", await helm.upgrade(web));
  await kubectl(["apply", "-f", "-"], {
    stdin: configMap({ labels: { "app.kubernetes.io/managed-by": "Helm" }, annotations: { "meta.helm.sh/release-name": "search", "meta.helm.sh/release-namespace": NS } }),
  });
  samples.keep("Ownership/2.txt", "ConfigMap web-e2e-web belongs to release search", await helm.upgrade(web));
  await kubectl(["delete", "configmap", "web-e2e-web", "-n", NS, "--ignore-not-found"]);
}

async function recordOperations(helm: ServerHelm, samples: Samples): Promise<void> {
  // a first install that never becomes ready, still running while a second deploy tries
  const install = helm.upgrade(await helm.target({ name: "cache", chart: "e2e-broken", values: {}, timeoutS: 45 }));
  await waitFor(async () => ((await helm.status("cache")) === "pending-install" ? true : undefined), { timeoutMs: 60_000, describe: "release cache to be pending-install" });
  samples.keep("Pending/1.txt", "the first install of release cache is still waiting for its pods", await helm.upgrade(await helm.target({ name: "cache", chart: "e2e-web", values: WEB })));
  samples.keep("UninstalledOnFailure/1.txt", "the pods of the first install of release cache never start", await install);

  const failingHook = { ...WEB, hook: { enabled: true, command: "exit 1" } };
  samples.keep("UninstalledOnFailure/2.txt", "the post-install hook of release jobs fails", await helm.upgrade(await helm.target({ name: "jobs", chart: "e2e-web", values: failingHook })));
  await helm.install({ name: "worker", chart: "e2e-web", values: WEB });
  samples.keep("RolledBack/1.txt", "the post-upgrade hook of release worker fails", await helm.upgrade(await helm.target({ name: "worker", chart: "e2e-web", values: failingHook })));

  await helm.install({ name: "stuck", chart: "e2e-web", values: WEB });
  const held = ["configmap", "stuck-e2e-web", "-n", NS, "--type=merge", "-p"];
  await kubectl(["patch", ...held, JSON.stringify({ metadata: { finalizers: [HOLD_FINALIZER] } })]);
  try {
    keepFailure(samples, "Timeout/1.txt", "a finalizer keeps ConfigMap stuck-e2e-web, which the uninstall of release stuck waits for", await helm.uninstall(NS, "stuck", 15));
  } finally {
    await kubectl(["patch", ...held, '{"metadata":{"finalizers":null}}'], { allowFailure: true });
  }
}

/**
 * A webhook of the cluster refuses a rollback, or is not answering; an install it refuses is removed.
 * The server dry run of an adoption renders against the cluster but sends no object: no webhook sees it.
 */
async function recordAdmission(helm: ServerHelm, samples: Samples, nodes: Nodes): Promise<void> {
  await apply([namespaceObject({ project: FIXTURE_PROJECT, env: "staging" })]);
  // two revisions of web whose Deployments differ, so a rollback updates it
  await helm.install({ name: "web", chart: "e2e-web", values: { ...WEB, replicas: 1 }, namespace: POLICY_NS });
  await helm.install({ name: "web", chart: "e2e-web", values: { ...WEB, replicas: 2 }, namespace: POLICY_NS });
  const api = await helm.target({ name: "api", chart: "e2e-web", values: WEB, namespace: POLICY_NS, timeoutS: 60 });
  const webhook = await startWebhook(nodes.host);
  try {
    await withWebhook(webhook.url("/deny"), webhook.caBundle, 10, async () => {
      keepFailure(samples, "AdmissionDenied/1.txt", "an admission webhook denies the Deployment of release web (rollback to revision 1)", await helm.rollback(POLICY_NS, "web", 1, 60));
      samples.keep("UninstalledOnFailure/3.txt", "an admission webhook denies the Deployment of the first install of release api", await helm.upgrade(api));
    });
    await withWebhook(`https://${nodes.host}:9/deny`, webhook.caBundle, 10, async () => {
      keepFailure(samples, "AdmissionDenied/2.txt", "the admission webhook of the cluster does not answer (rollback of release web to revision 1)", await helm.rollback(POLICY_NS, "web", 1, 60));
    });
  } finally {
    webhook.stop();
  }
}

async function recordOci(helm: ServerHelm, samples: Samples, nodes: Nodes, project: string): Promise<void> {
  const registry = await startOciRegistry(nodes, project, await helm.archive("e2e-web", "0.1.0"));
  try {
    const ref = `oci://${registry.host}/charts/e2e-web`;
    const pull = async (version: string, env: HelmEnvOverrides = {}): Promise<Run> => helm.run(["pull", ref, "--version", version, "--destination", await helm.callDir()], { env });
    const login = async (password: string): Promise<{ run: Run; env: HelmEnvOverrides }> => {
      const env: HelmEnvOverrides = { registryConfig: `${await helm.callDir()}/registry.json` };
      const run = await helm.run(["registry", "login", ociRegistryHost(ref), "--username", E2E_REGISTRY_USER, "--password-stdin"], { env, stdin: password });
      return { run, env };
    };
    samples.keep("RepoAuth/3.txt", "the OCI registry refuses the password", (await login("not-the-password")).run);
    samples.keep("RepoAuth/4.txt", "the OCI registry wants credentials and config.yml gives none", await pull("0.1.0"));
    const signedIn = await login(E2E_REGISTRY_PASSWORD);
    if (signedIn.run.exitCode !== 0) throw new Error(`registry login to ${registry.host} failed: ${signedIn.run.stderr.trim()}`);
    samples.keep("ChartNotFound/4.txt", "the OCI registry has no tag 9.9.9 of the chart", await pull("9.9.9", signedIn.env));
    const closed = ref.replace(`:${OCI_PORT}/`, ":9/");
    samples.keep("RepoUnreachable/3.txt", "nothing listens at the OCI registry address", await helm.run(["pull", closed, "--version", "0.1.0", "--destination", await helm.callDir()]));
  } finally {
    await registry.stop();
  }
}

/** Helm checks that the cluster answers before anything else; the planning read of every deploy */
async function recordCluster(helm: ServerHelm, samples: Samples, nodes: Nodes): Promise<void> {
  const listArgs = ["list", ...HELM_LIST_EVERY_STATUS, "-n", NS, "-o", "json"];
  const list = (): Promise<Run> => helm.run(listArgs);
  // a network namespace of its own: nothing listens on its loopback, as when k3s is stopped
  const isolated = `unshare --net bash -c 'ip link set lo up && exec runuser -u ${DEPLOY_USER} -- bash -c "$0"' ${shellQuote(helmCommand({ args: listArgs }))}`;
  samples.keep("Unreachable/1.txt", "k3s is not running on server-1", await onNode(nodes.server, isolated));
  const kubeconfig = await readOnNode(nodes.server, K8S_KUBECONFIG_PATH);
  await withKubeconfig(nodes.server, replaceField(kubeconfig, "server", "https://192.0.2.1:6443"), async () => {
    samples.keep("Unreachable/2.txt", "the API server address does not answer at all", await list());
  });
  await withKubeconfig(nodes.server, replaceField(kubeconfig, "token", Buffer.from("not-a-valid-token").toString("base64")), async () => {
    samples.keep("Unauthorized/1.txt", "the token of the deploy identity is no longer valid", await list());
  });
  const otherCa = Buffer.from(await readOnNode(nodes.server, "/var/lib/rancher/k3s/server/tls/client-ca.crt")).toString("base64");
  await withKubeconfig(nodes.server, replaceField(kubeconfig, "certificate-authority-data", otherCa), async () => {
    samples.keep("CertificateMismatch/1.txt", "the kubeconfig trusts another certificate authority (cluster reinstalled)", await list());
  });
}

export async function recordHelmStderr(): Promise<void> {
  const topo = currentTopology();
  const nodes = nodesOf(topo);
  const publicRepo = chartRepoUrl(topo.net, "public");
  const helm = new ServerHelm(nodes, publicRepo);
  const version = (await helm.run(["version", "--template", "{{.Version}}"])).stdout.trim();
  if (version !== HELM_PIN.version) throw new Error(`The helm of Dockflow on server-1 is ${version || "missing"}, not ${HELM_PIN.version}: run dockflow setup on the lane first`);

  for (const ns of [NS, POLICY_NS]) await deleteNamespace(ns);
  await apply([namespaceObject({ project: FIXTURE_PROJECT, env: "production" })]);
  const samples = new Samples((run) => helm.classify(run));
  try {
    await recordLookups(helm, samples, publicRepo, chartRepoUrl(topo.net, "private"));
    await recordCharts(helm, samples);
    await recordOperations(helm, samples);
    await recordAdmission(helm, samples, nodes);
    await recordOci(helm, samples, nodes, topo.project);
    await recordCluster(helm, samples, nodes);
  } finally {
    for (const ns of [NS, POLICY_NS]) await deleteNamespace(ns);
    await onNode(nodes.server, `rm -rf ${HELM_TMP_DIR}/call.*`, { user: DEPLOY_USER });
  }
  writeSampleSet(HELM_STDERR_ROOT, samples.kept, topo, { helmVersion: version });
}
