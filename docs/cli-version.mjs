/**
 * The Dockflow version the docs pin in every command that installs or runs the CLI.
 *
 * Pages write __DOCKFLOW_VERSION__ and the build writes npm's `latest` in its place
 * (cli-version-loader.cjs for the site, withVersion for llms.txt): every release deploys
 * the docs again, so their examples follow it without anyone editing them.
 * DOCKFLOW_VERSION=x.y.z overrides the lookup, to build offline.
 */

export const VERSION_PLACEHOLDER = '__DOCKFLOW_VERSION__'

export async function dockflowVersion() {
  if (process.env.DOCKFLOW_VERSION) return process.env.DOCKFLOW_VERSION
  const response = await fetch('https://registry.npmjs.org/@dockflow-tools/cli/latest')
  if (!response.ok) {
    throw new Error(
      `Cannot read the latest Dockflow version from npm (HTTP ${response.status}); ` +
        'set DOCKFLOW_VERSION=x.y.z to build without it'
    )
  }
  const { version } = await response.json()
  return version
}

/** Write `version` in place of the placeholder, in a string */
export function withVersion(text, version) {
  return text.replaceAll(VERSION_PLACEHOLDER, version)
}
