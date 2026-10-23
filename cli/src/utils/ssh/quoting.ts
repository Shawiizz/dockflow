/**
 * Shell quoting for values interpolated into remote command strings.
 */

/**
 * Make a value safe to sit *inside* single quotes the caller writes.
 *
 * It adds no quotes of its own — the apostrophe is the only character that can
 * break out of single quoting, so that is all it handles. Reach for shellQuote
 * unless you are quoting only part of a token, such as a path that must keep a
 * live glob next to it.
 *
 * POSIX shells cannot escape an apostrophe inside single quotes, hence the
 * close-escape-reopen dance: `it's` becomes `it'\''s`.
 */
export function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * A value as one complete, quoted shell token — spaces and operators inert.
 *
 * This is the default choice for interpolating a value into a command string.
 */
export function shellQuote(value: string): string {
  return `'${escapeSingleQuotes(value)}'`;
}
