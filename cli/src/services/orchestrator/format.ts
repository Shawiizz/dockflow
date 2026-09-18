/**
 * Display helpers for inspection results, so commands and API routes never split strings.
 */

import type { PortInfo, ServiceInfo } from './interfaces';

export function formatReplicas(info: Pick<ServiceInfo, 'replicas'>): string {
  return `${info.replicas.running}/${info.replicas.desired}`;
}

interface PortRun {
  /** [first, last]; null for a port that is not published (mode 'cluster') */
  published: [number, number] | null;
  target: [number, number];
  protocol: PortInfo['protocol'];
  mode: PortInfo['mode'];
}

const span = ([first, last]: [number, number]): string => (last > first ? `${first}-${last}` : `${first}`);

/**
 * `*:8080->80/tcp, 5432/tcp`, in input order. Adjacent published ports that are consecutive on both
 * sides collapse into one range (`*:30000-30002->30000-30002/tcp`), which is Swarm's `{{.Ports}}`
 * text, so Swarm data prints exactly as `docker stack services` did.
 */
export function formatPorts(ports: PortInfo[]): string {
  const runs: PortRun[] = [];
  for (const port of ports) {
    const published = port.mode === 'cluster' ? null : port.published;
    const last = runs.at(-1);
    if (
      last?.published &&
      published !== null &&
      last.mode === port.mode &&
      last.protocol === port.protocol &&
      published === last.published[1] + 1 &&
      port.target === last.target[1] + 1
    ) {
      last.published[1] = published;
      last.target[1] = port.target;
      continue;
    }
    runs.push({
      published: published === null ? null : [published, published],
      target: [port.target, port.target],
      protocol: port.protocol,
      mode: port.mode,
    });
  }
  return runs
    .map((run) =>
      run.published
        ? `*:${span(run.published)}->${span(run.target)}/${run.protocol}`
        : `${span(run.target)}/${run.protocol}`,
    )
    .join(', ');
}
