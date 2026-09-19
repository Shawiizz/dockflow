// Deploy identity of a k3s cluster (design-05 12, DESIGN-CORE C7, D18): the ServiceAccount, its
// non-expiring token Secret and the cluster-admin ClusterRoleBinding, the kubeconfig every server
// writes for the deploy user, and rotation. One identity per cluster (12.5), not per environment.

import { ensureDockflowDir } from '../provision';
import { K8S_DEPLOYER_CLUSTER_ROLE_BINDING, K8S_DEPLOYER_SERVICE_ACCOUNT, K8S_DEPLOYER_TOKEN_SECRET, K8S_KUBECONFIG_DIR, K8S_KUBECONFIG_PATH, K8S_SYSTEM_NAMESPACE, KUBE_KEYS } from '../../../services/orchestrator/kubernetes/constants';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { systemObjectLabels } from '../../../services/orchestrator/kubernetes/labels';
import type { ClusterRoleBinding, Secret, ServiceAccount } from '../../../services/orchestrator/kubernetes/resources/core';
import type { KubeExecutor } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { emitObject } from '../../../services/orchestrator/kubernetes/yaml';
import { DEPLOYER_TOKEN_TIMEOUT_S } from './constants';
import { fileMatches, type HostRunner, type HostUser, SetupStepError, writeFileAtomic } from './host-runner';
import type { SetupProblem } from './messages';

export const KUBECONFIG_DIR_MODE = 0o700;
export const KUBECONFIG_FILE_MODE = 0o600;
const TOKEN_POLL_MS = 1000;

export const identityMessages = {
  tokenNotPopulated: (env: string, timeoutS: number): SetupProblem => ({
    message: `The ${K8S_DEPLOYER_TOKEN_SECRET} Secret of ${env} did not populate within ${timeoutS}s`,
    suggestion: `Run \`k3s kubectl get secret -n ${K8S_SYSTEM_NAMESPACE} ${K8S_DEPLOYER_TOKEN_SECRET}\` to see whether the token controller ran.`,
  }),
} as const;

// ---------------------------------------------------------------------------
// Objects (12.1)
// ---------------------------------------------------------------------------

/** A fresh object on every call: callers may serialise or compare it, never share it. */
export function deployerServiceAccount(): ServiceAccount {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: K8S_DEPLOYER_SERVICE_ACCOUNT, namespace: K8S_SYSTEM_NAMESPACE, labels: systemObjectLabels() },
    // no `secrets` field: the legacy-token cleaner only ever considers Secrets listed there (F37)
    automountServiceAccountToken: false,
  };
}

export function deployerTokenSecret(): Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: K8S_DEPLOYER_TOKEN_SECRET,
      namespace: K8S_SYSTEM_NAMESPACE,
      labels: systemObjectLabels(),
      annotations: { [KUBE_KEYS.serviceAccountName]: K8S_DEPLOYER_SERVICE_ACCOUNT },
    },
    type: 'kubernetes.io/service-account-token',
  };
}

export function deployerClusterRoleBinding(): ClusterRoleBinding {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: K8S_DEPLOYER_CLUSTER_ROLE_BINDING, labels: systemObjectLabels() },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
    subjects: [{ kind: 'ServiceAccount', name: K8S_DEPLOYER_SERVICE_ACCOUNT, namespace: K8S_SYSTEM_NAMESPACE }],
  };
}

/** The three objects of 12.1, in the document order of the design text. */
export function identityManifest(): string {
  const objects: readonly object[] = [deployerServiceAccount(), deployerTokenSecret(), deployerClusterRoleBinding()];
  return objects.map((object) => `---\n${emitObject(object)}`).join('');
}

/** `apply --server-side --field-manager=dockflow --force-conflicts` of the three objects. */
export async function applyIdentityObjects(kube: KubeExecutor): Promise<void> {
  await kube.apply(identityManifest(), { dryRun: false });
}

// ---------------------------------------------------------------------------
// Deployer token (12.1)
// ---------------------------------------------------------------------------

/** Polls the token Secret until `data.token` is populated (1 s, `DEPLOYER_TOKEN_TIMEOUT_S`). */
export async function waitForDeployerToken(
  kube: KubeExecutor,
  clock: Clock,
  options: { env: string; timeoutS?: number } = { env: '' },
): Promise<string> {
  const timeoutS = options.timeoutS ?? DEPLOYER_TOKEN_TIMEOUT_S;
  const deadline = clock.now().getTime() + timeoutS * 1000;
  for (;;) {
    const secrets = await kube.getJson<Secret>(['secrets'], { namespace: K8S_SYSTEM_NAMESPACE, name: K8S_DEPLOYER_TOKEN_SECRET, allowNotFound: true });
    const token = secrets[0]?.data?.token;
    if (typeof token === 'string' && token !== '') return Buffer.from(token, 'base64').toString('utf8');
    if (clock.now().getTime() >= deadline) {
      const problem = identityMessages.tokenNotPopulated(options.env, timeoutS);
      throw new SetupStepError(problem.message, problem.suggestion);
    }
    await clock.sleep(TOKEN_POLL_MS);
  }
}

/** Deletes the token Secret (invalidating it) and waits for its replacement (12.4). */
export async function rotateDeployToken(kube: KubeExecutor, clock: Clock, options: { env: string }): Promise<string> {
  await kube.delete([`secret/${K8S_DEPLOYER_TOKEN_SECRET}`], { namespace: K8S_SYSTEM_NAMESPACE, wait: true, ignoreNotFound: true });
  await applyIdentityObjects(kube);
  return waitForDeployerToken(kube, clock, options);
}

// ---------------------------------------------------------------------------
// Kubeconfig (12.2)
// ---------------------------------------------------------------------------

/** The exact document of 12.2: the local API through the loopback address, the plain-text token. */
export function renderKubeconfig(caPem: string, token: string): string {
  const ca = Buffer.from(caPem, 'utf8').toString('base64');
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '  - name: dockflow',
    '    cluster:',
    '      server: https://127.0.0.1:6443',
    `      certificate-authority-data: ${ca}`,
    'users:',
    '  - name: dockflow-deployer',
    '    user:',
    `      token: ${token}`,
    'contexts:',
    '  - name: dockflow',
    '    context:',
    '      cluster: dockflow',
    '      user: dockflow-deployer',
    '      namespace: dockflow-system',
    'current-context: dockflow',
    '',
  ].join('\n');
}

/**
 * Writes `/var/lib/dockflow/kube/config` (12.2): the directory tree is ensured, an unchanged file
 * (content, mode and owner) is left alone, otherwise a temp file replaces it atomically.
 */
export async function writeKubeconfig(runner: HostRunner, user: HostUser, caPem: string, token: string): Promise<'written' | 'unchanged'> {
  await ensureDockflowDir(user.name, runner);
  const dirInfo = await runner.stat(K8S_KUBECONFIG_DIR);
  if (dirInfo?.type !== 'directory' || dirInfo.mode !== KUBECONFIG_DIR_MODE || dirInfo.uid !== user.uid || dirInfo.gid !== user.gid) {
    await runner.mkdir(K8S_KUBECONFIG_DIR, { mode: KUBECONFIG_DIR_MODE, uid: user.uid, gid: user.gid });
  }
  const content = renderKubeconfig(caPem, token);
  const options = { mode: KUBECONFIG_FILE_MODE, uid: user.uid, gid: user.gid };
  if (await fileMatches(runner, K8S_KUBECONFIG_PATH, content, options)) return 'unchanged';
  await writeFileAtomic(runner, K8S_KUBECONFIG_PATH, content, options);
  return 'written';
}
