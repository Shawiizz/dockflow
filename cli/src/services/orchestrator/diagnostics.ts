/**
 * Render diagnostics. One sink per render is shared by the normalizer and the translator, so a
 * condition reported by both layers reaches the user once and the merged list has one order.
 */

// Declared in utils/errors.ts: a class extending CLIError here, re-exported from there, is an
// import cycle that throws whenever utils/errors.ts is loaded first.
export { ComposeTranslationError } from '../../utils/errors';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** `<area>.<slug>`, e.g. 'ports.host-ip-ignored'; stable, asserted by tests */
  code: string;
  /** compose YAML path, e.g. 'services.web.ports[0]' or 'volumes.data.x-dockflow.size' */
  path: string;
  message: string;
  hint?: string;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class DiagnosticSink {
  private readonly entries = new Map<string, Diagnostic>();

  error(code: string, path: string, message: string, hint?: string): void {
    this.add('error', code, path, message, hint);
  }

  warn(code: string, path: string, message: string, hint?: string): void {
    this.add('warning', code, path, message, hint);
  }

  info(code: string, path: string, message: string, hint?: string): void {
    this.add('info', code, path, message, hint);
  }

  /** deduplicated by (code, path), first report kept; sorted by (path, code) in code-unit order */
  list(): Diagnostic[] {
    return [...this.entries.values()]
      .map((d) => ({ ...d }))
      .sort((a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.code, b.code));
  }

  hasErrors(): boolean {
    for (const d of this.entries.values()) {
      if (d.severity === 'error') return true;
    }
    return false;
  }

  private add(severity: DiagnosticSeverity, code: string, path: string, message: string, hint?: string): void {
    const key = JSON.stringify([code, path]);
    if (this.entries.has(key)) return;
    // no `hint: undefined` key: expected-diagnostics.json is compared byte for byte
    this.entries.set(key, hint === undefined ? { severity, code, path, message } : { severity, code, path, message, hint });
  }
}
