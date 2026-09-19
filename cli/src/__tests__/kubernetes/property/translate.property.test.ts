// design-07 8.3: translator-wide properties over `miniStack()` (design-07 8.2) — determinism,
// schema validity (or a genuine error, never a crash) and object-key uniqueness (design-02's
// "object-key uniqueness assertion", `assertUniqueObjectKeys` in translate/index.ts).

import { describe, expect } from 'bun:test';
import { translateStack } from '../../../services/orchestrator/kubernetes/translate';
import { emitManifests } from '../../../services/orchestrator/kubernetes/yaml';
import * as builders from '../support/builders';
import { miniStack } from '../support/gen';
import { deepShuffleKeys, mulberry32 } from '../support/prng';
import { forAll } from '../support/property';
import { translateChecked } from '../support/translate';

function objectKey(object: { kind: string; metadata: { name: string } }): string {
  return `${object.kind}/${object.metadata.name}`;
}

function header(stack: ReturnType<typeof builders.canonicalStack>) {
  return { format: 'k8s-manifests/1' as const, stackName: stack.identity.stackName, role: stack.role, version: stack.identity.version };
}

describe('translate (design-07 8.3)', () => {
  forAll(
    'P-T01 miniStack renders to a schema- and semantic-valid artifact, or reports >= 1 error; never a translator bug',
    miniStack,
    (stack) => {
      // translateChecked validates internally (schema + semantic) whenever the sink has no error,
      // and throws only on a real translator precondition violation (T6) — never expected here.
      const { diagnostics } = translateChecked(stack);
      const hasError = diagnostics.some((d) => d.severity === 'error');
      if (hasError) {
        expect(diagnostics.some((d) => d.severity === 'error' && d.code.length > 0)).toBe(true);
      }
    },
  );

  forAll(
    'P-T02 determinism: rendering twice, and with the model\'s keys deep-shuffled, yields byte-identical manifests',
    miniStack,
    (stack) => {
      const { objects: first } = translateStack(stack, builders.translateOptions());
      const { objects: second } = translateStack(stack, builders.translateOptions());
      const textFirst = emitManifests(first, header(stack));
      const textSecond = emitManifests(second, header(stack));
      expect(textSecond).toBe(textFirst);

      const shuffled = deepShuffleKeys(stack, mulberry32(0x5eed));
      const { objects: third } = translateStack(shuffled, builders.translateOptions());
      expect(emitManifests(third, header(stack))).toBe(textFirst);
    },
  );

  forAll('P-T key uniqueness: every rendered object has a distinct (kind, name)', miniStack, (stack) => {
    const { objects } = translateStack(stack, builders.translateOptions());
    const keys = objects.map(objectKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
