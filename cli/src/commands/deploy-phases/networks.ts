/**
 * Network phases: create the external overlay networks the stacks need, and record the project's
 * public ports on every node.
 */

import { printDim, printInfo, printWarning } from '../../utils/output';
import { sshExec, shellQuote } from '../../utils/ssh';
import { DeployError, ErrorCode } from '../../utils/errors';
import * as Compose from '../../services/compose';
import * as PublicPorts from '../../services/public-ports';
import type { DeployContext } from '../deploy-context';
import { accessoriesKey } from './accessories';

export async function ensureExternalNetworks(ctx: DeployContext): Promise<void> {
  const mainCompose = Compose.loadFromString(ctx.composeContent, 'docker-compose.yml');
  const networks = new Set(Compose.externalNetworksToCreate(mainCompose, ctx.stackName));

  const accessoriesContent = ctx.rendered.get(accessoriesKey());
  if (accessoriesContent) {
    for (const n of Compose.externalNetworksToCreate(Compose.loadFromString(accessoriesContent, 'accessories.yml'), ctx.stackName)) networks.add(n);
  }

  if (networks.size === 0) return;

  const listResult = await sshExec(ctx.cluster.manager.connection, `docker network ls --format '{{.Name}}'`);
  if (listResult.exitCode !== 0) throw new DeployError(
    `Failed to list Docker networks: ${listResult.stderr.trim() || `exit ${listResult.exitCode}`}`,
    ErrorCode.DEPLOY_FAILED,
  );
  const existing = new Set(listResult.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean));

  for (const name of networks) {
    if (existing.has(name)) continue;
    printDim(`Creating overlay network: ${name}`);
    const r = await sshExec(ctx.cluster.manager.connection, `docker network create --driver overlay --attachable ${shellQuote(name)}`);
    if (r.exitCode !== 0) throw new DeployError(
      `Failed to create overlay network '${name}': ${r.stderr.trim() || `exit ${r.exitCode}`}`,
      ErrorCode.DEPLOY_FAILED,
    );
  }
}

/**
 * Records the project's public ports on every node: dockflow-public-ports lets the internet reach
 * only those among the published ports, and every node answers on a published port in Swarm. A node
 * set up before the filter existed is reported; one set up with --no-port-filter is left as it is.
 */
export async function applyPublicPorts(ctx: DeployContext): Promise<void> {
  if (ctx.config.no_services) return;

  const rules = PublicPorts.publicPortRules(ctx.config);
  const nodes = [ctx.cluster.manager, ...ctx.cluster.otherManagers, ...ctx.cluster.workers];
  const outcomes = await Promise.allSettled(
    nodes.map((node) => sshExec(node.connection, PublicPorts.recordCommand(ctx.stackName, rules, node.connection.user))),
  );

  let filtered = 0;
  outcomes.forEach((outcome, i) => {
    const node = nodes[i].name;
    if (outcome.status === 'rejected') {
      const cause = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      printWarning(`${node}: could not record the public ports: ${cause}`);
      return;
    }
    const { exitCode, stdout, stderr } = outcome.value;
    if (exitCode === 3) {
      // recorded, but Docker does not send published ports through DOCKER-USER there
      printWarning(`${node}: ${stderr.trim()}`);
    } else if (exitCode !== 0) {
      printWarning(`${node}: could not record the public ports: ${(stderr || stdout).trim() || `exit ${exitCode}`}`);
    } else if (stdout.trim() === 'missing') {
      printWarning(
        `${node} does not filter published ports: the internet reaches every port a service publishes there. ` +
          'Run `dockflow setup` on it again to install the filter.',
      );
    } else if (stdout.trim() !== 'off') {
      filtered++;
      if (stderr.trim()) printDim(`${node}: ${stderr.trim()}`);
    }
  });
  if (filtered === 0) return;

  printInfo(`Public ports: ${rules.map(PublicPorts.describeRule).join(', ') || 'none'}`);
  const accessories = ctx.rendered.get(accessoriesKey());
  const published = [ctx.composeContent, accessories].flatMap((content) =>
    content ? PublicPorts.publishedPorts(Compose.loadFromString(content)) : [],
  );
  const closed = PublicPorts.closedPorts(published, rules);
  if (closed.length > 0) {
    printInfo(
      `Published but closed to the internet: ${closed.map(PublicPorts.describePublished).join(', ')} ` +
        '(firewall.public_ports opens a port)',
    );
  }
}
