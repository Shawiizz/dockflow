// design-07 5.2 T-ING rows (translate/ingress.ts, D16, C4): IngressRoute, Middleware and the
// generated basicAuth/digestAuth users Secret.
//
// T-ING-04 (design-07's cell: "router referencing an undefined middleware -> error (proposal
// routing.middleware-undefined)") is not a row of this file: design-02 11.2 and design-01 361 are
// explicit that the check is decidable from compose syntax alone (`input.sibling.middlewares`) and
// is the NORMALIZER's `routing.unknown-middleware`, which "replaces routing.middleware-undefined"
// and refuses the render before the translator ever runs (confirmed against
// normalize/routing.ts: reaching `buildIngress` with a dangling reference is unreachable from user
// input). It belongs to the normalizer row catalogue (design-01 11, P49), not here.
//
// T-ING-07 ("services[].port is a port of the referenced Service; every routes[] entry carries
// kind: Rule explicitly") is not a dedicated row either: `translateChecked` runs semantic rules S16
// (`spec.routes[].services[].port` must match a Service port) and S26 (`kind` is mandatory on every
// route) on every row of this file already (support/schema/semantic.ts), so a row violating either
// would fail whichever row produced it. A dedicated row would only repeat that coverage.

import { expect, test } from 'bun:test';
import { LABELS } from '../../../../services/orchestrator/kubernetes/constants';
import { authSecretContent, authSecretName, ingressRouteNameFor } from '../../../../services/orchestrator/kubernetes/translate/ingress';
import { type TranslateRow, runTranslateRows, translateRow } from '../../support/rows';

const STACK_NAME = 'shop-production';
const ACME_PROXY = { enabled: true, acme: true, email: 'ops@example.com', domains: { production: 'shop.example.com' } };

