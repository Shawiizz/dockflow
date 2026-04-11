import type { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { getProjectRoot } from '../../utils/config';
import { confirmPrompt } from '../../utils/prompts';
import {
  printBlank,
  printInfo,
  printIntro,
  printNote,
  printOutro,
  printSection,
  printSuccess,
  printWarning,
} from '../../utils/output';
import { withErrorHandler } from '../../utils/errors';
import { DOCKFLOW_VERSION } from '../../constants';
import { detectProjectName } from './detect';
import { loadTemplate, render } from './templates';
import { runCISetup } from './ci';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize .dockflow project structure')
    .action(
      withErrorHandler(async () => {
        printIntro(chalk.bold('Dockflow Init'));
        printBlank();

        const projectRoot = getProjectRoot();
        const dockflowDir = join(projectRoot, '.dockflow');

        if (existsSync(dockflowDir)) {
          printWarning(`${chalk.cyan('.dockflow/')} already exists in this project`);
          const overwrite = await confirmPrompt({
            message: 'Overwrite existing configuration?',
            initialValue: false,
          });
          if (!overwrite) {
            printInfo('Initialization cancelled');
            return;
          }
        }

        const { name: projectName, source } = detectProjectName(projectRoot);
        printInfo(
          `Project name ${chalk.bold.cyan(projectName)} ${chalk.dim(`(from ${source})`)}`,
        );

        printBlank();
        printSection('Scaffolding project structure');

        for (const dir of [dockflowDir, join(dockflowDir, 'docker')]) {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        }

        const ctx = { project_name: projectName };

        writeFileSync(join(dockflowDir, 'config.yml'), render(await loadTemplate('config.yml'), ctx), 'utf-8');
        printSuccess(chalk.cyan('.dockflow/config.yml'));

        writeFileSync(join(dockflowDir, 'servers.yml'), render(await loadTemplate('servers.yml'), ctx), 'utf-8');
        printSuccess(chalk.cyan('.dockflow/servers.yml'));

        writeFileSync(join(dockflowDir, 'docker', 'docker-compose.yml'), render(await loadTemplate('docker-compose.yml'), ctx), 'utf-8');
        printSuccess(chalk.cyan('.dockflow/docker/docker-compose.yml'));

        const gitignorePath = join(projectRoot, '.gitignore');
        const entry = '.env.dockflow\n';
        if (existsSync(gitignorePath)) {
          const existing = readFileSync(gitignorePath, 'utf-8');
          if (!existing.includes('.env.dockflow')) {
            const separator = existing.endsWith('\n') ? '' : '\n';
            writeFileSync(gitignorePath, existing + separator + entry, 'utf-8');
            printSuccess(chalk.cyan('.gitignore') + chalk.dim(' (updated)'));
          }
        } else {
          writeFileSync(gitignorePath, entry, 'utf-8');
          printSuccess(chalk.cyan('.gitignore'));
        }

        printBlank();
        const setupCI = await confirmPrompt({
          message: 'Set up CI/CD workflows?',
          initialValue: true,
        });

        if (setupCI) {
          printBlank();
          printSection('CI/CD setup');
          await runCISetup(projectRoot, DOCKFLOW_VERSION);
        }

        printBlank();
        printNote(
          [
            `${chalk.bold('1.')} Review ${chalk.cyan('.dockflow/config.yml')} — check project name and options`,
            `${chalk.bold('2.')} Edit ${chalk.cyan('.dockflow/servers.yml')} — add your server host`,
            `${chalk.bold('3.')} Configure ${chalk.cyan('.dockflow/docker/docker-compose.yml')} — define your stack`,
            `${chalk.bold('4.')} Run ${chalk.bold('dockflow setup')} to provision your server`,
            `${chalk.bold('5.')} Add a ${chalk.cyan('CONNECTION')} secret to your CI/CD platform`,
            `${chalk.bold('6.')} Push a tag to trigger your first deployment`,
          ].join('\n'),
          'Next steps',
        );

        printOutro(chalk.green('Project initialized successfully!'));
      }),
    );
}
