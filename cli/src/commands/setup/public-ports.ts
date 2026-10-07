/**
 * Setup step: the filter of the internet traffic to published container ports (Swarm hosts).
 *
 * Runs as root on the host being set up, like the rest of provisioning (see provision.ts).
 * The filter itself is services/public-ports.sh, installed as PUBLIC_PORTS_BIN.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { printDim, printInfo, printSuccess, printWarning } from '../../utils/output';
import { commandExists } from './dependencies';
import { PUBLIC_PORTS_SCRIPT, currentPublicPorts } from '../../services/public-ports';
import {
  PUBLIC_PORTS_BIN,
  PUBLIC_PORTS_OFF_MARKER,
  PUBLIC_PORTS_STATE_DIR,
  PUBLIC_PORTS_UNIT,
  PUBLIC_PORTS_UNIT_PATH,
} from '../../constants';

/**
 * Loads the filter at boot, before Docker publishes anything, so that no published port is
 * reachable in between; and again whenever Docker restarts.
 */
export const PUBLIC_PORTS_UNIT_FILE = `[Unit]
Description=Dockflow: let the internet reach only the public ports among published container ports
Documentation=https://dockflow.shawiizz.dev/en/configuration/firewall
Wants=network-online.target
After=network-online.target
Before=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${PUBLIC_PORTS_BIN} apply

[Install]
WantedBy=docker.service
`;

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf-8', stdio: 'pipe' });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The ports published right now, by project; nothing without a running Docker */
function publishedNow(): Map<string, string[]> {
  if (!commandExists('docker')) return new Map();
  const ids = run('docker', ['service', 'ls', '-q']);
  const serviceIds = ids.ok ? ids.stdout.split('\n').map((id) => id.trim()).filter(Boolean) : [];
  const services = serviceIds.length > 0
    ? run('docker', [
        'service', 'inspect', '--format',
        '{{index .Spec.Labels "com.docker.stack.namespace"}}|{{range .Endpoint.Ports}}{{.PublishedPort}}/{{.Protocol}} {{end}}',
        ...serviceIds,
      ]).stdout
    : '';
  const containers = run('docker', ['container', 'ls', '--format', '{{.Label "com.docker.swarm.service.id"}}|{{.Ports}}']).stdout;
  return currentPublicPorts(services, containers);
}

/** Remove the filter and leave the marker that tells deploys the host is unfiltered on purpose. */
function removeFilter(): void {
  if (fs.existsSync(PUBLIC_PORTS_BIN)) run(PUBLIC_PORTS_BIN, ['off']);
  if (fs.existsSync(PUBLIC_PORTS_UNIT_PATH)) {
    if (commandExists('systemctl')) run('systemctl', ['disable', PUBLIC_PORTS_UNIT]);
    fs.rmSync(PUBLIC_PORTS_UNIT_PATH, { force: true });
    if (commandExists('systemctl')) run('systemctl', ['daemon-reload']);
  }
  fs.rmSync(PUBLIC_PORTS_BIN, { force: true });
  fs.rmSync(PUBLIC_PORTS_STATE_DIR, { recursive: true, force: true });
  fs.writeFileSync(
    PUBLIC_PORTS_OFF_MARKER,
    'Left by `dockflow setup --no-port-filter`: the internet reaches every port a container publishes.\n',
  );
  printDim('Every published container port stays open to the internet (--no-port-filter)');
}

/**
 * Install the filter, or remove it with --no-port-filter. On a host that never had it, the ports
 * published right now stay open, recorded under their project, until that project's next deploy
 * records its own: setting up the filter cuts no running service.
 */
export function configurePublicPorts(enabled: boolean): void {
  fs.mkdirSync('/etc/dockflow', { recursive: true, mode: 0o755 });
  if (!enabled) {
    removeFilter();
    return;
  }

  const firstInstall = !fs.existsSync(PUBLIC_PORTS_STATE_DIR);
  fs.mkdirSync('/usr/local/sbin', { recursive: true });
  fs.writeFileSync(PUBLIC_PORTS_BIN, PUBLIC_PORTS_SCRIPT);
  fs.chmodSync(PUBLIC_PORTS_BIN, 0o755);
  fs.mkdirSync(PUBLIC_PORTS_STATE_DIR, { recursive: true, mode: 0o755 });
  fs.rmSync(PUBLIC_PORTS_OFF_MARKER, { force: true });

  if (firstInstall) {
    const kept = publishedNow();
    for (const [project, specs] of kept) {
      fs.writeFileSync(`${PUBLIC_PORTS_STATE_DIR}/${project}`, `${specs.join('\n')}\n`);
    }
    if (kept.size > 0) {
      printInfo(
        `Ports published right now stay open, recorded by project in ${PUBLIC_PORTS_STATE_DIR} ` +
          `(the next deploy of a Dockflow project replaces its own): ` +
          [...kept].map(([project, specs]) => `${project} (${specs.join(', ')})`).join(', '),
      );
    }
  }

  if (commandExists('systemctl')) {
    fs.writeFileSync(PUBLIC_PORTS_UNIT_PATH, PUBLIC_PORTS_UNIT_FILE);
    run('systemctl', ['daemon-reload']);
    const enable = run('systemctl', ['enable', PUBLIC_PORTS_UNIT]);
    if (!enable.ok) printWarning(`Could not enable ${PUBLIC_PORTS_UNIT}: ${enable.stderr.trim()}`);
  } else {
    printWarning(`systemctl not found: run \`${PUBLIC_PORTS_BIN} apply\` at boot, before Docker starts`);
  }

  const apply = run(PUBLIC_PORTS_BIN, ['apply']);
  if (!apply.ok) {
    printWarning(
      `The filter of published ports is installed but not in place: ${apply.stderr.trim() || 'apply failed'}. ` +
        `It loads with Docker at the next boot, or run \`${PUBLIC_PORTS_BIN} apply\`.`,
    );
    return;
  }
  printSuccess('Published container ports: the internet reaches only those a project declares public');
}
