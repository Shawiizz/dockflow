// design-03 6.2 and 6.3 (22.2 `apply/closure.test.ts`), design-07 U-CLOSURE-01..05: the dependency
// closure of compose services, including the Middleware targets of K46.

import { describe, expect, it } from 'bun:test';
import { closeOver, closure } from '../../../services/orchestrator/kubernetes/apply/closure';
import type { Deployment, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { ConfigMap, PersistentVolumeClaim, PodSpec, Secret, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import type { IngressRoute, Middleware, MiddlewareCrdSpec } from '../../../services/orchestrator/kubernetes/resources/traefik';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';

function annotated(name: string, service?: string) {
  return { name, namespace: NS, annotations: service === undefined ? undefined : { [`${P}/compose-service`]: service } };
}

function deployment(name: string, spec: Partial<PodSpec> = {}): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: annotated(name, name),
    spec: { selector: {}, template: { metadata: {}, spec: { containers: [{ name, image: `registry.example.com/${name}:1` }], ...spec } } },
  };
}

function service(name: string, composeName: string): Service {
  return { apiVersion: 'v1', kind: 'Service', metadata: annotated(name, composeName), spec: { ports: [{ port: 80, protocol: 'TCP' }] } };
}

function secret(name: string): Secret {
  return { apiVersion: 'v1', kind: 'Secret', metadata: annotated(name), data: {} };
}

function configMap(name: string): ConfigMap {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: annotated(name), data: {} };
}

function pvc(name: string): PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: NS, annotations: { [`${P}/compose-volume`]: name.replace(/-/g, '_') } },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
  };
}

function route(name: string, composeName: string, middlewares: { name: string; namespace?: string }[]): IngressRoute {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: annotated(name, composeName),
    spec: { routes: [{ kind: 'Rule', match: 'Host(`shop.example.com`)', middlewares, services: [{ name: composeName, port: 80 }] }] },
  };
}

function middleware(name: string, spec: MiddlewareCrdSpec): Middleware {
  return { apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: annotated(name), spec };
}

const envFrom = (name: string) => [{ name: 'app', image: 'registry.example.com/app:1', envFrom: [{ secretRef: { name } }] }];

/** The render of design-03 6.3: `web` and `worker`, plus `api` for the Middleware cases. */
function render(): ManifestObject[] {
  return [
    deployment('web', { containers: envFrom('web-env-3f9a1c2e') }),
    service('web', 'web'),
    service('web-lb', 'web'),
    secret('web-env-3f9a1c2e'),
    route('shop-production-web', 'web', [{ name: 'redirect-https' }]),
    middleware('redirect-https', { redirectScheme: { scheme: 'https', permanent: true } }),
    deployment('worker', {
      containers: envFrom('worker-env-77aa0b1c'),
      volumes: [{ name: 'pvc-jobs-data', persistentVolumeClaim: { claimName: 'jobs-data' } }],
    }),
    service('worker', 'worker'),
    secret('worker-env-77aa0b1c'),
    pvc('jobs-data'),
  ];
}

const names = (objects: ManifestObject[]) => objects.map((o) => `${o.kind}/${o.metadata.name}`);

