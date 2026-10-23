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

declare const SHELL_COMMAND: unique symbol;

/**
 * A remote command built with `sh`. The SSH calls take only this type, so a command written as a
 * plain string, whose values nobody quoted, does not compile. At run time it is a plain string.
 */
export type ShellCommand = string & { readonly [SHELL_COMMAND]: true };

/**
 * What the user typed for the remote shell to run as it is (`dockflow ssh <env> <command>`): their
 * own shell syntax, deliberately not quoted.
 */
export function userCommand(text: string): ShellCommand {
  return text as ShellCommand;
}

/** Shell syntax the code builds itself, which `sh` inserts as it is. */
export class RawShell {
  constructor(readonly text: string) {}
}

/**
 * Marks shell syntax the code builds (a command made with `sh`, a pipe, a redirection, flags it
 * chose): `sh` inserts it unquoted. Never a value read from config, a file or a server.
 */
export function raw(text: string): RawShell {
  return new RawShell(text);
}

export type ShellValue = string | number | RawShell | readonly (string | number | RawShell)[];

function shellValue(value: ShellValue): string {
  if (value instanceof RawShell) return value.text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Not a number a shell command can take: ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return value.map(shellValue).join(' ');
  return shellQuote(value as string);
}

/**
 * A remote command whose interpolated values are all quoted: what `dir` holds in
 * sh`rm -rf ${dir}/tmp` can never become another command. A number goes in as it is, an array as
 * its elements quoted one by one, and shell syntax the code builds through `raw()`.
 */
export function sh(strings: TemplateStringsArray, ...values: ShellValue[]): ShellCommand {
  let command = strings[0];
  values.forEach((value, i) => {
    command += shellValue(value) + strings[i + 1];
  });
  return command as ShellCommand;
}
