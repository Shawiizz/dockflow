// design-07 8.3 P-S01 (selectors: build -> parse -> matches the same label sets) and the "selectors"
// property the P50 spec asks for: the workload/Service selector never depends on anything but the
// stack namespace and the service name, so it stays byte-identical whatever else about the service
// changes (replicas, image, env, ports, mode...).

import { describe, expect } from 'bun:test';
import { selectorLabels, serviceSelector } from '../../../services/orchestrator/kubernetes/labels';
import { translateStack } from '../../../services/orchestrator/kubernetes/translate';
import * as builders from '../support/builders';
import { composeName } from '../support/gen';
import { randomInt, type Rng } from '../support/prng';
import { forAll } from '../support/property';

function parseSelectorString(selector: string): Record<string, string> {
  return Object.fromEntries(
    selector.split(',').map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
}

/** A safe compose-key-like name: composeName() edge cases are for the sanitizer property, not this one. */
function serviceName(rng: Rng): string {
  const s = composeName(rng, 20).replace(/[^a-zA-Z0-9]/g, '') || 'svc';
  return `s${s}`.toLowerCase().slice(0, 20);
}

describe('selectors (design-07 8.3)', () => {
  forAll(
    'P-S01 build -> parse -> the same label set (serviceSelector vs selectorLabels)',
    (rng) => ({ namespace: `dockflow-${serviceName(rng)}-${serviceName(rng)}`, service: serviceName(rng) }),
    ({ namespace, service }) => {
      const built = serviceSelector(namespace, service);
      expect(parseSelectorString(built)).toEqual(selectorLabels({ namespace }, service));
    },
  );
});

interface Pair {
  name: string;
  a: CanonicalServiceOverrides;
  b: CanonicalServiceOverrides;
}

function serviceVariant(rng: Rng, name: string): CanonicalServiceOverrides {
  const overrides: CanonicalServiceOverrides = { composeName: name };
  if (randomInt(rng, 0, 1) === 0) overrides.mode = 'global';
  else overrides.replicas = randomInt(rng, 0, 5);
  if (rng() < 0.5) overrides.environment = [{ name: 'V', value: `x${randomInt(rng, 0, 1000)}` }];
  if (rng() < 0.5) {
    overrides.ports = [
      {
        target: randomInt(rng, 1, 65535),
        published: rng() < 0.5 ? randomInt(rng, 1, 65535) : null,
        protocol: 'TCP',
        mode: 'ingress',
        hostIp: null,
        name: null,
        appProtocol: null,
        path: 'services.web.ports[0]',
      },
    ];
  }
  if (rng() < 0.3) overrides.image = { ref: `nginx:${randomInt(rng, 1, 30)}`, composeRef: `nginx:${randomInt(rng, 1, 30)}` };
  return overrides;
}

/** Every selector-bearing object named `name`: workload `spec.selector` (a LabelSelector) and Service `spec.selector` (a plain map). */
function selectorsOf(objects: ReturnType<typeof translateStack>['objects'], name: string): { workloads: unknown[]; services: unknown[] } {
  const workloads: unknown[] = [];
  const services: unknown[] = [];
  for (const object of objects) {
    if (object.metadata.name !== name) continue;
    if (object.kind === 'Deployment' || object.kind === 'StatefulSet' || object.kind === 'DaemonSet') workloads.push(object.spec.selector);
    else if (object.kind === 'Service') services.push(object.spec.selector);
  }
  return { workloads, services };
}

describe('selectors (design-07 8.3) - immutable across changes', () => {
  forAll<Pair>(
    'immutable selector labels: the workload selector and the ClusterIP Service selector never change with anything but the stack namespace and the service name',
    (rng) => {
      const name = serviceName(rng);
      return { name, a: serviceVariant(rng, name), b: serviceVariant(rng, name) };
    },
    ({ name, a, b }) => {
      const stackA = builders.canonicalStack({ services: [builders.canonicalService(a)] });
      const stackB = builders.canonicalStack({ services: [builders.canonicalService(b)] });
      const { objects: objectsA } = translateStack(stackA, builders.translateOptions());
      const { objects: objectsB } = translateStack(stackB, builders.translateOptions());

      const matchLabels = selectorLabels({ namespace: stackA.identity.namespace }, name);
      const a2 = selectorsOf(objectsA, name);
      const b2 = selectorsOf(objectsB, name);
      for (const selector of [...a2.workloads, ...b2.workloads]) expect(selector).toEqual({ matchLabels });
      for (const selector of [...a2.services, ...b2.services]) expect(selector).toEqual(matchLabels);
    },
  );
});

type CanonicalServiceOverrides = Parameters<typeof builders.canonicalService>[0];