describe('closure', () => {
  it('applies the six objects of the worked example 6.3 in emitter order', () => {
    const result = closure(render(), ['web']);
    expect(names(result.objects)).toEqual([
      'Secret/web-env-3f9a1c2e',
      'Service/web',
      'Service/web-lb',
      'Deployment/web',
      'Middleware/redirect-https',
      'IngressRoute/shop-production-web',
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it('U-CLOSURE-01: takes env Secret, secret file, config, PVC, -lb and alias Services, route and Middleware, and nothing of worker', () => {
    const objects = [
      ...render().filter((o) => o.metadata.name !== 'web'),
      deployment('web', {
        containers: envFrom('web-env-3f9a1c2e'),
        volumes: [
          { name: 'secret-api-key-444', secret: { secretName: 'api-key-secret-9b1e0d44' } },
          { name: 'config-app-444', configMap: { name: 'app-conf-config-0c1d2e3f' } },
          { name: 'pvc-uploads', persistentVolumeClaim: { claimName: 'uploads' } },
        ],
      }),
      service('web', 'web'),
      service('frontend', 'web'),
      secret('api-key-secret-9b1e0d44'),
      configMap('app-conf-config-0c1d2e3f'),
      pvc('uploads'),
    ];
    expect(names(closure(objects, ['web']).objects)).toEqual([
      'Secret/api-key-secret-9b1e0d44',
      'Secret/web-env-3f9a1c2e',
      'ConfigMap/app-conf-config-0c1d2e3f',
      'PersistentVolumeClaim/uploads',
      'Service/frontend',
      'Service/web',
      'Service/web-lb',
      'Deployment/web',
      'Middleware/redirect-https',
      'IngressRoute/shop-production-web',
    ]);
  });

  it('U-CLOSURE-02: includes a Middleware shared by two services once, for either of them', () => {
    const objects = [...render(), deployment('api'), service('api', 'api'), route('shop-production-api', 'api', [{ name: 'redirect-https' }])];
    expect(names(closure(objects, ['api']).objects)).toContain('Middleware/redirect-https');
    const both = names(closure(objects, ['web', 'api']).objects);
    expect(both.filter((n) => n === 'Middleware/redirect-https')).toHaveLength(1);
  });

  it('includes a compose secret and config referenced by two services once', () => {
    const files: Partial<PodSpec> = {
      volumes: [
        { name: 'secret-api-key-444', secret: { secretName: 'api-key-secret-9b1e0d44' } },
        { name: 'config-app-444', configMap: { name: 'app-conf-config-0c1d2e3f' } },
      ],
    };
    const objects = [
      deployment('web', files),
      deployment('worker', files),
      secret('api-key-secret-9b1e0d44'),
      configMap('app-conf-config-0c1d2e3f'),
    ];
    expect(names(closure(objects, ['worker']).objects)).toEqual([
      'Secret/api-key-secret-9b1e0d44',
      'ConfigMap/app-conf-config-0c1d2e3f',
      'Deployment/worker',
    ]);
    expect(names(closure(objects, ['web', 'worker']).objects)).toEqual([
      'Secret/api-key-secret-9b1e0d44',
      'ConfigMap/app-conf-config-0c1d2e3f',
      'Deployment/web',
      'Deployment/worker',
    ]);
  });

  it('includes the PVC a pod template mounts', () => {
    expect(names(closure(render(), ['worker']).objects)).toEqual([
      'Secret/worker-env-77aa0b1c',
      'PersistentVolumeClaim/jobs-data',
      'Service/worker',
      'Deployment/worker',
    ]);
  });

  it('lists unknown compose names and Helm-only names as unmatched, sorted and once', () => {
    const result = closure(render(), ['web', 'redis-chart', 'ghost', 'ghost']);
    expect(result.unmatched).toEqual(['ghost', 'redis-chart']);
    expect(names(result.objects)).toContain('Deployment/web');
  });

  it('never adds claim-template PVCs: the StatefulSet controller creates them', () => {
    const queue: StatefulSet = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: annotated('queue', 'queue'),
      spec: {
        selector: {},
        template: { metadata: {}, spec: { containers: [{ name: 'queue', image: 'registry.example.com/queue:1' }] } },
        volumeClaimTemplates: [
          {
            metadata: { name: 'queue-data' },
            spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
          },
        ],
      },
    };
    expect(names(closure([queue, pvc('queue-data'), service('queue-hl', 'queue')], ['queue']).objects)).toEqual([
      'Service/queue-hl',
      'StatefulSet/queue',
    ]);
  });

  it('U-CLOSURE-03 (K46): a basicAuth or digestAuth Middleware pulls its generated users Secret', () => {
    const objects = [
      deployment('web'),
      route('shop-production-web', 'web', [{ name: 'admin-auth' }, { name: 'digest' }]),
      middleware('admin-auth', { basicAuth: { secret: 'admin-auth-auth-secret-1a2b3c4d' } }),
      middleware('digest', { digestAuth: { secret: 'digest-auth-secret-5e6f7a8b' } }),
      secret('admin-auth-auth-secret-1a2b3c4d'),
      secret('digest-auth-secret-5e6f7a8b'),
      secret('unrelated-secret-00000000'),
    ];
    expect(names(closure(objects, ['web']).objects)).toEqual([
      'Secret/admin-auth-auth-secret-1a2b3c4d',
      'Secret/digest-auth-secret-5e6f7a8b',
      'Deployment/web',
      'Middleware/admin-auth',
      'Middleware/digest',
      'IngressRoute/shop-production-web',
    ]);
  });

  it('U-CLOSURE-04 (K46): an errors Middleware pulls the named Service but not that service workload', () => {
    const objects = [
      deployment('web'),
      route('shop-production-web', 'web', [{ name: 'error-pages' }]),
      middleware('error-pages', { errors: { status: ['500-599'], query: '/{status}.html', service: { name: 'api', port: 80 } } }),
      deployment('api'),
      service('api', 'api'),
    ];
    const result = names(closure(objects, ['web']).objects);
    expect(result).toContain('Service/api');
    expect(result).not.toContain('Deployment/api');
  });

  it('follows chain Middlewares and ignores references to another namespace', () => {
    const objects = [
      deployment('web'),
      route('shop-production-web', 'web', [{ name: 'secured' }, { name: 'global', namespace: 'dockflow-system' }]),
      middleware('secured', { chain: { middlewares: [{ name: 'admin-auth' }, { name: 'headers' }] } }),
      middleware('admin-auth', { basicAuth: { secret: 'admin-auth-auth-secret-1a2b3c4d' } }),
      middleware('headers', { headers: { frameDeny: true } }),
      middleware('global', { headers: {} }),
      secret('admin-auth-auth-secret-1a2b3c4d'),
    ];
    const result = names(closure(objects, ['web']).objects);
    expect(result).toEqual([
      'Secret/admin-auth-auth-secret-1a2b3c4d',
      'Deployment/web',
      'Middleware/admin-auth',
      'Middleware/headers',
      'Middleware/secured',
      'IngressRoute/shop-production-web',
    ]);
  });

  it('U-CLOSURE-05: excludePvcs drops the PVCs and nothing else', () => {
    const full = closure(render(), ['worker']);
    const restore = closure(render(), ['worker'], { excludePvcs: true });
    expect(names(restore.objects)).toEqual(names(full.objects).filter((n) => !n.startsWith('PersistentVolumeClaim/')));
    expect(restore.unmatched).toEqual(full.unmatched);
  });

  it('closeOver starts from seed objects: a Middleware seed brings its auth Secret', () => {
    const objects = [middleware('admin-auth', { basicAuth: { secret: 'admin-auth-auth-secret-1a2b3c4d' } }), secret('admin-auth-auth-secret-1a2b3c4d')];
    expect(names(closeOver(objects, [objects[0]]))).toEqual(['Secret/admin-auth-auth-secret-1a2b3c4d', 'Middleware/admin-auth']);
  });
});
