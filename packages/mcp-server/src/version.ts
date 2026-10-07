/**
 * The Dockflow CLI version the examples pin: npm's latest, read once per process, as the docs
 * do when they build. Examples write __DOCKFLOW_VERSION__ wherever they install or run the CLI.
 */

const VERSION_PLACEHOLDER = '__DOCKFLOW_VERSION__';
/** Offline, an example still shows where the version goes rather than taking whatever is latest */
const UNKNOWN_VERSION = '<version>';

let latest: Promise<string> | undefined;

export function cliVersion(): Promise<string> {
  latest ??= fetch('https://registry.npmjs.org/@dockflow-tools/cli/latest')
    .then((res) => (res.ok ? (res.json() as Promise<{ version?: unknown }>) : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => (typeof body.version === 'string' ? body.version : UNKNOWN_VERSION))
    .catch(() => UNKNOWN_VERSION);
  return latest;
}

/** `text` with the current CLI version in place of the placeholder */
export async function withCliVersion(text: string): Promise<string> {
  return text.includes(VERSION_PLACEHOLDER) ? text.replaceAll(VERSION_PLACEHOLDER, await cliVersion()) : text;
}
