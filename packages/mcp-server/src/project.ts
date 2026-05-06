import { existsSync, readFileSync } from 'fs';
import { join, dirname, parse as parsePath } from 'path';

export interface ProjectConfigResult {
  layout: 'rootless' | 'standard' | 'none';
  root: string;
  files: { path: string; content: string }[];
}

function findProjectRoot(startDir: string): { root: string; layout: 'rootless' | 'standard' | 'none' } {
  let dir = startDir;
  const { root } = parsePath(dir);

  while (true) {
    if (existsSync(join(dir, 'dockflow.yml'))) return { root: dir, layout: 'rootless' };
    if (existsSync(join(dir, '.dockflow'))) return { root: dir, layout: 'standard' };
    if (dir === root) break;
    dir = dirname(dir);
  }

  return { root: startDir, layout: 'none' };
}

function readIfExists(path: string): { path: string; content: string } | null {
  if (!existsSync(path)) return null;
  return { path, content: readFileSync(path, 'utf-8') };
}

export function readProjectConfig(cwd: string): ProjectConfigResult {
  const { root, layout } = findProjectRoot(cwd);

  if (layout === 'none') {
    return { layout: 'none', root, files: [] };
  }

  const files: { path: string; content: string }[] = [];

  if (layout === 'rootless') {
    const f = readIfExists(join(root, 'dockflow.yml'));
    if (f) files.push({ path: 'dockflow.yml', content: f.content });

    const compose =
      readIfExists(join(root, 'docker-compose.yml')) ??
      readIfExists(join(root, 'docker-compose.yaml'));
    if (compose) files.push({ path: compose.path.replace(root + '/', '').replace(root + '\\', ''), content: compose.content });
  } else {
    for (const name of ['config.yml', 'servers.yml']) {
      const f = readIfExists(join(root, '.dockflow', name));
      if (f) files.push({ path: `.dockflow/${name}`, content: f.content });
    }
    const compose =
      readIfExists(join(root, '.dockflow', 'docker', 'docker-compose.yml')) ??
      readIfExists(join(root, '.dockflow', 'docker', 'docker-compose.yaml'));
    if (compose) {
      const rel = compose.path.replace(root + '/', '').replace(root + '\\', '').replace(/\\/g, '/');
      files.push({ path: rel, content: compose.content });
    }
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
