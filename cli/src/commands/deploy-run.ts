/**
 * One run of `dockflow deploy` once its context is resolved and its lock held: the steps, what a
 * failure or Ctrl+C undoes, and what the run records at the end.
 */

import { getPerformer } from '../utils/config';
import { printWarning } from '../utils/output';
import { SIGINT_EXIT_CODE } from '../utils/interrupt';
import { sshShell } from '../utils/remote-shell';
import * as Compose from '../services/compose';
import { SwarmStack } from '../services/swarm/stack';
import { Release, releaseEpoch } from '../services/release';
import * as Notification from '../services/notification';
import type { DeployContext } from './deploy-context';
import {
  applyPublicPorts, buildAndDistribute, checkUploadPermissions, cleanupFailedImages, cleanupManager, commitUploads,
  composeWithImageTags, deployAccessories, deployApp, ensureExternalNetworks, failureOutcome, keepRunningImageTags,
  loginManagerToRegistry, recordHistory, releaseAccessoriesDigest, rolledBackError, rollbackUploads, runDeployHook,
  runHTTPHealthChecks, runPostRollbackHealthChecks, uploadFiles,
} from './deploy-phases';
import type { AppProgress, BuildResult, UploadRollbackPlan } from './deploy-phases';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DeployRun {
  private readonly app: AppProgress = { sent: false, swarmRolledBack: false };
  private readonly startTime = Date.now();
  private uploadPlan: UploadRollbackPlan | null = null;
  private previousSymlink: string | null = null;
  private buildResult: BuildResult | null = null;
  private releaseCreated = false;
  /** the stack deploy was sent: from then on Swarm may run the new version, whatever happens here */
  private applyStarted = false;
  private interrupted = false;

  constructor(private readonly ctx: DeployContext) {}

  /** Build, upload, release, deploy and check; throws at the first step that fails. */
  async steps(): Promise<void> {
    const { ctx } = this;
    let compose = composeWithImageTags(ctx);

    await checkUploadPermissions(ctx);

    this.buildResult = await buildAndDistribute(ctx, compose);

    await runDeployHook(ctx, 'pre-upload');

    this.uploadPlan = await uploadFiles(ctx);

    await runDeployHook(ctx, 'post-upload');

    await runDeployHook(ctx, 'pre-deploy');

    compose = await keepRunningImageTags(ctx, compose);

    await applyPublicPorts(ctx);

    await ensureExternalNetworks(ctx);

    await loginManagerToRegistry(ctx);

    // the whole stack, even under --only: a rollback restores every service
    const renderedStack = ctx.swarm.render({
      stackName: ctx.stackName, env: ctx.env, compose, proxy: ctx.config.proxy,
    });

    const now = new Date();
    const storedReleases = await ctx.releases.listReleases(ctx.stackName);
    const accessoriesDigest = ctx.deployApp ? await releaseAccessoriesDigest(ctx) : undefined;

    // settled, not Promise.all: when accessories fail first, the release write must still hand
    // back the symlink to restore, or cleanup deletes `current`
    const [releaseOutcome, accessoriesOutcome] = await Promise.allSettled([
      // `deploy --accessories` leaves the app and its release history alone
      !ctx.deployApp ? Promise.resolve({ previousSymlink: null }) : ctx.releases.createRelease(ctx.stackName, ctx.deployVersion, Compose.serialize(compose), renderedStack, {
        project_name: ctx.config.project_name, version: ctx.deployVersion, env: ctx.env,
        timestamp: now.toISOString(), epoch: releaseEpoch(now, storedReleases),
        performer: getPerformer(), branch: ctx.branchName,
        ...(accessoriesDigest && { accessories_digest: accessoriesDigest }),
      }),
      deployAccessories(ctx),
    ]);
    if (releaseOutcome.status === 'rejected') throw releaseOutcome.reason;
    this.previousSymlink = releaseOutcome.value.previousSymlink;
    this.releaseCreated = ctx.deployApp;
    if (accessoriesOutcome.status === 'rejected') throw accessoriesOutcome.reason;

    this.applyStarted = true;
    await deployApp(ctx, compose, this.app);

    await runHTTPHealthChecks(ctx);
    await runDeployHook(ctx, 'post-deploy');

    await Promise.all([
      // the deploy succeeded: housekeeping failures are reported, never a reason to roll back
      ctx.deployApp && ctx.releases.cleanupOldReleases(ctx.stackName, ctx.config, [...ctx.cluster.otherManagers, ...ctx.cluster.workers].map((node) => sshShell(node.connection))).catch((e) => printWarning(`Old releases cleanup failed: ${messageOf(e)}`)),
      commitUploads(this.uploadPlan).catch((e) => printWarning(`Upload commit failed: ${messageOf(e)}`)),
    ]);
  }

  /** Undoes what the failed steps changed; resolves to the error the deploy fails with. */
  async undo(err: unknown): Promise<unknown> {
    const { ctx, previousSymlink } = this;

    if (this.uploadPlan) {
      await rollbackUploads(this.uploadPlan).catch((e) => printWarning(`Upload rollback failed: ${messageOf(e)}`));
    }

    let rolledBackTo: string | null = null;
    const outcome = failureOutcome(this.app, ctx.config.health_checks?.on_failure, previousSymlink !== null);
    const needsManager = outcome === 'rollback' || (outcome === 'forget' && this.releaseCreated);
    const through = needsManager ? await cleanupManager(ctx.cluster) : ctx.cluster.manager;
    if (!through) {
      printWarning(`No manager answers: ${ctx.deployVersion} could not be cleaned up. Run \`dockflow status ${ctx.env}\` once the cluster is back.`);
    } else if (through !== ctx.cluster.manager) {
      printWarning(`${ctx.cluster.manager.name} no longer answers: cleaning up through ${through.name}`);
    }
    const lost = through !== null && through !== ctx.cluster.manager;
    const releases = lost ? new Release(through.connection) : ctx.releases;
    const swarm = lost ? new SwarmStack(through.connection) : ctx.swarm;

    if (through && outcome === 'rollback' && previousSymlink) {
      // rollback() handles its own cleanup — calling removeRelease first would delete the failed release before rollback can list it.
      try {
        const rollbackStartedAt = new Date();
        const imageNodes = Compose.usesRegistry(ctx.config)
          ? undefined
          : [ctx.cluster.manager, ...ctx.cluster.otherManagers, ...ctx.cluster.workers].map((node) => ({ name: node.name, shell: sshShell(node.connection) }));
        rolledBackTo = await releases.rollback(ctx.stackName, swarm, ctx.deployVersion, previousSymlink, { imageNodes });
        printWarning(`Rolled back to ${rolledBackTo}`);
        await runPostRollbackHealthChecks(through.connection, swarm, ctx.stackName, ctx.config.health_checks, rollbackStartedAt);
      }
      catch (e) {
        printWarning(
          `Rollback failed: ${messageOf(e)}\n` +
          `The cluster may be in an inconsistent state. Run 'dockflow status' to check what is running.`
        );
        await releases.removeRelease(ctx.stackName, ctx.deployVersion, previousSymlink).catch(() => {});
      }
    } else if (outcome === 'keep') {
      printWarning(`${ctx.deployVersion} reached Swarm and is what runs now: it stays the current release. Check it with \`dockflow status ${ctx.env}\`.`);
    } else if (through && this.releaseCreated) {
      // only a record this deploy wrote: before that, the version's directory may be the running release
      await releases.removeRelease(ctx.stackName, ctx.deployVersion, previousSymlink).catch(() => {});
    }

    // after the rollback: until then the failed tasks' containers hold the images
    if (this.buildResult && ctx.config.stack_management?.cleanup_on_failure !== false) {
      await cleanupFailedImages(this.buildResult, [ctx.cluster.manager, ...ctx.cluster.otherManagers, ...ctx.cluster.workers]).catch(() => {});
    }

    // runs last so it observes the settled state; runHook never lets an on-failure entry abort,
    // and the original error stays on top
    await runDeployHook(ctx, 'on-failure', {
      DOCKFLOW_ERROR: messageOf(err),
      DOCKFLOW_ROLLED_BACK_TO: rolledBackTo ?? '',
    }).catch((e) => printWarning(`on-failure hooks could not run: ${messageOf(e)}`));

    return rolledBackTo ? rolledBackError(err, rolledBackTo) : err;
  }

  /** Ctrl+C: undoes what can be undone, releases the lock and exits. */
  interrupt(): void {
    if (this.interrupted) return;
    this.interrupted = true;
    const { ctx } = this;
    printWarning(`\nDeploy interrupted — cleaning up before exit...`);
    (async () => {
      if (this.uploadPlan) await rollbackUploads(this.uploadPlan).catch(() => {});
      if (this.releaseCreated && !this.applyStarted) {
        await ctx.releases.removeRelease(ctx.stackName, ctx.deployVersion, this.previousSymlink).catch(() => {});
      } else if (this.applyStarted) {
        printWarning(`Version ${ctx.deployVersion} was sent to Swarm but its state is unknown; run dockflow status ${ctx.env}`);
      }
      await ctx.lock.release().catch(() => {});
    })().finally(() => process.exit(SIGINT_EXIT_CODE));
  }

  /** The audit, metrics and notification of the run, then the lock released, whatever happened. */
  async record(status: 'success' | 'failed', message: string): Promise<void> {
    const { ctx } = this;
    const durationMs = Date.now() - this.startTime;
    await recordHistory(ctx, status, durationMs, message);
    await Notification.notify(ctx.config.notifications?.webhooks, {
      project: ctx.config.project_name, env: ctx.env, version: ctx.deployVersion,
      branch: ctx.branchName, performer: getPerformer(), status, duration_ms: durationMs, message,
    });
    await ctx.lock.release().catch((e) => printWarning(`Lock release failed: ${messageOf(e)}`));
  }
}
