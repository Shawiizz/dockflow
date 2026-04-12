import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { confirmPrompt, multiselectPrompt, selectPrompt } from '../../utils/prompts';
import { printInfo, printSuccess, printWarning } from '../../utils/output';
import { loadTemplate, renderCI } from './templates';

export type CIPlatform = 'github' | 'gitlab' | 'bitbucket';
export type CIJob = 'build' | 'deploy';

async function safeWriteFile(
  filePath: string,
  content: string,
  displayPath: string,
): Promise<void> {
  if (existsSync(filePath)) {
    printWarning(`${chalk.cyan(displayPath)} already exists`);
    const overwrite = await confirmPrompt({
      message: `Overwrite ${chalk.bold(displayPath)}?`,
      initialValue: false,
    });
    if (!overwrite) {
      printInfo(`Skipped ${chalk.dim(displayPath)}`);
      return;
    }
  }
  writeFileSync(filePath, content, 'utf-8');
  printSuccess(chalk.cyan(displayPath));
}

async function setupGithub(projectRoot: string, jobs: CIJob[], version: string): Promise<void> {
  const workflowDir = join(projectRoot, '.github', 'workflows');
  if (!existsSync(workflowDir)) mkdirSync(workflowDir, { recursive: true });

  for (const job of jobs) {
    const content = renderCI(await loadTemplate(`github-${job}.yml`), { version });
    await safeWriteFile(
      join(workflowDir, `dockflow-${job}.yml`),
      content,
      `.github/workflows/dockflow-${job}.yml`,
    );
  }
}

async function setupGitlab(projectRoot: string, jobs: CIJob[], version: string): Promise<void> {
  const stagesBlock = `stages:\n${jobs.map(j => `  - ${j}`).join('\n')}`;
  const jobBlocks = await Promise.all(
    jobs.map(job =>
      loadTemplate(`gitlab-${job}.yml`).then(t => renderCI(t, { version }).trimEnd()),
    ),
  );

  const content = [stagesBlock, ...jobBlocks].join('\n\n') + '\n';
  await safeWriteFile(join(projectRoot, '.gitlab-ci.yml'), content, '.gitlab-ci.yml');
}

async function setupBitbucket(projectRoot: string, jobs: CIJob[], version: string): Promise<void> {
  // Bitbucket uses a single bitbucket-pipelines.yml — merge selected job sections
  const sections = await Promise.all(
    jobs.map(job =>
      loadTemplate(`bitbucket-${job}.yml`).then(t => renderCI(t, { version })),
    ),
  );

  // Each template is a full YAML document; we extract the `pipelines:` block from each
  // and merge them under a shared header. Only the first template contributes the header.
  const [first, ...rest] = sections;
  const header = first.split('pipelines:')[0];
  const allPipelineBlocks = sections
    .map(s => s.split('pipelines:')[1] ?? '')
    .join('');

  const content = `${header}pipelines:${allPipelineBlocks}`;
  await safeWriteFile(join(projectRoot, 'bitbucket-pipelines.yml'), content, 'bitbucket-pipelines.yml');
}

export async function runCISetup(projectRoot: string, version: string): Promise<void> {
  const platform = await selectPrompt<CIPlatform>({
    message: 'CI/CD platform:',
    options: [
      { value: 'github',    label: 'GitHub Actions',     hint: '.github/workflows/' },
      { value: 'gitlab',    label: 'GitLab CI',          hint: '.gitlab-ci.yml' },
      { value: 'bitbucket', label: 'Bitbucket Pipelines', hint: 'bitbucket-pipelines.yml' },
    ],
  });

  const jobs = await multiselectPrompt<CIJob>({
    message: 'Workflows to generate:',
    options: [
      { value: 'build',  label: 'Build',  hint: 'builds & pushes images on every branch push' },
      { value: 'deploy', label: 'Deploy', hint: 'deploys to server on tag push (e.g. 1.0.0)' },
    ],
    initialValues: ['build', 'deploy'],
    required: true,
  });

  if (platform === 'github') {
    await setupGithub(projectRoot, jobs, version);
  } else if (platform === 'gitlab') {
    await setupGitlab(projectRoot, jobs, version);
  } else {
    await setupBitbucket(projectRoot, jobs, version);
  }
}
