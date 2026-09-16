/**
 * Built-in plugins, shipped inside the CLI binary.
 *
 * Each entry maps a plugin name to its files, keyed by their path inside the
 * plugin. Adding a file means adding an import below: bun build --compile only
 * embeds statically analyzable `with { type: 'file' }` imports.
 */

import nginxManifest from './nginx/plugin.yml' with { type: 'file' };
import nginxVhost from './nginx/vhost.conf' with { type: 'file' };
import systemdManifest from './systemd/plugin.yml' with { type: 'file' };

export type BuiltinPluginFiles = Record<string, string>;

export const BUILTIN_PLUGINS: Record<string, BuiltinPluginFiles> = {
  nginx: {
    'plugin.yml': nginxManifest,
    'vhost.conf': nginxVhost,
  },
  systemd: {
    'plugin.yml': systemdManifest,
  },
};
