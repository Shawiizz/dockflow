/**
 * Compose Traefik — injects routing labels and the proxy network into services,
 * and checks that proxy.routes can be served.
 */

import type { ProxyConfig, ProxyRoute } from '../../utils/config';
import { printDim, printWarning } from '../../utils/output';
import { TRAEFIK_NETWORK_NAME } from '../../constants';
import { parseContainerPort } from './selection';
import type { ParsedCompose } from './types';

/** `deploy.labels` as `key=value` entries, from the list or the map form of compose */
function labelEntries(labels: unknown): string[] {
  if (Array.isArray(labels)) return labels.map(String);
  if (labels && typeof labels === 'object') {
    return Object.entries(labels as Record<string, unknown>).map(([k, v]) => `${k}=${v ?? ''}`);
  }
  return [];
}

/** label values by key; a later entry wins, as when Docker reads the list */
function labelValues(entries: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    values.set(eq === -1 ? entry : entry.slice(0, eq), eq === -1 ? '' : entry.slice(eq + 1));
  }
  return values;
}

/** the false values of Go's strconv.ParseBool, which Traefik reads `traefik.enable` with */
function isFalseLabel(value: string): boolean {
  return ['0', 'f', 'F', 'false', 'FALSE', 'False'].includes(value.trim());
}

/** the labels a service sets itself in `deploy.labels`, by key */
function ownLabels(svc: Record<string, unknown>): Map<string, string> {
  return labelValues(labelEntries((svc.deploy as Record<string, unknown> | undefined)?.labels));
}

/** whether the service sets `traefik.enable=false` itself */
function optsOutOfTraefik(svc: Record<string, unknown>): boolean {
  return isFalseLabel(ownLabels(svc).get('traefik.enable') ?? 'true');
}

