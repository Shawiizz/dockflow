import { describe, expect, it } from 'bun:test';
import { parseAllDocuments } from 'yaml';
import { composeToManifests } from '../services/k8s-manifest';
import { loadFromString, injectTraefikLabels } from '../services/compose';
import type { ProxyConfig } from '../utils/config';

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec: Record<string, unknown>;
}

function toManifests(yaml: string, proxy?: ProxyConfig, options?: { useRegistry?: boolean }): Manifest[] {
  const out = composeToManifests('demo', loadFromString(yaml), proxy, options);
  return parseAllDocuments(out).map(d => d.toJS() as Manifest);
}

function find(manifests: Manifest[], kind: string, name?: string): Manifest | undefined {
  return manifests.find(m => m.kind === kind && (!name || m.metadata.name === name));
}

describe('composeToManifests — namespace', () => {
  it('always emits a namespace dockflow-{stack} with managed-by labels', () => {
    const manifests = toManifests('services: {}\n');
    const ns = find(manifests, 'Namespace');
    expect(ns).toBeDefined();
    expect(ns!.metadata.name).toBe('dockflow-demo');
    expect(ns!.metadata.labels!['app.kubernetes.io/managed-by']).toBe('dockflow');
    expect(ns!.metadata.labels!['app.kubernetes.io/part-of']).toBe('demo');
  });
});

describe('composeToManifests — Deployment', () => {
  it('basic service becomes a Deployment with 1 replica and Never pull policy', () => {
    const manifests = toManifests('services:\n  web:\n    image: web:1.0\n');
    const dep = find(manifests, 'Deployment', 'web')!;
    expect(dep.metadata.namespace).toBe('dockflow-demo');
    expect(dep.spec.replicas).toBe(1);
    const container = getContainer(dep);
    expect(container.image).toBe('web:1.0');
    expect(container.imagePullPolicy).toBe('Never');
  });

  it('useRegistry switches pull policy to IfNotPresent', () => {
    const manifests = toManifests('services:\n  web:\n    image: web:1.0\n', undefined, { useRegistry: true });
    expect(getContainer(find(manifests, 'Deployment')!).imagePullPolicy).toBe('IfNotPresent');
  });

  it('deploy.replicas is honored', () => {
    const manifests = toManifests('services:\n  web:\n    image: w\n    deploy:\n      replicas: 4\n');
    expect(find(manifests, 'Deployment')!.spec.replicas).toBe(4);
  });

  it('environment object format becomes env array', () => {
    const manifests = toManifests('services:\n  web:\n    image: w\n    environment:\n      FOO: bar\n      NUM: 42\n');
    const env = getContainer(find(manifests, 'Deployment')!).env as Array<{ name: string; value: string }>;
    expect(env).toContainEqual({ name: 'FOO', value: 'bar' });
    expect(env).toContainEqual({ name: 'NUM', value: '42' }); // values stringified
  });

  it('environment array format KEY=value is split on first =', () => {
    const manifests = toManifests('services:\n  web:\n    image: w\n    environment:\n      - "URL=http://x?a=b"\n      - "EMPTY"\n');
    const env = getContainer(find(manifests, 'Deployment')!).env as Array<{ name: string; value: string }>;
    expect(env).toContainEqual({ name: 'URL', value: 'http://x?a=b' });
    expect(env).toContainEqual({ name: 'EMPTY', value: '' });
  });

  it('node.role == manager constraint becomes master nodeSelector', () => {
    const manifests = toManifests(`
services:
  web:
    image: w
    deploy:
      placement:
        constraints:
          - node.role == manager
`);
    const podSpec = getPodSpec(find(manifests, 'Deployment')!);
    expect(podSpec.nodeSelector).toEqual({ 'node-role.kubernetes.io/master': '' });
  });

  it('node.hostname constraint becomes kubernetes.io/hostname selector', () => {
    const manifests = toManifests(`
services:
  web:
    image: w
    deploy:
      placement:
        constraints:
          - node.hostname == node-1
`);
    const podSpec = getPodSpec(find(manifests, 'Deployment')!);
    expect(podSpec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'node-1' });
  });
});

