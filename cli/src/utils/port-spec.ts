/**
 * Port specs as config files write them: `443`, `51820/udp`, `8000-8010/tcp`.
 */

export type PortProtocol = 'tcp' | 'udp';

export interface PortRange {
  from: number;
  to: number;
  protocol: PortProtocol;
}

const PORT_SPEC = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/(tcp|udp))?$/i;

/** The range and protocol (TCP when unsaid) of a port spec; null when malformed or outside 1-65535 */
export function parsePortSpec(value: string | number): PortRange | null {
  const match = PORT_SPEC.exec(String(value).trim());
  if (!match) return null;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to > 65535 || from > to) return null;
  return { from, to, protocol: (match[3]?.toLowerCase() ?? 'tcp') as PortProtocol };
}
