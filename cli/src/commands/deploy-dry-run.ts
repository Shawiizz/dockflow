/**
 * `deploy --dry-run` display (design-03 3.6): after resolveSetup's real config/plugin resolution,
 * before any lock or remote mutation. It DOES connect — a control-plane probe and, best effort, a
 * live Helm/proxy plan — but that is read-only (core K68); `dockflow validate <env>` is the offline
 * check (validate.ts).
 */

import { colors, printWarning, printDim, printDebug, printBlank, printRaw, printSuccess, printError } from '../utils/output';
import type { HooksConfig, HookPhase } from '../utils/config';
import { HOOK_PHASES } from '../utils/config';
import { resolvePhaseEntries } from '../services/hook';
import { ComposeTranslationError } from '../utils/errors';
import { emitManifests, parseManifests } from '../services/orchestrator/kubernetes/yaml';
import type { ManifestObject } from '../services/orchestrator/kubernetes/resources/registry';
import type { HelmPlanEntry, ProxyPlan, StackArtifact, StackDeployInput } from '../services/orchestrator/interfaces';
import type { DeployContext } from './deploy-context';
import { buildAccessoriesInput, buildStackInput, composeForDeploy, declaredHelmNames, printArtifactDiagnostics, resolveImageDelivery } from './deploy-phases';

// ---------------------------------------------------------------------------
// --render: manifests with Secret.data values masked (design-03 3.6 point 3)
// ---------------------------------------------------------------------------

export function maskArtifactSecrets(artifact: StackArtifact, ctx: DeployContext): string {
  const objects = parseManifests(artifact.content);
  const masked: ManifestObject[] = objects.map((obj) => {
    if (obj.kind !== 'Secret' || !obj.data) return obj;
    return { ...obj, data: Object.fromEntries(Object.keys(obj.data).map((k) => [k, '***'])) };
  });
  return emitManifests(masked, { format: artifact.format, stackName: ctx.stackName, role: artifact.role, version: ctx.deployVersion });
}

// ---------------------------------------------------------------------------
// Render summary (point 2): object counts per kind, workloads, Helm releases, image delivery
// ---------------------------------------------------------------------------

function replicasOf(obj: ManifestObject): string {
  switch (obj.kind) {
    case 'Deployment':
    case 'StatefulSet':
      return String(obj.spec.replicas ?? 1);
    case 'DaemonSet':
      return 'one per matching node';
    case 'Job':
      return String(obj.spec.completions ?? 1);
    default:
      return '-';
  }
}

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job']);

function printRoleSummary(label: string, namespace: string, artifact: StackArtifact): void {
  const objects = parseManifests(artifact.content);
  printRaw(colors.info(colors.bold(`${label} (namespace ${namespace}, role ${artifact.role}):`)));
  printDim('─'.repeat(40));

  const counts = new Map<string, number>();
  for (const obj of objects) counts.set(obj.kind, (counts.get(obj.kind) ?? 0) + 1);
  const countLine = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([kind, n]) => `${kind}: ${n}`).join(', ');
  printRaw(`  Objects: ${countLine || 'none'}`);

  for (const obj of objects) {
    if (!WORKLOAD_KINDS.has(obj.kind)) continue;
    printRaw(`  ${obj.kind.padEnd(11)} ${obj.metadata.name} — replicas: ${replicasOf(obj)}`);
  }

  for (const release of artifact.helm) {
    printRaw(`  Helm ${release.name}: chart ${release.chart.kind === 'oci' ? release.chart.ref : `${release.chart.chart}#${release.chart.repo}`} ${release.version} in ${release.namespace} (values ${release.valuesSha256.slice(0, 12)})`);
  }

  printArtifactDiagnostics(label, artifact);
  printBlank();
}

// ---------------------------------------------------------------------------
// Plugins, uploads and hooks — what the deploy would transfer and run
// ---------------------------------------------------------------------------