describe('composeToManifests — volumes', () => {
  it('named volumes become PVCs with default 1Gi', () => {
    const manifests = toManifests('services: {}\nvolumes:\n  data: {}\n');
    const pvc = find(manifests, 'PersistentVolumeClaim', 'data')!;
    expect(pvc.spec.accessModes).toEqual(['ReadWriteOnce']);
    expect((pvc.spec.resources as Record<string, Record<string, string>>).requests.storage).toBe('1Gi');
  });

  it('x-dockflow.size overrides PVC size', () => {
    const manifests = toManifests('services: {}\nvolumes:\n  data:\n    x-dockflow:\n      size: 5Gi\n');
    const pvc = find(manifests, 'PersistentVolumeClaim', 'data')!;
    expect((pvc.spec.resources as Record<string, Record<string, string>>).requests.storage).toBe('5Gi');
  });

  it('named volume mount references PVC, bind mount becomes hostPath', () => {
    const manifests = toManifests(`
services:
  web:
    image: w
    volumes:
      - data:/var/lib/data
      - /host/config:/etc/config
volumes:
  data: {}
`);
    const podSpec = getPodSpec(find(manifests, 'Deployment')!);
    const vols = podSpec.volumes as Array<Record<string, unknown>>;
    expect(vols).toContainEqual({ name: 'data', persistentVolumeClaim: { claimName: 'data' } });
    const hostVol = vols.find(v => v.hostPath);
    expect((hostVol!.hostPath as Record<string, string>).path).toBe('/host/config');
    expect((hostVol!.hostPath as Record<string, string>).type).toBe('DirectoryOrCreate');
  });
});

describe('composeToManifests — Service', () => {
  it('service with ports gets a ClusterIP Service on container ports', () => {
    const manifests = toManifests('services:\n  web:\n    image: w\n    ports:\n      - "8080:80"\n');
    const svc = find(manifests, 'Service', 'web')!;
    const ports = svc.spec.ports as Array<Record<string, unknown>>;
    expect(ports[0].port).toBe(80);
    expect(ports[0].targetPort).toBe(80);
    expect(ports[0].protocol).toBe('TCP');
  });

  it('udp protocol is uppercased', () => {
    const manifests = toManifests('services:\n  dns:\n    image: d\n    ports:\n      - "53:53/udp"\n');
    const ports = find(manifests, 'Service')!.spec.ports as Array<Record<string, unknown>>;
    expect(ports[0].protocol).toBe('UDP');
  });

  it('service without ports gets no Service resource', () => {
    const manifests = toManifests('services:\n  worker:\n    image: w\n');
    expect(find(manifests, 'Service')).toBeUndefined();
  });

  it('long syntax port objects are supported', () => {
    const manifests = toManifests(`
services:
  web:
    image: w
    ports:
      - target: 3000
        published: 80
`);
    const ports = find(manifests, 'Service')!.spec.ports as Array<Record<string, unknown>>;
    expect(ports[0].port).toBe(3000);
  });
});

describe('composeToManifests — health checks', () => {
  it('CMD-SHELL healthcheck becomes exec probe with sh -c', () => {
    const manifests = toManifests(`
services:
  web:
    image: w
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost/"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 1m30s
`);
    const container = getContainer(find(manifests, 'Deployment')!);
    const live = container.livenessProbe as Record<string, unknown>;
    expect((live.exec as Record<string, unknown>).command).toEqual(['/bin/sh', '-c', 'curl -f http://localhost/']);
    expect(live.periodSeconds).toBe(30);
    expect(live.timeoutSeconds).toBe(5);
    expect(live.failureThreshold).toBe(3);
    expect(live.initialDelaySeconds).toBe(90); // 1m30s
  });

  it('CMD healthcheck keeps args verbatim', () => {
    const manifests = toManifests(`
services:
  web:
    image: w
    healthcheck:
      test: ["CMD", "wget", "-q", "localhost"]
`);
    const container = getContainer(find(manifests, 'Deployment')!);
    const live = container.livenessProbe as Record<string, unknown>;
    expect((live.exec as Record<string, unknown>).command).toEqual(['wget', '-q', 'localhost']);
  });

  it('NONE healthcheck produces no probes', () => {
    const manifests = toManifests('services:\n  web:\n    image: w\n    healthcheck:\n      test: ["NONE"]\n');
    const container = getContainer(find(manifests, 'Deployment')!);
    expect(container.livenessProbe).toBeUndefined();
    expect(container.readinessProbe).toBeUndefined();
  });

  it('readiness probe gets a default initial delay when none set', () => {
    const manifests = toManifests(`
services:
  web:
    image: w
    healthcheck:
      test: ["CMD", "true"]
`);
    const container = getContainer(find(manifests, 'Deployment')!);
    const readiness = container.readinessProbe as Record<string, unknown>;
    expect(readiness.initialDelaySeconds).toBe(5);
    const liveness = container.livenessProbe as Record<string, unknown>;
    expect(liveness.initialDelaySeconds).toBeUndefined();
  });
});

