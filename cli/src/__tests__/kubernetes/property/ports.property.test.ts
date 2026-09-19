// design-07 8.3 P-P01: structured port specs written as compose short or long syntax normalize
// back to the same PortSpec, and a range/published-count mismatch is refused (ports.range-mismatch).
// PortSpec is the normalizer's own output type, so this property runs `normalizeChecked` (P38's
// shared helper) rather than the translator; it is grouped with this package because it validates
// the model the translator rows above build on.

import { describe, expect } from 'bun:test';
import { normalizeChecked } from '../support/normalize';
import { forAll } from '../support/property';
import { portSpec, type PortSpecSample } from '../support/gen';

describe('ports (design-07 8.3)', () => {
  forAll<PortSpecSample & { useLong: boolean }>(
    'P-P01 structured -> string -> normalize -> the same PortSpec',
    (rng, size) => ({ ...portSpec(rng, size), useLong: rng() < 0.5 }),
    (sample) => {
      const entry = sample.useLong ? sample.long : sample.short;
      const { stack, diagnostics } = normalizeChecked({ compose: { image: 'nginx:1.27', ports: [entry] } });
      const errors = diagnostics.filter((d) => d.severity === 'error');
      if (errors.length > 0) throw new Error(`unexpected normalizer error: ${errors.map((e) => e.message).join('; ')}`);
      const port = stack.services[0]?.ports[0];
      if (port === undefined) throw new Error('no PortSpec was produced');
      const { path: _path, ...actual } = port;
      expect(actual).toEqual({
        target: sample.target,
        published: sample.published,
        protocol: sample.protocol,
        mode: 'ingress',
        hostIp: null,
        name: null,
        appProtocol: null,
      });
    },
  );

  forAll(
    'P-P01 a range whose target and published counts differ is refused (ports.range-mismatch)',
    (rng) => {
      const start = 8000 + Math.floor(rng() * 100);
      const targetCount = 2 + Math.floor(rng() * 3);
      const publishedCount = targetCount + 1 + Math.floor(rng() * 3);
      return `${start}-${start + publishedCount - 1}:${start + 1000}-${start + 1000 + targetCount - 1}`;
    },
    (entry) => {
      const { diagnostics } = normalizeChecked({ compose: { image: 'nginx:1.27', ports: [entry] } });
      const errors = diagnostics.filter((d) => d.severity === 'error');
      if (!errors.some((e) => e.code === 'ports.range-mismatch')) {
        throw new Error(`expected ports.range-mismatch, got ${JSON.stringify(diagnostics)}`);
      }
    },
  );
});
