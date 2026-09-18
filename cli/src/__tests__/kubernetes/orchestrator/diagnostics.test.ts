import { describe, expect, it } from 'bun:test';
import { ComposeTranslationError, type Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import { CLIError, ComposeTranslationError as ErrorsComposeTranslationError, ErrorCode } from '../../../utils/errors';

describe('DiagnosticSink (U-DIAG-01)', () => {
  it('deduplicates by (code, path) and keeps the first report', () => {
    const sink = new DiagnosticSink();
    sink.warn('volumes.rwo-replicas', 'services.web.volumes[0]', 'first');
    sink.error('volumes.rwo-replicas', 'services.web.volumes[0]', 'second', 'hint');
    expect(sink.list()).toEqual([
      { severity: 'warning', code: 'volumes.rwo-replicas', path: 'services.web.volumes[0]', message: 'first' },
    ]);
  });

  it('keeps entries that share only the code or only the path', () => {
    const sink = new DiagnosticSink();
    sink.warn('ports.publish-none', 'services.web.ports[0]', 'a');
    sink.warn('ports.publish-none', 'services.web.ports[1]', 'b');
    sink.warn('ports.host-ip-ignored', 'services.web.ports[0]', 'c');
    expect(sink.list()).toHaveLength(3);
  });

  it('does not confuse a code and path pair with another that concatenates the same way', () => {
    const sink = new DiagnosticSink();
    sink.info('a b', 'c', 'one');
    sink.info('a', 'b c', 'two');
    expect(sink.list().map((d) => d.message)).toEqual(['two', 'one']);
  });

  it('sorts by path, then code, in code-unit order', () => {
    const sink = new DiagnosticSink();
    sink.warn('z.code', 'services.web.ports[2]', 'm');
    sink.warn('b.code', 'services.web.ports[10]', 'm');
    sink.warn('a.code', 'services.web.ports[10]', 'm');
    sink.warn('a.code', 'services.Web', 'm');
    sink.warn('a.code', 'services.web', 'm');
    sink.warn('a.code', 'networks.front', 'm');
    expect(sink.list().map((d) => `${d.path} ${d.code}`)).toEqual([
      'networks.front a.code',
      'services.Web a.code',
      'services.web a.code',
      'services.web.ports[10] a.code',
      'services.web.ports[10] b.code',
      'services.web.ports[2] z.code',
    ]);
  });

  it('records severities and omits an absent hint', () => {
    const sink = new DiagnosticSink();
    sink.error('e.code', 'p1', 'error message', 'Do this.');
    sink.warn('w.code', 'p2', 'warning message');
    sink.info('i.code', 'p3', 'info message');
    const [error, warning, info] = sink.list();
    expect(error).toEqual({ severity: 'error', code: 'e.code', path: 'p1', message: 'error message', hint: 'Do this.' });
    expect(warning.severity).toBe('warning');
    expect(info.severity).toBe('info');
    expect(Object.keys(warning)).not.toContain('hint');
  });

  it('reports hasErrors only when an error was recorded', () => {
    const sink = new DiagnosticSink();
    expect(sink.hasErrors()).toBe(false);
    sink.warn('w.code', 'p', 'm');
    sink.info('i.code', 'p', 'm');
    expect(sink.hasErrors()).toBe(false);
    sink.error('e.code', 'p', 'm');
    expect(sink.hasErrors()).toBe(true);
  });

  it('returns copies that do not alter the sink', () => {
    const sink = new DiagnosticSink();
    sink.warn('w.code', 'p', 'm');
    const first = sink.list();
    first[0].message = 'changed';
    first.pop();
    expect(sink.list()).toEqual([{ severity: 'warning', code: 'w.code', path: 'p', message: 'm' }]);
  });
});

const error = (index: number, hint?: string): Diagnostic => ({
  severity: 'error',
  code: 'ports.invalid',
  path: `services.web.ports[${index}]`,
  message: `port ${index} is invalid`,
  ...(hint === undefined ? {} : { hint }),
});

describe('ComposeTranslationError.fromDiagnostics (U-DIAG-01)', () => {
  it('names the file, the orchestrator and the error count, and lists each error', () => {
    const diagnostics: Diagnostic[] = [
      error(0, 'Set `x-dockflow.publish`.'),
      { severity: 'warning', code: 'security.privileged', path: 'services.web.privileged', message: 'ignored' },
      error(1),
    ];
    const err = ComposeTranslationError.fromDiagnostics('docker-compose.yml', 'k3s', diagnostics);
    expect(err.message).toBe('docker-compose.yml cannot be deployed with orchestrator: k3s (2 error(s))');
    expect(err.suggestion).toBe(
      'services.web.ports[0]: port 0 is invalid (Set `x-dockflow.publish`.)\nservices.web.ports[1]: port 1 is invalid',
    );
    expect(err.diagnostics).toBe(diagnostics);
    expect(err.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(err.name).toBe('ComposeTranslationError');
    expect(err).toBeInstanceOf(CLIError);
  });

  it('lists at most 20 errors, then the number left', () => {
    const diagnostics = Array.from({ length: 25 }, (_, i) => error(i));
    const err = ComposeTranslationError.fromDiagnostics('accessories.yml', 'k3s', diagnostics);
    const lines = (err.suggestion ?? '').split('\n');
    expect(err.message).toBe('accessories.yml cannot be deployed with orchestrator: k3s (25 error(s))');
    expect(lines).toHaveLength(21);
    expect(lines[19]).toBe('services.web.ports[19]: port 19 is invalid');
    expect(lines[20]).toBe('... and 5 more');
  });

  it('prints no remainder line with exactly 20 errors', () => {
    const err = ComposeTranslationError.fromDiagnostics('docker-compose.yml', 'k3s', Array.from({ length: 20 }, (_, i) => error(i)));
    expect((err.suggestion ?? '').split('\n')).toHaveLength(20);
  });

  it('is the class utils/errors exports', () => {
    expect(ComposeTranslationError).toBe(ErrorsComposeTranslationError);
  });
});
