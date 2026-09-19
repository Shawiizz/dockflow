// Probes of one container (design-02 5.6, D10): which of startup, readiness and liveness a service
// gets, their handler and their timings. This file is the only place that decides the probe set
// (K35, K72); every timing is computed in whole seconds, the unit the kubelet runs probes with.
// Pure: no clock, no randomness (T2).

import type { CanonicalService, HealthSpec, ProbeOverride } from '../model/types';
import { ceilSeconds } from '../model/units';
import type { Probe } from '../resources/core';
import { escapeKubeExpansion, type TranslateContext, translatorBug } from './context';
import { reportTranslator } from './diagnostics';

/** The timing fields of a HealthSpec, with Docker's defaults when the service has no healthcheck. */
export type HealthTimings = Pick<HealthSpec, 'intervalMs' | 'timeoutMs' | 'retries' | 'startPeriodMs' | 'startIntervalMs'>;

export const DOCKER_HEALTHCHECK_DEFAULTS: Readonly<HealthTimings> = {
  intervalMs: 30_000,
  timeoutMs: 30_000,
  retries: 3,
  startPeriodMs: 0,
  startIntervalMs: 5_000,
};

export interface ProbeSeconds {
  /** I: periodSeconds of readiness and liveness */
  interval: number;
  /** T: timeoutSeconds of every probe */
  timeout: number;
  /** R: failureThreshold of readiness and liveness */
  retries: number;
  /** ceilSeconds(start_period, 0); 0 = no startup probe */
  startPeriod: number;
  /** SI: periodSeconds of the startup probe */
  startInterval: number;
  /** max(1, ceil((startPeriod + R * I) / SI)) */
  startupFailureThreshold: number;
}

/**
 * The healthcheck timings in the probe's own unit (K35): the startup budget is computed from the
 * rounded seconds, so the threshold matches the clock the probe actually runs on.
 */
export function probeSeconds(h: HealthTimings): ProbeSeconds {
  const interval = ceilSeconds(h.intervalMs, 1);
  const timeout = ceilSeconds(h.timeoutMs, 1);
  const retries = Math.max(1, h.retries);
  const startPeriod = ceilSeconds(h.startPeriodMs, 0);
  const startInterval = ceilSeconds(h.startIntervalMs, 1);
  const startupFailureThreshold = Math.max(1, Math.ceil((startPeriod + retries * interval) / startInterval));
  return { interval, timeout, retries, startPeriod, startInterval, startupFailureThreshold };
}

export interface ProbeSelection {
  startup: boolean;
  readiness: boolean;
  liveness: boolean;
}

const NONE: ProbeSelection = { startup: false, readiness: false, liveness: false };

/**
 * The which-probes table of design-02 5.6. A startup probe exists only next to a liveness probe
 * and with a start period: it is a kill switch, and `use: readiness` asks for none.
 */
export function selectProbes(h: HealthSpec | null, o: ProbeOverride | null): ProbeSelection {
  const use = o?.use ?? 'both';
  if (use === 'none') return NONE;
  if (h === null && (o === null || o.handler === null)) return NONE;
  const readiness = use === 'both' || use === 'readiness';
  const liveness = use === 'both' || use === 'liveness';
  const startup = liveness && h !== null && h.startPeriodMs > 0;
  return { startup, readiness, liveness };
}

type ProbeHandler = Pick<Probe, 'exec' | 'httpGet' | 'tcpSocket'>;

/** A fresh handler object per call, so no two probes share one. */
function probeHandler(h: HealthSpec | null, o: ProbeOverride | null): ProbeHandler {
  const handler = o?.handler ?? null;
  if (handler !== null) {
    if (handler.type === 'tcp') return { tcpSocket: { port: handler.port } };
    return {
      httpGet:
        handler.scheme === 'HTTP'
          ? { path: handler.path, port: handler.port }
          : { path: handler.path, port: handler.port, scheme: handler.scheme },
    };
  }
  if (h === null) translatorBug('A probe was selected for a service without a healthcheck or an override handler');
  // Kubernetes expands $(VAR) in exec probes; doubling every $ delivers the command verbatim (T4).
  if (h.test.type === 'exec') return { exec: { command: h.test.argv.map(escapeKubeExpansion) } };
  return { exec: { command: ['/bin/sh', '-c', escapeKubeExpansion(h.test.command)] } };
}

export interface ContainerProbes {
  startupProbe?: Probe;
  readinessProbe?: Probe;
  livenessProbe?: Probe;
}

/** The probes of `svc` (design-02 5.6); every timing field is emitted (emission rule 8). */
export function buildProbes(svc: CanonicalService, ctx: TranslateContext): ContainerProbes {
  const h = svc.healthcheck;
  const o = svc.extension.probes;
  const selection = selectProbes(h, o);
  const probes: ContainerProbes = {};

  if (selection.readiness || selection.liveness) {
    const s = probeSeconds(h ?? DOCKER_HEALTHCHECK_DEFAULTS);
    if (h === null) reportTranslator(ctx.sink, 'probes.override-defaults', `${svc.path}.x-dockflow.probes`, { service: svc.composeName });
    if (selection.startup) {
      probes.startupProbe = {
        ...probeHandler(h, o),
        failureThreshold: s.startupFailureThreshold,
        initialDelaySeconds: 0,
        periodSeconds: s.startInterval,
        successThreshold: 1,
        timeoutSeconds: s.timeout,
      };
    }
    if (selection.readiness) {
      probes.readinessProbe = {
        ...probeHandler(h, o),
        failureThreshold: s.retries,
        initialDelaySeconds: 0,
        periodSeconds: s.interval,
        successThreshold: 1,
        timeoutSeconds: s.timeout,
      };
    }
    if (selection.liveness) {
      probes.livenessProbe = {
        ...probeHandler(h, o),
        failureThreshold: s.retries,
        // Docker runs the first check one interval after start; the startup probe covers that wait when it exists.
        initialDelaySeconds: s.startPeriod > 0 ? 0 : s.interval,
        periodSeconds: s.interval,
        successThreshold: 1,
        timeoutSeconds: s.timeout,
      };
    }
  }

  const probed = probes.readinessProbe !== undefined || probes.livenessProbe !== undefined;
  if (!probed && svc.routes.length > 0) {
    reportTranslator(ctx.sink, 'probes.routed-without-healthcheck', svc.path, { service: svc.composeName });
  }
  return probes;
}
