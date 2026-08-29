/**
 * Compose linting — catches placeholders Dockflow never fills in.
 *
 * The compose file is rendered with Nunjucks, then handed to `docker stack deploy -c <file>`.
 * Docker resolves `${...}` from its own process environment, and Dockflow exports nothing
 * there: no env file, no shell variables over SSH. A shell-style placeholder therefore
 * silently becomes an empty string, and the deployment succeeds with a broken value.
 *
 * This module only reports; the caller decides between a warning and a hard failure.
 */

/** Docker's own escape for a literal `$`. `$${VAR}` is deliberate, so it is ignored. */
const SHELL_PLACEHOLDER = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g;

/** Values Dockflow puts at the root of the render context rather than under `current.env`. */
const ROOT_CONTEXT_VARS: Record<string, string> = {
  ENV: '{{ env }}',
  VERSION: '{{ version }}',
  BRANCH: '{{ branch }}',
  PROJECT_NAME: '{{ project_name }}',
};

export interface ShellPlaceholder {
  /** The matched text, e.g. `${APP_PORT}` or `${APP_PORT:-3000}`. */
  raw: string;
  /** The variable name, e.g. `APP_PORT`. */
  name: string;
  /** 1-based line number in the compose file. */
  line: number;
  /** Nunjucks equivalent to use instead. */
  suggestion: string;
  /** Whether the name matches a key declared in servers.yml. */
  declared: boolean;
}

/**
 * Find every shell-style placeholder in a compose file.
 *
 * @param content    Compose file contents, rendered or raw — Nunjucks leaves `${...}` untouched.
 * @param knownKeys  Env keys declared in servers.yml. Matching is case-insensitive because
 *                   Dockflow lowercases env keys for the template context.
 */
export function findShellPlaceholders(
  content: string,
  knownKeys: Iterable<string> = [],
): ShellPlaceholder[] {
  const known = new Set([...knownKeys].map((key) => key.toLowerCase()));
  const found: ShellPlaceholder[] = [];

  SHELL_PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SHELL_PLACEHOLDER.exec(content)) !== null) {
    const [raw, name] = match;
    const lower = name.toLowerCase();

    found.push({
      raw,
      name,
      line: content.slice(0, match.index).split('\n').length,
      suggestion: ROOT_CONTEXT_VARS[name] ?? `{{ current.env.${lower} }}`,
      declared: known.has(lower),
    });
  }

  return found;
}

/**
 * Human-readable lines describing the placeholders, one per finding.
 */
export function describeShellPlaceholders(placeholders: ShellPlaceholder[]): string[] {
  return placeholders.map(({ raw, line, suggestion, declared }) => {
    const origin = declared ? ' (declared in servers.yml)' : '';
    return `line ${line}: ${raw}${origin} — Dockflow does not substitute this. Use ${suggestion} instead.`;
  });
}