describe('composeToManifests — IngressRoute', () => {
  const traefikService = `
services:
  web:
    image: w
    ports:
      - "80"
    labels:
      - "traefik.http.routers.web.rule=Host(\`app.example.com\`)"
`;

  it('traefik rule label becomes an IngressRoute', () => {
    const manifests = toManifests(traefikService);
    const ingress = find(manifests, 'IngressRoute', 'web')!;
    expect(ingress.apiVersion).toBe('traefik.io/v1alpha1');
    const routes = ingress.spec.routes as Array<Record<string, unknown>>;
    expect(routes[0].match).toBe('Host(`app.example.com`)');
    expect(routes[0].services).toEqual([{ name: 'web', port: 80 }]);
    expect(ingress.spec.entryPoints).toEqual(['websecure']);
  });

  it('explicit loadbalancer port label wins over container port', () => {
    const manifests = toManifests(`
services:
  web:
    image: w
    ports:
      - "80"
    labels:
      traefik.http.routers.web.rule: Host(\`x.io\`)
      traefik.http.services.web.loadbalancer.server.port: "3000"
`);
    const ingress = find(manifests, 'IngressRoute')!;
    const routes = ingress.spec.routes as Array<Record<string, unknown>>;
    expect(routes[0].services).toEqual([{ name: 'web', port: 3000 }]);
  });

  it('entrypoints label is split into entryPoints array', () => {
    const manifests = toManifests(`
services:
  web:
    image: w
    labels:
      traefik.http.routers.web.rule: Host(\`x.io\`)
      traefik.http.routers.web.entrypoints: "web, websecure"
`);
    expect(find(manifests, 'IngressRoute')!.spec.entryPoints).toEqual(['web', 'websecure']);
  });

  it('acme proxy config adds letsencrypt certResolver', () => {
    const manifests = toManifests(traefikService, { enabled: true, acme: true } as ProxyConfig);
    expect(find(manifests, 'IngressRoute')!.spec.tls).toEqual({ certResolver: 'letsencrypt' });
  });

  it('no rule label → no IngressRoute', () => {
    const manifests = toManifests('services:\n  web:\n    image: w\n    ports:\n      - "80"\n');
    expect(find(manifests, 'IngressRoute')).toBeUndefined();
  });

  it('Swarm-style deploy.labels also produce an IngressRoute', () => {
    // injectTraefikLabels (used by the k3s backend) writes labels under
    // deploy.labels — the manifest generator must read them from there too.
    const manifests = toManifests(`
services:
  web:
    image: w
    ports:
      - "80"
    deploy:
      labels:
        - "traefik.http.routers.web.rule=Host(\`deploy.example.com\`)"
`);
    const ingress = find(manifests, 'IngressRoute', 'web')!;
    expect(ingress).toBeDefined();
    const routes = ingress.spec.routes as Array<Record<string, unknown>>;
    expect(routes[0].match).toBe('Host(`deploy.example.com`)');
  });

  it('full k3s proxy path: injectTraefikLabels then composeToManifests yields an IngressRoute', () => {
    // Mirrors K3sStackBackend.deploy: labels injected from proxy config,
    // then manifests generated from the same compose.
    const compose = loadFromString('services:\n  web:\n    image: w\n    ports:\n      - "8081:80"\n');
    const proxy = { enabled: true, acme: false, domains: { test: 'k3s.test.local' } } as ProxyConfig;
    injectTraefikLabels(compose, proxy, 'demo', 'test');

    const out = composeToManifests('demo', compose, proxy);
    const manifests = parseAllDocuments(out).map(d => d.toJS() as Manifest);
    const ingress = find(manifests, 'IngressRoute', 'web')!;
    expect(ingress).toBeDefined();
    const routes = ingress.spec.routes as Array<Record<string, unknown>>;
    expect(routes[0].match).toBe('Host(`k3s.test.local`)');
    expect(routes[0].services).toEqual([{ name: 'web', port: 80 }]);
    expect(ingress.spec.entryPoints).toEqual(['web']); // acme off
  });
});

function getContainer(deployment: Manifest): Record<string, unknown> {
  const template = (deployment.spec.template as Record<string, unknown>);
  const podSpec = template.spec as Record<string, unknown>;
  return (podSpec.containers as Array<Record<string, unknown>>)[0];
}

function getPodSpec(deployment: Manifest): Record<string, unknown> {
  const template = (deployment.spec.template as Record<string, unknown>);
  return template.spec as Record<string, unknown>;
}