function printPluginsUploadsHooks(ctx: DeployContext, pluginSummary: string[]): void {
  if (pluginSummary.length > 0) {
    printRaw(colors.info(colors.bold('Plugins:')));
    printDim('─'.repeat(40));
    for (const line of pluginSummary) printRaw(`  ${line}`);
    printBlank();
  }

  const uploads = ctx.config.uploads ?? [];
  if (uploads.length > 0) {
    printRaw(colors.info(colors.bold('Uploads:')));
    printDim('─'.repeat(40));
    for (const upload of uploads) printRaw(`  ${upload.label ?? upload.src} -> ${upload.dest}`);
    printBlank();
  }

  const hookLines = HOOK_PHASES.flatMap((phase: HookPhase) =>
    resolvePhaseEntries(phase, ctx.config.hooks as HooksConfig | undefined).map((entry) => `  ${phase.padEnd(12)} ${entry.label}${entry.fatal ? colors.dim(' (fatal)') : ''}`),
  );
  if (ctx.config.hooks?.enabled !== false && hookLines.length > 0) {
    printRaw(colors.info(colors.bold('Hooks:')));
    printDim('─'.repeat(40));
    for (const line of hookLines) printRaw(line);
    printBlank();
  }
}

// ---------------------------------------------------------------------------
// Live plan (point 4): best effort, connects but never mutates (U-FLOW-07)
// ---------------------------------------------------------------------------

function printHelmPlan(role: string, entries: HelmPlanEntry[]): void {
  if (entries.length === 0) return;
  printRaw(`  Helm plan (${role}):`);
  for (const entry of entries) {
    printRaw(`    ${entry.release} (${entry.namespace}): ${entry.action} — ${entry.reason}`);
    if (entry.action === 'blocked' && entry.suggestion) printDim(`      ${entry.suggestion}`);
  }
}

function printProxyPlan(plan: ProxyPlan): void {
  printRaw(`  Proxy: ${plan.action} — ${plan.reason}`);
  for (const blocker of plan.blockers) printWarning(`    ${blocker.message}`);
}