/** the container port of the service's first `ports:` entry, else of its first `expose:` entry */
function firstContainerPort(svc: Record<string, unknown>): number | undefined {
  for (const key of ['ports', 'expose']) {
    const list = svc[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const port = parseContainerPort(list[0]);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return undefined;
}

/** the router name of the route on proxy.domains */
function defaultRouter(stackName: string, svcName: string): string {
  return `${stackName}-${svcName}`;
}

/**
 * The services that answer on proxy.domains: those exposing ports, unless proxy.routes lists them,
 * they set traefik.enable=false, or they give the router a rule of their own.
 */
function onDefaultDomain(compose: ParsedCompose, proxy: ProxyConfig, stackName: string): string[] {
  const listed = new Set((proxy.routes ?? []).map((route) => route.service));
  return Object.entries(compose.services)
    .filter(([name, svc]) => Array.isArray(svc.ports) && svc.ports.length > 0 && !listed.has(name) && !optsOutOfTraefik(svc))
    .filter(([name, svc]) => !ownLabels(svc).has(`traefik.http.routers.${defaultRouter(stackName, name)}.rule`))
    .map(([name]) => name);
}

/**
 * Add Traefik labels to a service and attach it to the proxy network.
 * A label the service sets itself wins over the injected one.
 */
function attachToProxy(compose: ParsedCompose, svcName: string, labels: readonly [string, string][]): void {
  const svc = compose.services[svcName];
  const deploy = (svc.deploy ?? {}) as Record<string, unknown>;
  const existing = labelEntries(deploy.labels);
  const own = labelValues(existing);
  const labelList = [...existing, ...labels.filter(([key]) => !own.has(key)).map(([key, value]) => `${key}=${value}`)];

  const existingNets = svc.networks;
  let newNets: unknown;

  if (Array.isArray(existingNets)) {
    const current = existingNets.map(String);
    newNets = [...new Set([...current, TRAEFIK_NETWORK_NAME])];
  } else if (existingNets && typeof existingNets === 'object') {
    const netObj = { ...(existingNets as Record<string, unknown>) };
    if (!(TRAEFIK_NETWORK_NAME in netObj)) {
      netObj[TRAEFIK_NETWORK_NAME] = null;
    }
    newNets = netObj;
  } else {
    newNets = ['default', TRAEFIK_NETWORK_NAME];
  }

  compose.services[svcName] = {
    ...svc,
    deploy: { ...deploy, labels: labelList },
    networks: newNets,
  };
}

/**
 * Inject Traefik routing labels.
 *
 * Each route of `proxy.routes` whose service is in this compose gets a router of its own, and
 * those services get no other route. With `defaultRoute` (the app stack, by default), every other
 * service that exposes ports answers on `proxy.domains[env]`. A service opts out with
 * `traefik.enable=false` in `deploy.labels`, and every label it sets itself wins over the
 * injected one.
 *
 * Returns whether a service of the compose is routed.
 */
export function injectTraefikLabels(
  compose: ParsedCompose,
  proxy: ProxyConfig,
  stackName: string,
  env: string,
  options: { defaultRoute?: boolean } = {},
): boolean {
  if (!proxy.enabled) return false;

  const acme = proxy.acme !== false;
  const entrypoint = acme ? 'websecure' : 'web';
  let routed = false;

  // A router per route, each sending to a Traefik service of its own: routes of one service can
  // reach different ports. Routers are numbered among the routes of their service.
  const listed = new Map<string, ProxyRoute[]>();
  for (const route of proxy.routes ?? []) listed.set(route.service, [...(listed.get(route.service) ?? []), route]);

  for (const [svcName, routes] of listed) {
    if (!Object.hasOwn(compose.services, svcName)) continue;
    const svc = compose.services[svcName];
    if (!routes.some((route) => route.domains[env])) {
      printDim(`Service "${svcName}" has no route for ${env} in proxy.routes: Traefik does not serve it there`);
      continue;
    }
    if (optsOutOfTraefik(svc)) {
      printWarning(`Service "${svcName}" sets traefik.enable=false: its routes in proxy.routes are not applied`);
      continue;
    }

    const labels: [string, string][] = [];
    routes.forEach((route, i) => {
      const domain = route.domains[env];
      const port = route.port ?? firstContainerPort(svc);
      if (!domain) return;
      if (port === undefined) {
        printWarning(`Service "${svcName}" declares no port: its route on ${domain} needs one`);
        return;
      }
      const router = `${stackName}-${svcName}-route${i + 1}`;
      labels.push(
        [`traefik.http.routers.${router}.rule`, route.path ? `Host(\`${domain}\`) && PathPrefix(\`${route.path}\`)` : `Host(\`${domain}\`)`],
        [`traefik.http.routers.${router}.entrypoints`, entrypoint],
        [`traefik.http.routers.${router}.service`, router],
        [`traefik.http.services.${router}.loadbalancer.server.port`, String(port)],
      );
      if (acme) labels.push([`traefik.http.routers.${router}.tls.certresolver`, 'letsencrypt']);
    });
    if (labels.length === 0) continue;

    attachToProxy(compose, svcName, [['traefik.enable', 'true'], ['traefik.docker.network', TRAEFIK_NETWORK_NAME], ...labels]);
    routed = true;
  }

  const domain = proxy.domains?.[env];
  if (options.defaultRoute !== false && domain) {
    const onDomain = onDefaultDomain(compose, proxy, stackName);

    for (const [svcName, svc] of Object.entries(compose.services)) {
      const ports = svc.ports as unknown[] | undefined;
      if (!ports || ports.length === 0 || listed.has(svcName)) continue;
      if (optsOutOfTraefik(svc)) {
        printDim(`Service "${svcName}" sets traefik.enable=false: no route is injected`);
        continue;
      }

      const containerPort = parseContainerPort(ports[0]);
      if (ports.length > 1) {
        printWarning(`Service "${svcName}" exposes ${ports.length} ports — only the first (${containerPort}) will be routed via Traefik`);
      }
      const routerName = defaultRouter(stackName, svcName);

      const traefikLabels: [string, string][] = [
        ['traefik.enable', 'true'],
        ['traefik.docker.network', TRAEFIK_NETWORK_NAME],
        [`traefik.http.routers.${routerName}.rule`, `Host(\`${domain}\`)`],
        [`traefik.http.routers.${routerName}.entrypoints`, entrypoint],
        [`traefik.http.services.${routerName}.loadbalancer.server.port`, String(containerPort)],
      ];
      if (acme) {
        traefikLabels.push([`traefik.http.routers.${routerName}.tls.certresolver`, 'letsencrypt']);
      }
      attachToProxy(compose, svcName, traefikLabels);
      routed = true;
    }

    if (onDomain.length > 1) {
      printWarning(
        `Services ${onDomain.join(', ')} all answer on ${domain}: Traefik sends each request to one of them. ` +
          'Add traefik.enable=false to deploy.labels of the services that must not, or give them their own route in proxy.routes.',
      );
    }
  }

  if (routed) {
    const topNets = (compose.networks ?? {}) as Record<string, unknown>;
    topNets[TRAEFIK_NETWORK_NAME] = { external: true };
    compose.networks = topNets;
    compose.raw.networks = topNets;
  }

  compose.raw.services = compose.services;
  return routed;
}

/**
 * What keeps proxy.routes from being served in this environment, one message each: a route whose
 * service is in neither compose file or in both, a service Traefik knows no port of, two routes
 * on the same domain and path, a route without a path on the domain of proxy.domains while
 * services answer there, or on the dashboard's. `accessories` is null when the project has no
 * accessories.yml.
 */
export function checkProxyRoutes(
  proxy: ProxyConfig,
  env: string,
  stackName: string,
  app: ParsedCompose,
  accessories: ParsedCompose | null,
): string[] {
  if (!proxy.enabled) return [];

  const problems: string[] = [];
  const claimed = new Map<string, number>();
  const defaultDomain = proxy.domains?.[env]?.toLowerCase();
  const onDomain = defaultDomain ? onDefaultDomain(app, proxy, stackName) : [];
  const dashboardDomain = proxy.dashboard?.enabled ? proxy.dashboard.domain?.toLowerCase() : undefined;

  (proxy.routes ?? []).forEach((route, i) => {
    const domain = route.domains[env]?.toLowerCase();
    if (!domain) return;
    const at = `proxy.routes[${i}]`;
    const inApp = Object.hasOwn(app.services, route.service);
    const inAccessories = accessories !== null && Object.hasOwn(accessories.services, route.service);

    if (!inApp && !inAccessories) {
      problems.push(`${at}: no service "${route.service}" in docker-compose.yml or accessories.yml`);
    } else if (inApp && inAccessories) {
      problems.push(`${at}: docker-compose.yml and accessories.yml both have a service "${route.service}"; rename one of them`);
    } else {
      const svc = (inApp ? app : (accessories as ParsedCompose)).services[route.service];
      if (route.port === undefined && firstContainerPort(svc) === undefined) {
        problems.push(`${at}: service "${route.service}" declares no port; set port to the one it listens on`);
      }
    }

    const target = `${domain}${route.path ?? ''}`;
    const first = claimed.get(target);
    if (first !== undefined) {
      problems.push(`${at}: proxy.routes[${first}] already routes ${target}`);
    } else {
      claimed.set(target, i);
    }
    if (domain === defaultDomain && !route.path && onDomain.length > 0) {
      problems.push(
        `${at}: ${domain} is also proxy.domains.${env}, the domain of the default route (${onDomain.join(', ')}); ` +
          'give the route a path, or add traefik.enable=false to deploy.labels of those services',
      );
    }
    if (domain === dashboardDomain && !route.path) {
      problems.push(`${at}: ${domain} is also proxy.dashboard.domain; give the route a path, or the dashboard another domain`);
    }
  });

  return problems;
}
