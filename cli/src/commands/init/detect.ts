import { readFileSync } from 'fs';
import { join, basename } from 'path';

export interface DetectedName {
  name: string;
  source: string;
}

function tryReadJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tryReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export function detectProjectName(projectRoot: string): DetectedName {
  const pkg = tryReadJson(join(projectRoot, 'package.json'));
  if (typeof pkg?.name === 'string') {
    const name = pkg.name.replace(/^@[^/]+\//, '').trim();
    if (name) return { name, source: 'package.json' };
  }

  const goMod = tryReadText(join(projectRoot, 'go.mod'));
  if (goMod) {
    const name = goMod.match(/^module\s+(\S+)/m)?.[1].split('/').pop() ?? '';
    if (name) return { name, source: 'go.mod' };
  }

  const cargo = tryReadText(join(projectRoot, 'Cargo.toml'));
  if (cargo) {
    const name = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1].trim() ?? '';
    if (name) return { name, source: 'Cargo.toml' };
  }

  const pyproject = tryReadText(join(projectRoot, 'pyproject.toml'));
  if (pyproject) {
    const name = pyproject.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1].trim() ?? '';
    if (name) return { name, source: 'pyproject.toml' };
  }

  const composer = tryReadJson(join(projectRoot, 'composer.json'));
  if (typeof composer?.name === 'string') {
    const name = composer.name.split('/').pop()?.trim() ?? '';
    if (name) return { name, source: 'composer.json' };
  }

  return { name: basename(projectRoot), source: 'directory name' };
}
