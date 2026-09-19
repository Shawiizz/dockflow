// design-07 4.2 row catalogue, group N-RT (Traefik labels -> routes and middlewares; design-01 7;
// design-04 2.14; PD-6). Every row runs the full pipeline (PD-11 (a)); PD-6 governs the ACME rows.

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const ACME_PROXY = { acme: true, email: 'ops@example.com', domains: { production: 'shop.example.com' } };

const rows: NormalizeRow[] = [
  {
    id: 'N-RT-01',
    title: 'ACME on: the injected route uses websecure and letsencrypt',
    proxy: ACME_PROXY,
    compose: 'image: nginx:1.27\nports: ["8080:80"]',
    expect: [
      {
        select: '/services/0/routes/0',
        equals: {
          router: 'shop-production-web',
          rule: 'Host(`shop.example.com`)',
          entryPoints: ['websecure'],
          tls: { certResolver: 'letsencrypt' },
          middlewares: [],
          priority: null,
          port: 80,
          origin: 'injected',
          path: 'services.web.ports',
        },
      },
      { select: '/proxy', equals: { domain: 'shop.example.com', acme: true, entryPoint: 'websecure', certResolver: 'letsencrypt', manage: true } },
    ],
  },
  {
    id: 'N-RT-02',
    title: 'ACME off: the injected route uses web and no TLS',
    proxy: { ...ACME_PROXY, acme: false },
    compose: 'image: nginx:1.27\nports: ["8080:80"]',
    expect: [
      { select: '/services/0/routes/0/entryPoints', equals: ['web'] },
      { select: '/services/0/routes/0/tls', equals: null },
    ],
  },
  {
    id: 'N-RT-03',
    title: 'no domain for the environment: no injected route',
    proxy: { acme: true, domains: {} },
    compose: 'image: nginx:1.27\nports: ["8080:80"]',
    expect: [
      { select: '/services/0/routes', equals: [] },
      { select: '/proxy/domain', equals: null },
    ],
  },
  {
    id: 'N-RT-04',
    title: 'an accessory gets a proxy intent with domain null and no injected route',
    role: 'accessory',
    proxy: ACME_PROXY,
    compose: 'image: nginx:1.27\nports: ["8080:80"]',
    expect: [
      { select: '/services/0/routes', equals: [] },
      { select: '/proxy', equals: { domain: null, acme: true, entryPoint: 'websecure', certResolver: 'letsencrypt', manage: true } },
    ],
  },
  {
    id: 'N-RT-04b',
    title: 'proxy disabled: stack.proxy is null for both roles',
    role: 'accessory',
    proxy: null,
    compose: 'image: nginx:1.27\nports: ["8080:80"]',
    expect: { select: '/proxy', equals: null },
  },
  {
    id: 'N-RT-05',
    title: 'traefik.enable=false opts out of the injected route',
    proxy: ACME_PROXY,
    compose: 'image: nginx:1.27\nports: ["8080:80"]\nlabels:\n  traefik.enable: "false"',
    expect: { select: '/services/0/routes', equals: [] },
  },
  {
    id: 'N-RT-06',
    title: 'two label routers, sorted by name, with middlewares and priority',
    proxy: ACME_PROXY,
    compose:
      'image: nginx:1.27\nports: ["8080:80"]\nlabels:\n  traefik.http.routers.api.rule: Host(`api.example.com`)\n  traefik.http.routers.api.entrypoints: websecure\n  traefik.http.routers.api.priority: "10"\n  traefik.http.routers.api.middlewares: auth,strip\n  traefik.http.routers.admin.rule: Host(`admin.example.com`)\n  traefik.http.routers.admin.entrypoints: websecure\n  traefik.http.middlewares.auth.basicauth.users: "a:$$apr1$$x"\n  traefik.http.middlewares.strip.stripprefix.prefixes: /api',
    // 'api' and 'admin' are label routers, neither named like the injected default
    // (shop-production-web), so injectDefaultRoutes also adds that route separately (design-01 7.5).
    expect: [
      {
        select: '/services/0/routes',
        equals: [
          {
            router: 'admin',
            rule: 'Host(`admin.example.com`)',
            entryPoints: ['websecure'],
            tls: null,
            middlewares: [],
            priority: null,
            port: 80,
            origin: 'labels',
            path: 'services.web.labels["traefik.http.routers.admin.rule"]',
          },
          {
            router: 'api',
            rule: 'Host(`api.example.com`)',
            entryPoints: ['websecure'],
            tls: null,
            middlewares: ['auth', 'strip'],
            priority: 10,
            port: 80,
            origin: 'labels',
            path: 'services.web.labels["traefik.http.routers.api.rule"]',
          },
          {
            router: 'shop-production-web',
            rule: 'Host(`shop.example.com`)',
            entryPoints: ['websecure'],
            tls: { certResolver: 'letsencrypt' },
            middlewares: [],
            priority: null,
            port: 80,
            origin: 'injected',
            path: 'services.web.ports',
          },
        ],
      },
    ],
  },
  {
    id: 'N-RT-07',
    title: 'an explicit loadbalancer.server.port picks the routed port',
    proxy: ACME_PROXY,
    compose:
      'image: nginx:1.27\nports: ["8080:80", "9090:90"]\nlabels:\n  traefik.http.routers.api.rule: Host(`api.example.com`)\n  traefik.http.services.api.loadbalancer.server.port: "3000"',
    // a second injected route (shop-production-web) also appears (design-01 7.5); with more than
    // one published port it carries the "only the first port is routed" warning.
    expect: [
      { select: '/services/0/routes/0/port', equals: 3000 },
      { diagnostics: [{ severity: 'warning', code: 'routing.injected-first-port', path: 'services.web.ports' }] },
    ],
  },
  {
    id: 'N-RT-08',
    title: 'two container ports and no loadbalancer port label is ambiguous',
    proxy: ACME_PROXY,
    compose: 'image: nginx:1.27\nports: ["8080:80", "9090:90"]\nlabels:\n  traefik.http.routers.api.rule: Host(`api.example.com`)',
    expect: {
      diagnostics: [
        { severity: 'error', code: 'routing.port-ambiguous', path: 'services.web.labels["traefik.http.routers.api.rule"]' },
        { severity: 'warning', code: 'routing.injected-first-port', path: 'services.web.ports' },
      ],
    },
  },
  {
    id: 'N-RT-09',
    title: 'basicauth users and stripprefix prefixes are parsed from label values',
    proxy: ACME_PROXY,
    compose:
      'image: nginx:1.27\nports: ["8080:80"]\nlabels:\n  traefik.http.routers.api.rule: Host(`api.example.com`)\n  traefik.http.routers.api.middlewares: auth,strip\n  traefik.http.middlewares.auth.basicauth.users: "a:$$apr1$$x"\n  traefik.http.middlewares.strip.stripprefix.prefixes: /api',
    expect: [
      { select: '/middlewares/0/spec', equals: { basicAuth: {} } },
      { select: '/middlewares/0/users', equals: ['a:$apr1$x'] },
      { select: '/middlewares/1/spec', equals: { stripPrefix: { prefixes: ['/api'] } } },
    ],
  },
  {
    id: 'N-RT-10',
    title: 'proxy disabled with traefik labels: no routes, warning',
    proxy: null,
    compose: 'image: nginx:1.27\nlabels:\n  traefik.enable: "true"\n  traefik.http.routers.api.rule: Host(`api.example.com`)',
    expect: [
      { select: '/services/0/routes', equals: [] },
      { diagnostics: [{ severity: 'warning', code: 'routing.proxy-disabled', path: 'services.web' }] },
    ],
  },
  {
    id: 'N-RT-11',
    title: 'traefik.docker.network is dropped silently by policy',
    proxy: ACME_PROXY,
    compose: 'image: nginx:1.27\nports: ["8080:80"]\nlabels:\n  traefik.docker.network: front',
    expect: { diagnostics: [{ severity: 'info', code: 'routing.swarm-label-ignored', path: 'services.web.labels["traefik.docker.network"]' }] },
  },
  {
    id: 'N-RT-12',
    title: 'a TCP router label is refused: TCP and UDP routers are not supported',
    proxy: ACME_PROXY,
    compose: 'image: nginx:1.27\nports: ["8080:80"]\nlabels:\n  traefik.tcp.routers.x.rule: HostSNI(`x.example.com`)',
    expect: { diagnostics: [{ severity: 'error', code: 'routing.tcp-udp-unsupported', path: 'services.web.labels["traefik.tcp.routers.x.rule"]' }] },
  },
  {
    id: 'N-RT-13',
    title: 'a sanitized middleware name warns',
    proxy: ACME_PROXY,
    compose:
      'image: nginx:1.27\nports: ["8080:80"]\nlabels:\n  traefik.http.routers.api.rule: Host(`api.example.com`)\n  traefik.http.routers.api.middlewares: Auth_Basic\n  traefik.http.middlewares.Auth_Basic.basicauth.users: "a:$$apr1$$x"',
    expect: [
      { select: '/middlewares/0/name', equals: 'auth-basic' },
      { diagnostics: [{ severity: 'info', code: 'names.middleware-sanitized', path: 'services.web.labels["traefik.http.middlewares.Auth_Basic.basicauth.users"]' }] },
    ],
  },
];

runNormalizeRows('normalize/routing (N-RT)', rows);