async function printLivePlan(ctx: DeployContext, appInput: StackDeployInput, accInput: StackDeployInput | null): Promise<void> {
  printRaw(colors.info(colors.bold('Live plan:')));
  printDim('─'.repeat(40));

  const orch = ctx.orchestrator;
  let reachable: boolean;
  try {
    const probe = await orch.cluster.probe(ctx.target.controlPlane);
    reachable = probe.status === 'leader' || probe.status === 'ready';
  } catch {
    reachable = false;
  }
  if (!reachable) {
    printDim(`  Live plan skipped: ${ctx.target.controlPlane.name} did not answer`);
    printBlank();
    return;
  }

  try {
    if (orch.helm) {
      const stackId = orch.naming.scope({ project: ctx.config.project_name, env: ctx.env, role: 'app' });
      if (appInput.helm.length > 0) printHelmPlan('app', await orch.helm.plan(appInput.helm, stackId, { adopt: ctx.options.adopt }));
      if (accInput && accInput.helm.length > 0) printHelmPlan('accessory', await orch.helm.plan(accInput.helm, stackId));
    }
    if (ctx.config.proxy?.enabled) {
      printProxyPlan(await orch.proxy.plan(ctx.config.proxy, ctx.env, ctx.rendered));
    }
  } catch (error) {
    printDim(`  Live plan skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  printBlank();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function displayDeployDryRun(ctx: DeployContext, pluginSummary: string[]): Promise<void> {
  printWarning('═'.repeat(60));
  printRaw(colors.warning(colors.bold('  DRY-RUN MODE - No changes will be made')));
  printWarning('═'.repeat(60));
  printBlank();

  printRaw(colors.info(colors.bold('Deployment Summary:')));
  printDim('─'.repeat(40));
  printRaw(`  ${colors.bold('Environment:')}     ${ctx.env}`);
  printRaw(`  ${colors.bold('Version:')}         ${ctx.deployVersion}`);
  printRaw(`  ${colors.bold('Branch:')}          ${ctx.branchName}`);
  printRaw(`  ${colors.bold('Project Root:')}    ${ctx.projectRoot}`);
  printRaw(`  ${colors.bold('Orchestrator:')}    ${ctx.orchestrator.kind}`);
  printBlank();

  printRaw(colors.info(colors.bold('Target Servers:')));
  printDim('─'.repeat(40));
  printRaw(`  ${colors.bold('Control plane:')}   ${ctx.target.controlPlane.name} (${ctx.target.controlPlane.host})`);
  if (ctx.target.workers.length > 0) {
    printRaw(`  ${colors.bold('Workers:')}`);
    for (const w of ctx.target.workers) printRaw(`                    - ${w.name} (${w.host})`);
  } else {
    printRaw(`  ${colors.bold('Workers:')}         none (single-node cluster)`);
  }
  printBlank();

  printRaw(colors.info(colors.bold('Deployment Options:')));
  printDim('─'.repeat(40));
  printRaw(`  ${colors.bold('Deploy App:')}      ${ctx.deployApp}`);
  printRaw(`  ${colors.bold('Accessories:')}     ${ctx.skipAccessories ? 'skipped' : ctx.forceAccessories ? 'forced' : 'auto-detect'}`);
  printRaw(`  ${colors.bold('Skip Build:')}      ${ctx.options.skipBuild ?? false}`);
  printRaw(`  ${colors.bold('Force Deploy:')}    ${ctx.options.force ?? false}`);
  if (ctx.options.only) printRaw(`  ${colors.bold('Only:')}            ${ctx.options.only}`);
  if (ctx.options.adopt?.length) printRaw(`  ${colors.bold('Adopt:')}           ${ctx.options.adopt.join(', ')}`);
  printBlank();

  printPluginsUploadsHooks(ctx, pluginSummary);

  // 1. Render both roles; a ComposeTranslationError is printed and the command exits non-zero.
  const compose = await composeForDeploy(ctx);
  const delivery = resolveImageDelivery(ctx.config, compose);

  let appArtifact: StackArtifact;
  let appInput: StackDeployInput;
  let accInput: StackDeployInput | null;
  let accArtifact: StackArtifact | null = null;
  try {
    appInput = buildStackInput(ctx, 'app', compose, delivery);
    appArtifact = ctx.orchestrator.stack.render(appInput);
    accInput = buildAccessoriesInput(ctx, delivery);
    if (accInput) accArtifact = ctx.orchestrator.stack.render(accInput);
  } catch (error) {
    if (error instanceof ComposeTranslationError) {
      printError(error.message);
      if (error.suggestion) printDim(`  ${error.suggestion}`);
      process.exitCode = error.code;
      return;
    }
    throw error;
  }

  const namespace = ctx.orchestrator.naming.scope({ project: ctx.config.project_name, env: ctx.env, role: 'app' });
  printRoleSummary('docker-compose.yml', namespace, appArtifact);
  if (accInput && accArtifact) {
    const accNamespace = ctx.orchestrator.naming.scope({ project: ctx.config.project_name, env: ctx.env, role: 'accessory' });
    printRoleSummary('accessories.yml', accNamespace, accArtifact);
  }

  printRaw(colors.info(colors.bold('Image delivery:')));
  printDim('─'.repeat(40));
  printRaw(`  Mode: ${delivery.mode}${delivery.pullSecretName ? ` (pull secret ${delivery.pullSecretName})` : ''}`);
  const declaredApp = declaredHelmNames(ctx.config, 'app');
  if (declaredApp.length > 0) printRaw(`  App Helm releases declared: ${declaredApp.join(', ')}`);
  printBlank();

  if ((ctx.options as { render?: boolean }).render) {
    printRaw(colors.info(colors.bold('Rendered manifests (app):')));
    printRaw(maskArtifactSecrets(appArtifact, ctx));
    printBlank();
    if (accArtifact) {
      printRaw(colors.info(colors.bold('Rendered manifests (accessories):')));
      printRaw(maskArtifactSecrets(accArtifact, ctx));
      printBlank();
    }
  }

  // 4. Live plan — best effort, read-only, no lock (U-FLOW-07)
  await printLivePlan(ctx, appInput, accInput);

  printSuccess('Dry run complete — no changes were made.');
  printDebug('To execute this deployment, remove the --dry-run flag.');
}
