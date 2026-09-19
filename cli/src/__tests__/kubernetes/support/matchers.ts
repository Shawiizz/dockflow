// Assertion helpers shared by the Kubernetes suite: diagnostics lists (the row runners' contract of
// design-07 4.1), CLI errors (class, exit code, message, suggestion) and recorded command shapes.

import type { Diagnostic, DiagnosticSeverity, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import type { Result } from '../../../types/result';
import { CLIError, type ErrorCode } from '../../../utils/errors';
import type { RecordedHelmCall } from '../fakes/fake-helm-executor';
import { type ArgMatcher, matchArgs, type RecordedKubeCall, renderArgs } from '../fakes/fake-kube-executor';

type TextMatcher = string | RegExp;

function textMatches(matcher: TextMatcher, text: string | undefined): boolean {
  if (text === undefined) return false;
  return typeof matcher === 'string' ? matcher === text : matcher.test(text);
}

function show(matcher: TextMatcher | undefined): string {
  if (matcher === undefined) return '(any)';
  return typeof matcher === 'string' ? JSON.stringify(matcher) : String(matcher);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface ExpectedDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  path: string;
  message?: TextMatcher;
  hint?: TextMatcher;
}

function describeDiagnostic(d: Pick<Diagnostic, 'severity' | 'code' | 'path'>): string {
  return `${d.severity} ${d.code} at ${d.path === '' ? '(root)' : d.path}`;
}

function sameIdentity(expected: ExpectedDiagnostic, actual: Diagnostic): boolean {
  return expected.severity === actual.severity && expected.code === actual.code && expected.path === actual.path;
}

/**
 * Every expected diagnostic is present, with its message and hint when given. Unless `exact`, extra
 * `info` diagnostics are tolerated and extra warnings or errors fail (design-07 4.1).
 */
export function expectDiagnostics(
  actual: readonly Diagnostic[] | DiagnosticSink,
  expected: readonly ExpectedDiagnostic[],
  options: { exact?: boolean } = {},
): void {
  const list = Array.isArray(actual) ? (actual as readonly Diagnostic[]) : (actual as DiagnosticSink).list();
  const problems: string[] = [];
  for (const want of expected) {
    const found = list.find((d) => sameIdentity(want, d));
    if (!found) {
      problems.push(`missing: ${describeDiagnostic(want)}`);
      continue;
    }
    if (want.message !== undefined && !textMatches(want.message, found.message)) {
      problems.push(`${describeDiagnostic(want)}: message ${JSON.stringify(found.message)} does not match ${show(want.message)}`);
    }
    if (want.hint !== undefined && !textMatches(want.hint, found.hint)) {
      problems.push(`${describeDiagnostic(want)}: hint ${JSON.stringify(found.hint ?? null)} does not match ${show(want.hint)}`);
    }
  }
  for (const d of list) {
    if (expected.some((want) => sameIdentity(want, d))) continue;
    if (options.exact || d.severity !== 'info') problems.push(`unexpected: ${describeDiagnostic(d)}: ${d.message}`);
  }
  if (problems.length > 0) {
    const listed = list.map((d) => `    ${describeDiagnostic(d)}: ${d.message}`);
    throw new Error(`Diagnostics differ:\n  ${problems.join('\n  ')}\n  actual list:\n${listed.join('\n') || '    (none)'}`);
  }
}

// ---------------------------------------------------------------------------
// CLI errors
// ---------------------------------------------------------------------------

export interface ExpectedCliError<E extends CLIError> {
  /** the class, e.g. DeployError; default CLIError */
  type?: abstract new (...args: never[]) => E;
  code?: ErrorCode;
  message?: TextMatcher;
  /** null: the error must carry no suggestion */
  suggestion?: TextMatcher | null;
}

function isFailedResult(value: unknown): value is { success: false; error: unknown } {
  return typeof value === 'object' && value !== null && 'success' in value && (value as Result<unknown, unknown>).success === false;
}

async function caught(subject: unknown): Promise<unknown> {
  if (subject instanceof Error) return subject;
  if (isFailedResult(subject)) return subject.error;
  try {
    const value = typeof subject === 'function' ? await (subject as () => unknown)() : await subject;
    if (isFailedResult(value)) return value.error;
    if (value instanceof Error) return value;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a CLI error, but nothing was thrown and no failed Result was returned');
}

/**
 * `subject`: an error, a failed Result, a promise, or a function (sync or async) that must throw,
 * reject or return a failed Result. Returns the error for further assertions.
 */
export async function expectCliError<E extends CLIError = CLIError>(subject: unknown, expected: ExpectedCliError<E>): Promise<E> {
  const error = await caught(subject);
  const type = expected.type ?? CLIError;
  if (!(error instanceof type) || !(error instanceof CLIError)) {
    const name = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`Expected a ${type.name}, got ${name}`);
  }
  const problems: string[] = [];
  if (expected.code !== undefined && error.code !== expected.code) problems.push(`code ${error.code}, expected ${expected.code}`);
  if (expected.message !== undefined && !textMatches(expected.message, error.message)) {
    problems.push(`message ${JSON.stringify(error.message)} does not match ${show(expected.message)}`);
  }
  if (expected.suggestion === null && error.suggestion !== undefined) {
    problems.push(`suggestion ${JSON.stringify(error.suggestion)} where none was expected`);
  } else if (expected.suggestion !== undefined && expected.suggestion !== null && !textMatches(expected.suggestion, error.suggestion)) {
    problems.push(`suggestion ${JSON.stringify(error.suggestion ?? null)} does not match ${show(expected.suggestion)}`);
  }
  if (problems.length > 0) throw new Error(`${error.name} differs:\n  ${problems.join('\n  ')}`);
  return error as E;
}

// ---------------------------------------------------------------------------
// Command shapes
// ---------------------------------------------------------------------------

export interface ExpectedCommand {
  /** argv after the global flags (kubectl) or after the helm binary */
  args?: readonly ArgMatcher[];
  /** the full command string the real builder produced */
  command?: TextMatcher;
  /** kubectl only; null: no namespace */
  namespace?: string | null;
  mutating?: boolean;
  stdin?: TextMatcher;
}

type CommandSubject = string | readonly string[] | RecordedKubeCall | RecordedHelmCall;

interface CommandFacts {
  args: readonly string[] | null;
  command: string | null;
  namespace: string | null | undefined;
  mutating: boolean | undefined;
  stdin: string | undefined;
}

function factsOf(subject: CommandSubject): CommandFacts {
  if (typeof subject === 'string') return { args: null, command: subject, namespace: undefined, mutating: undefined, stdin: undefined };
  if (Array.isArray(subject)) return { args: subject as readonly string[], command: null, namespace: undefined, mutating: undefined, stdin: undefined };
  if ('call' in (subject as object)) {
    const kube = subject as RecordedKubeCall;
    return {
      args: kube.call.args,
      command: kube.commandString,
      namespace: kube.call.namespace ?? null,
      mutating: kube.call.mutating,
      stdin: kube.stdinText,
    };
  }
  const helm = subject as RecordedHelmCall;
  return { args: helm.args, command: helm.commandString, namespace: undefined, mutating: helm.mutating, stdin: helm.stdin };
}

/**
 * A recorded kubectl or helm call (or a bare argv or command string) has the expected shape;
 * `ANY`/`REST` and regexes work as in KubeStep rows. An argv array is shorthand for `{args}`.
 */
export function expectCommandShape(subject: CommandSubject, expected: ExpectedCommand | readonly ArgMatcher[]): void {
  const want: ExpectedCommand = Array.isArray(expected) ? { args: expected as readonly ArgMatcher[] } : (expected as ExpectedCommand);
  const facts = factsOf(subject);
  const problems: string[] = [];
  if (want.args !== undefined) {
    if (facts.args === null) problems.push('args were expected, but the subject is a command string');
    else if (!matchArgs(want.args, facts.args)) {
      problems.push(`args ${renderArgs(facts.args)}\n    expected ${renderArgs(want.args)}`);
    }
  }
  if (want.command !== undefined && !textMatches(want.command, facts.command ?? undefined)) {
    problems.push(`command ${facts.command === null ? '(none)' : JSON.stringify(facts.command)}\n    expected ${show(want.command)}`);
  }
  if (want.namespace !== undefined && facts.namespace !== want.namespace) {
    problems.push(`namespace ${String(facts.namespace)}, expected ${String(want.namespace)}`);
  }
  if (want.mutating !== undefined && facts.mutating !== want.mutating) {
    problems.push(`mutating ${String(facts.mutating)}, expected ${want.mutating}`);
  }
  if (want.stdin !== undefined && !textMatches(want.stdin, facts.stdin)) {
    problems.push(`stdin ${JSON.stringify(facts.stdin ?? null)} does not match ${show(want.stdin)}`);
  }
  if (problems.length > 0) throw new Error(`Command shape differs:\n  ${problems.join('\n  ')}`);
}
