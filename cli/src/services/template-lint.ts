/**
 * Template linting — catches `current.env` references that render to nothing.
 *
 * Nunjucks renders an undefined variable as an empty string, without a word. A
 * secret that exists in CI but not where the CLI runs — absent from
 * .env.dockflow — becomes an empty value in a compose file, a hook or an
 * uploaded file, and the deploy goes through with it.
 *
 * Only references written into a file's output count. A reference guarded by
 * `default` or `or`, or only tested in a condition, is a deliberate optional
 * value and is left alone.
 *
 * This module only reports; the caller decides how to surface it.
 */

import nunjucks from 'nunjucks';

export interface UndefinedEnvReference {
  /** The key as written, e.g. `db_password` in `current.env.db_password`. */
  name: string;
  /** 1-based line number in the template. */
  line: number;
  /** A declared key that differs only by case, when there is one. */
  suggestion?: string;
}

interface TemplateNode {
  typename: string;
  lineno: number;
  fields?: string[];
  value?: unknown;
  [field: string]: unknown;
}

// Nodes under which a missing value is intended or never reaches the output.
const GUARDS = new Set(['Or', 'Compare', 'Not', 'In', 'Is']);
const DEFAULT_FILTERS = new Set(['default', 'd']);

/** The `<name>` of a `current.env.<name>` or `current.env["<name>"]` lookup, if that is what the node is. */
function envKeyOf(node: TemplateNode): string | undefined {
  if (node.typename !== 'LookupVal') return undefined;
  const target = node.target as TemplateNode | undefined;
  const key = node.val as TemplateNode | undefined;
  if (target?.typename !== 'LookupVal' || key?.typename !== 'Literal' || typeof key.value !== 'string') return undefined;

  const base = target.target as TemplateNode | undefined;
  const envKey = target.val as TemplateNode | undefined;
  return base?.typename === 'Symbol' && base.value === 'current' && envKey?.typename === 'Literal' && envKey.value === 'env'
    ? key.value
    : undefined;
}

function children(node: TemplateNode): TemplateNode[] {
  return (node.fields ?? []).flatMap((field) => {
    const value = node[field];
    if (Array.isArray(value)) return value as TemplateNode[];
    return value !== null && typeof value === 'object' ? [value as TemplateNode] : [];
  });
}

/**
 * Every `current.env` reference a template writes out whose key is not declared.
 *
 * @param envKeys  The keys of `current.env` for the server being deployed to.
 */
export function findUndefinedEnvReferences(template: string, envKeys: Iterable<string>): UndefinedEnvReference[] {
  let root: TemplateNode;
  try {
    root = (nunjucks as unknown as { parser: { parse(src: string): TemplateNode } }).parser.parse(template);
  } catch {
    // Rendering reports a broken template on its own, with a better message.
    return [];
  }

  const keys = new Set(envKeys);
  const found: UndefinedEnvReference[] = [];

  const visit = (node: TemplateNode, inOutput: boolean, guarded: boolean): void => {
    const name = envKeyOf(node);
    if (name !== undefined) {
      if (inOutput && !guarded && !keys.has(name)) {
        const lower = name.toLowerCase();
        found.push({ name, line: node.lineno + 1, suggestion: lower !== name && keys.has(lower) ? lower : undefined });
      }
      return;
    }

    const isDefault = node.typename === 'Filter' && DEFAULT_FILTERS.has(String((node.name as TemplateNode | undefined)?.value));
    const nextInOutput = inOutput || node.typename === 'Output';
    const nextGuarded = guarded || isDefault || GUARDS.has(node.typename);

    for (const child of children(node)) {
      // An inline if's condition is only tested; its branches are written out.
      const childGuarded = nextGuarded || (node.typename === 'InlineIf' && child === node.cond);
      visit(child, nextInOutput, childGuarded);
    }
  };

  visit(root, false, false);
  return found;
}

/**
 * Human-readable lines describing the references, one per finding.
 */
export function describeUndefinedEnvReferences(file: string, references: UndefinedEnvReference[], serverName: string): string[] {
  return references.map(({ name, line, suggestion }) => {
    const hint = suggestion
      ? ` Keys are lowercase: use current.env.${suggestion}.`
      : ' Declare it in servers.yml or as a secret, or give it a default.';
    return `${file}:${line}: current.env.${name} is not defined for ${serverName} and renders as an empty string.${hint}`;
  });
}
