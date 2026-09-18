import { describe, expect, it } from 'bun:test';
import { formatPorts, formatReplicas } from '../../../services/orchestrator/format';
import type { PortInfo } from '../../../services/orchestrator/interfaces';

const port = (
  target: number,
  published: number | null,
  mode: PortInfo['mode'] = published === null ? 'cluster' : 'ingress',
  protocol: PortInfo['protocol'] = 'tcp',
): PortInfo => ({ target, published, protocol, mode });

describe('formatReplicas (U-FMT-01)', () => {
  it('prints running/desired', () => {
    expect(formatReplicas({ replicas: { running: 2, desired: 3 } })).toBe('2/3');
    expect(formatReplicas({ replicas: { running: 0, desired: 0 } })).toBe('0/0');
  });
});

describe('formatPorts (U-FMT-01)', () => {
  it('prints published and cluster ports', () => {
    expect(formatPorts([port(80, 8080), port(5432, null)])).toBe('*:8080->80/tcp, 5432/tcp');
  });

  it('prints host ports like ingress ports, and a cluster port without its published number', () => {
    expect(formatPorts([port(80, 8080, 'host'), port(53, 53, 'cluster', 'udp')])).toBe('*:8080->80/tcp, 53/udp');
  });

  it('prints nothing for no ports', () => {
    expect(formatPorts([])).toBe('');
  });

  it('keeps the input order', () => {
    expect(formatPorts([port(5432, null), port(80, 8080)])).toBe('5432/tcp, *:8080->80/tcp');
  });

  it('collapses consecutive published ports into the range Swarm prints', () => {
    expect(formatPorts([port(30000, 30000), port(30001, 30001), port(30002, 30002)])).toBe(
      '*:30000-30002->30000-30002/tcp',
    );
    expect(formatPorts([port(80, 8080), port(81, 8081), port(9000, 9000)])).toBe('*:8080-8081->80-81/tcp, *:9000->9000/tcp');
  });

  it('does not collapse across protocols, modes, gaps or unpublished ports', () => {
    expect(formatPorts([port(53, 53), port(54, 54, 'ingress', 'udp')])).toBe('*:53->53/tcp, *:54->54/udp');
    expect(formatPorts([port(80, 8080), port(81, 8081, 'host')])).toBe('*:8080->80/tcp, *:8081->81/tcp');
    expect(formatPorts([port(80, 8080), port(82, 8081)])).toBe('*:8080->80/tcp, *:8081->82/tcp');
    expect(formatPorts([port(80, null), port(81, null)])).toBe('80/tcp, 81/tcp');
  });
});
