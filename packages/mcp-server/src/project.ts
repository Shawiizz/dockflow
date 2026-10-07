import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname, parse as parsePath } from 'path';

export interface ProjectConfigResult {
  layout: 'flat' | 'standard' | 'none';
  root: string;
  files: { path: string; content: string }[];
}

function findProjectRoot(startDir: string): { root: string; layout: 'flat' | 'standard' | 'none' } {
  let dir = startDir;
  const { root } = parsePath(dir);

  while (true) {
    if (existsSync(join(dir, 'dockflow.yml'))) return { root: dir, layout: 'flat' };
    if (existsSync(join(dir, '.dockflow'))) return { root: dir, layout: 'standard' };
    if (dir === root) break;
    dir = dirname(dir);
  }

  return { root: startDir, layout: 'none' };
}

/** The first candidate that is a regular file; one that cannot be read counts as absent */
function readFirst(root: string, candidates: string[]): { path: string; content: string } | null {
  for (const candidate of candidates) {
    try {
      const path = join(root, candidate);
      if (statSync(path).isFile()) return { path: candidate, content: readFileSync(path, 'utf-8') };
    } catch {
      continue;
    }
  }
  return null;
}

// The files of cli/src/utils/config.ts `getLayout`, in its lookup order. Only configuration is
// returned: .env.dockflow holds the SSH connection strings and is never read.
const DOCKER_DIR = '.dockflow/docker';
const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml'];

export function readProjectConfig(cwd: string): ProjectConfigResult {
  const { root, layout } = findProjectRoot(cwd);

  if (layout === 'none') {
    return { layout: 'none', root, files: [] };
  }

  const candidates: string[][] =
    layout === 'flat'
      ? [
          ['dockflow.yml'],
          [...COMPOSE_NAMES, ...COMPOSE_NAMES.map((name) => `${DOCKER_DIR}/${name}`)],
          ['accessories.yml', 'accessories.yaml', `${DOCKER_DIR}/accessories.yml`],
        ]
      : [
          ['.dockflow/config.yml'],
          ['.dockflow/servers.yml'],
          COMPOSE_NAMES.map((name) => `${DOCKER_DIR}/${name}`),
          [`${DOCKER_DIR}/accessories.yml`],
        ];

  const files: { path: string; content: string }[] = [];
  for (const names of candidates) {
    const file = readFirst(root, names);
    if (file) files.push(file);
  }

  return { layout, root, files };
}

export function formatProjectConfig(result: ProjectConfigResult): string {
  if (result.layout === 'none') {
    return 'No Dockflow configuration found in this directory or any parent directory.\n\nTo get started, see get_examples for a template that fits your project.';
  }

  const lines: string[] = [
    `Layout: **${result.layout}** (project root: \`${result.root}\`)\n`,
  ];

  if (result.files.length === 0) {
    lines.push('No configuration files found.');
  } else {
    for (const file of result.files) {
      const ext = file.path.split('.').pop() ?? 'yaml';
      const lang = ext === 'yml' || ext === 'yaml' ? 'yaml' : 'text';
      lines.push(`### \`${file.path}\`\n\`\`\`${lang}\n${file.content}\n\`\`\`\n`);
    }
  }

  return lines.join('\n');
}