const rows: TranslateRow[] = [
  {
    id: 'T-ING-01',
    title: 'N-RT-01 stack (proxy enabled, ACME) -> injected IngressRoute, websecure, letsencrypt',
    compose: `
      image: nginx:1.27
      ports: ["8080:80"]
    `,
    normalize: { proxy: ACME_PROXY },
    expect: {
      object: `IngressRoute/${ingressRouteNameFor('web', `${STACK_NAME}-web`)}`,
      pointer: '/spec',
      equals: {
        entryPoints: ['websecure'],
        routes: [{ kind: 'Rule', match: 'Host(`shop.example.com`)', services: [{ name: 'web', port: 80 }] }],
        tls: { certResolver: 'letsencrypt' },
      },
    },
  },
  {
    id: 'T-ING-02',
    title: 'acme: false -> entryPoints [web], no tls',
    compose: `
      image: nginx:1.27
      ports: ["8080:80"]
    `,
    normalize: { proxy: { ...ACME_PROXY, acme: false } },
    expect: {
      object: `IngressRoute/${ingressRouteNameFor('web', `${STACK_NAME}-web`)}`,
      pointer: '/spec',
      equals: { entryPoints: ['web'], routes: [{ kind: 'Rule', match: 'Host(`shop.example.com`)', services: [{ name: 'web', port: 80 }] }] },
    },
  },
  {
    id: 'T-ING-03',
    title: 'two label routers, one with middlewares in declaration order',
    compose: `
      image: nginx:1.27
      ports: ["8080:80"]
      labels:
        traefik.enable: "true"
        traefik.http.routers.api.rule: "PathPrefix(\`/api\`)"
        traefik.http.routers.api.middlewares: "auth,strip"
        traefik.http.routers.admin.rule: "PathPrefix(\`/admin\`)"
        traefik.http.middlewares.auth.basicauth.users: "a:$$apr1$$x"
        traefik.http.middlewares.strip.stripprefix.prefixes: "/api"
    `,
    normalize: { proxy: ACME_PROXY },
    expect: [
      { object: 'Middleware/auth', pointer: '/metadata/name', equals: 'auth' },
      { object: 'Middleware/strip', pointer: '/metadata/name', equals: 'strip' },
      { object: `IngressRoute/${ingressRouteNameFor('web', 'api')}`, pointer: '/spec/routes/0/middlewares', equals: [{ name: 'auth' }, { name: 'strip' }] },
      { object: `IngressRoute/${ingressRouteNameFor('web', 'admin')}`, pointer: '/spec/routes/0/middlewares', absent: true },
      { object: `IngressRoute/${ingressRouteNameFor('web', 'api')}`, pointer: '/spec/routes/0/kind', equals: 'Rule' },
    ],
  },
  {
    id: 'T-ING-05',
    title: 'proxy disabled -> no IngressRoute, no Middleware',
    compose: `
      image: nginx:1.27
      ports: ["8080:80"]
    `,
    expect: { kinds: ['Deployment/web', 'Service/web', 'Service/web-lb'] },
  },
  {
    id: 'T-ING-06',
    title: 'accessory with an explicit label router -> IngressRoute carries P/role: accessory',
    compose: `
      image: nginx:1.27
      ports: ["8080:80"]
      labels:
        traefik.enable: "true"
        traefik.http.routers.api.rule: "PathPrefix(\`/api\`)"
    `,
    normalize: { role: 'accessory', proxy: ACME_PROXY },
    expect: { object: `IngressRoute/${ingressRouteNameFor('web', 'api')}`, pointer: `/metadata/labels/${LABELS.role.replace('/', '~1')}`, equals: 'accessory' },
  },
  {
    id: 'T-ING-08',
    title: 'basicauth users given inline -> a generated Secret named from the content, referenced by spec',
    compose: `
      image: nginx:1.27
      ports: ["8080:80"]
      labels:
        traefik.enable: "true"
        traefik.http.routers.api.rule: "PathPrefix(\`/api\`)"
        traefik.http.routers.api.middlewares: "auth"
        traefik.http.middlewares.auth.basicauth.users: "admin:$$apr1$$xyz"
    `,
    normalize: { proxy: ACME_PROXY },
    expect: [
      {
        object: 'Middleware/auth',
        pointer: '/spec/basicAuth/secret',
        equals: authSecretName('auth', authSecretContent(['admin:$apr1$xyz'])),
      },
      {
        object: `Secret/${authSecretName('auth', authSecretContent(['admin:$apr1$xyz']))}`,
        pointer: '/data/users',
        equals: Buffer.from(authSecretContent(['admin:$apr1$xyz']), 'utf8').toString('base64'),
      },
    ],
  },
];

runTranslateRows('translate/ingress (T-ING)', rows);

test('T-ING-09 a middleware errors.service referencing another compose service -> that Service exists in the artifact', () => {
  const { objects } = translateRow({
    id: 'errors-service',
    title: 'errors service',
    compose: `
      services:
        web:
          image: nginx:1.27
          ports: ["8080:80"]
          labels:
            traefik.enable: "true"
            traefik.http.routers.api.rule: "PathPrefix(\`/api\`)"
            traefik.http.routers.api.middlewares: "err"
            traefik.http.middlewares.err.errors.service: "fallback"
            traefik.http.middlewares.err.errors.status: "500-599"
            traefik.http.middlewares.err.errors.query: "/error.html"
        fallback:
          image: nginx:1.27
          ports: ["8081:81"]
    `,
    normalize: { proxy: ACME_PROXY },
    expect: [],
  });
  const middleware = objects.find((o) => o.kind === 'Middleware' && o.metadata.name === 'err');
  if (middleware === undefined || middleware.kind !== 'Middleware') throw new Error('Middleware/err was not produced');
  expect(middleware.spec.errors).toMatchObject({ service: { name: 'fallback' } });
  const fallback = objects.find((o) => o.kind === 'Service' && o.metadata.name === 'fallback');
  if (fallback === undefined) throw new Error('Service/fallback was not produced');
});
