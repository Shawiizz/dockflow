import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, parse as parsePath, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { stubTemplates } from './validate.js';

// Only configuration is returned: .env.dockflow and Helm values files may hold secrets, so they
// are never read.

export type ProjectLayout = 'flat' | 'standard' | 'none';

export interface ProjectFile {
  /** Path relative to the project root, with forward slashes */
  path: string;
  content: string;
}

export interface HelmReleaseSummary {
  name: string;
  role: 'app' | 'accessory';
}

export interface ProjectConfigResult {
  layout: ProjectLayout;
  root: string;
  files: ProjectFile[];
  /** Declared in the configuration, `swarm` when absent; null without a readable configuration */
  orchestrator: 'swarm' | 'k3s' | null;
  helmReleases: HelmReleaseSummary[];
  hasCompose: boolean;
}

function findProjectRoot(startDir: string): { root: string; layout: ProjectLayout } {
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

/** The first candidate that is a regular file, relative to root */
function readFirst(root: string, candidates: string[]): ProjectFile | null {
  for (const candidate of candidates) {
    const path = join(root, candidate);
    if (existsSync(path) && statSync(path).isFile()) {
      return { path: relative(root, path).replace(/\\/g, '/'), content: readFileSync(path, 'utf-8') };
    }
  }
  return null;
}

function describeConfig(content: string | undefined): Pick<ProjectConfigResult, 'orchestrator' | 'helmReleases'> {
  if (content === undefined) return { orchestrator: null, helmReleases: [] };
  let doc: unknown;
  try {
    doc = parseYaml(stubTemplates(content));
  } catch {
    return { orchestrator: null, helmReleases: [] };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { orchestrator: null, helmReleases: [] };
  const config = doc as Record<string, unknown>;

  const orchestrator = config.orchestrator === 'k3s' ? 'k3s' : 'swarm';
  const helm = typeof config.helm === 'object' && config.helm !== null ? (config.helm as Record<string, unknown>) : {};
  const releases: unknown[] = Array.isArray(helm.releases) ? helm.releases : [];
  const helmReleases: HelmReleaseSummary[] = [];
  for (const release of releases) {
    if (typeof release !== 'object' || release === null) continue;
    const { name, role } = release as Record<string, unknown>;
    if (typeof name === 'string') helmReleases.push({ name, role: role === 'accessory' ? 'accessory' : 'app' });
  }
  return { orchestrator, helmReleases };
}

export function readProjectConfig(cwd: string): ProjectConfigResult {
  const { root, layout } = findProjectRoot(cwd);

  if (layout === 'none') {
    return { layout, root, files: [], orchestrator: null, helmReleases: [], hasCompose: false };
  }

  const files: ProjectFile[] = [];
  const add = (file: ProjectFile | null): ProjectFile | null => {
    if (file) files.push(file);
    return file;
  };

  // Same lookup order as the CLI: the flat layout falls back to .dockflow/docker/
  const dockerDir = ['.dockflow', 'docker'];
  let config: ProjectFile | null;
  let compose: ProjectFile | null;
  if (layout === 'flat') {
    config = add(readFirst(root, ['dockflow.yml']));
    compose = add(readFirst(root, ['docker-compose.yml', 'docker-compose.yaml', join(...dockerDir, 'docker-compose.yml'), join(...dockerDir, 'docker-compose.yaml')]));
    add(readFirst(root, ['accessories.yml', 'accessories.yaml', join(...dockerDir, 'accessories.yml'), join(...dockerDir, 'accessories.yaml')]));
  } else {
    config = add(readFirst(root, [join('.dockflow', 'config.yml')]));
    add(readFirst(root, [join('.dockflow', 'servers.yml')]));
    compose = add(readFirst(root, [join(...dockerDir, 'docker-compose.yml'), join(...dockerDir, 'docker-compose.yaml')]));
    add(readFirst(root, [join(...dockerDir, 'accessories.yml'), join(...dockerDir, 'accessories.yaml')]));
  }

  return { layout, root, files, ...describeConfig(config?.content), hasCompose: compose !== null };
}

function describeOrchestrator(result: ProjectConfigResult): string[] {
  if (result.orchestrator === null) return [];
  if (result.orchestrator === 'swarm') return ['Orchestrator: **swarm** (Docker Swarm)\n'];

  const lines = [
    'Orchestrator: **k3s** (Kubernetes): each environment is one namespace, `dockflow-<project>-<env>`, shared by the app and its accessories.',
  ];
  if (result.helmReleases.length > 0) {
    const releases = result.helmReleases.map((r) => `${r.name} (${r.role})`).join(', ');
    lines.push(`Helm releases: ${releases}.`);
  }
  if (!result.hasCompose && result.helmReleases.some((r) => r.role === 'app')) {
    lines.push('No compose file: a Helm-only project, deploys apply the Helm releases only.');
  }
  lines.push('');
  return lines;
}

export function formatProjectConfig(result: ProjectConfigResult): string {
  if (result.layout === 'none') {
    return 'No Dockflow configuration found in this directory or any parent directory.\n\nTo get started, see get_examples for a template that fits your project.';
  }

  const lines: string[] = [
    `Layout: **${result.layout}** (project root: \`${result.root}\`)\n`,
    ...describeOrchestrator(result),
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
