/**
 * Compose linting — catches `$` placeholders Docker empties at deploy time.
 *
 * The compose file is rendered with Nunjucks, then handed to `docker stack deploy -c <file>`.
 * Docker resolves every `$VAR` and `${VAR}` from its own process environment, and Dockflow
 * exports nothing there: a placeholder silently becomes an empty string, or whatever the
 * deploy user's shell holds, and the deployment succeeds with a broken value. Only `$$`
 * stands for a literal `$`.
 *
 * A placeholder reaches the file in two ways: written in the compose file, or carried by a
 * value a template inserted — a generated password, say. The second kind is reported
 * without its text, which is part of that value.
 *
 * This module only reports; the caller decides between a warning and a hard failure.
 */

/** Values Dockflow puts at the root of the render context rather than under `current.env`. */
const ROOT_CONTEXT_VARS: Record<string, string> = {
  ENV: '{{ env }}',
  VERSION: '{{ version }}',
  BRANCH: '{{ branch }}',
  PROJECT_NAME: '{{ project_name }}',
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

export interface ShellPlaceholder {
  /** The matched text, e.g. `$APP_PORT`, `${APP_PORT}` or `${APP_PORT:-3000}`. */
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
 * Find every placeholder Docker would substitute.
 *
 * @param content    Compose file contents, rendered or raw — Nunjucks leaves `$` untouched.
 * @param knownKeys  Env keys declared in servers.yml. Matching is case-insensitive because
 *                   Dockflow lowercases env keys for the template context.
 */
export function findShellPlaceholders(
  content: string,
  knownKeys: Iterable<string> = [],
): ShellPlaceholder[] {
  const known = new Set([...knownKeys].map((key) => key.toLowerCase()));
  const found: ShellPlaceholder[] = [];

  let line = 1;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '\n') line++;
    if (char !== '$') continue;

    // `$$` is Docker's escape for a literal `$`: skip both.
    if (content[i + 1] === '$') {
      i++;
      continue;
    }

    let raw: string | undefined;
    let name: string | undefined;
    if (content[i + 1] === '{') {
      const end = content.indexOf('}', i);
      const inner = NAME.exec(content.slice(i + 2));
      if (end !== -1 && inner && !content.slice(i, end).includes('\n')) {
        raw = content.slice(i, end + 1);
        name = inner[0];
      }
    } else {
      const bare = NAME.exec(content.slice(i + 1));
      if (bare) {
        raw = `$${bare[0]}`;
        name = bare[0];
      }
    }
    if (!raw || !name) continue;

    const lower = name.toLowerCase();
    found.push({
      raw,
      name,
      line,
      suggestion: ROOT_CONTEXT_VARS[name] ?? `{{ current.env.${lower} }}`,
      declared: known.has(lower),
    });
    i += raw.length - 1;
  }

  return found;
}

/**
 * Human-readable lines describing the placeholders, one per finding.
 */
export function describeShellPlaceholders(placeholders: ShellPlaceholder[]): string[] {
  return placeholders.map(({ raw, line, suggestion, declared }) => {
    const origin = declared ? ' (declared in servers.yml)' : '';
    return `line ${line}: ${raw}${origin} — Docker replaces it when deploying, and Dockflow gives it no value. ` +
      `Use ${suggestion} for a Dockflow value, or $${raw} to keep the text as is.`;
  });
}

/**
 * Lines of the rendered file where a value a template inserted carries a placeholder.
 *
 * @param rendered          The compose file rendered with the real values.
 * @param renderedWithout   The same file rendered with every `$` stripped from the values.
 *                          What only the first holds came from a value.
 */
export function findInsertedPlaceholders(rendered: string, renderedWithout: string): number[] {
  const written = new Map<string, number>();
  for (const { raw } of findShellPlaceholders(renderedWithout)) {
    written.set(raw, (written.get(raw) ?? 0) + 1);
  }

  const lines: number[] = [];
  for (const { raw, line } of findShellPlaceholders(rendered)) {
    const left = written.get(raw) ?? 0;
    if (left > 0) {
      written.set(raw, left - 1);
    } else if (!lines.includes(line)) {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * Human-readable lines for placeholders a value brought in. The placeholder itself is not
 * shown: it is part of the value, likely a secret.
 */
export function describeInsertedPlaceholders(lines: number[]): string[] {
  return lines.map((line) =>
    `line ${line} (rendered): a value inserted by a template contains a $ that Docker will replace when deploying. ` +
    'Escape it with | replace("$", "$$").',
  );
}
