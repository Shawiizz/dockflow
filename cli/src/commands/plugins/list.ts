/**
 * Plugins list command - Show the plugins a project can use
 */

import type { Command } from 'commander';
import { getProjectRoot } from '../../utils/config';
import { colors, printBlank, printDim, printError, printJSON, printNote, printRaw, printSection } from '../../utils/output';
import { withErrorHandler } from '../../utils/errors';
import { listPlugins, type PluginListing } from '../../services/plugin';
import { DOCKFLOW_PLUGINS_DIR } from '../../constants';

type Input = PluginListing['inputs'][number];

function traitsOf(input: Input): string {
  return [
    input.type === 'file' ? 'file' : null,
    input.required ? 'required' : null,
    input.default !== undefined ? `default: ${input.default}` : null,
  ].filter(Boolean).join(', ');
}

export function registerPluginsListCommand(parent: Command): void {
  parent
    .command('list')
    .alias('ls')
    .description('List built-in plugins and the project\'s own')
    .option('-j, --json', 'Output as JSON')
    .action(withErrorHandler(async (options: { json?: boolean }) => {
      const plugins = await listPlugins(getProjectRoot());

      if (options.json) {
        printJSON({ plugins });
        return;
      }

      // One set of column widths for every plugin, so the inputs line up across the list.
      const inputs = plugins.flatMap((p) => p.inputs);
      const nameWidth = Math.max(0, ...inputs.map((i) => i.name.length)) + 2;
      const traitsWidth = Math.max(0, ...inputs.map((i) => traitsOf(i).length)) + 2;

      printBlank();
      printSection('Plugins');
      printBlank();

      for (const plugin of plugins) {
        const origin = plugin.origin === 'builtin' ? colors.dim('built-in') : colors.dim(plugin.location);
        const shadowed = plugin.shadowed ? colors.warning(`  replaced by ${DOCKFLOW_PLUGINS_DIR}/${plugin.name}`) : '';
        printRaw(`${colors.bold(`● ${plugin.name}`)}  ${origin}${shadowed}`);

        if (plugin.error) {
          printError(`  ${plugin.error}`);
        } else {
          if (plugin.description) printDim(`  ${plugin.description}`);
          for (const input of plugin.inputs) {
            printRaw(`    ${colors.info(input.name.padEnd(nameWidth))}${colors.dim(traitsOf(input).padEnd(traitsWidth))}${input.description ?? ''}`);
          }
        }
        printBlank();
      }

      printNote(
        'plugins:\n  - use: <name>\n    with:\n      <input>: <value>',
        'Use a plugin in .dockflow/config.yml',
      );
    }));
}
