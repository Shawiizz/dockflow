import { readFileSync } from 'fs';
import { join, basename } from 'path';

// Must match the schema regex: lowercase alphanum + hyphens, no leading/trailing hyphens
const VALID_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of invalid chars → single hyphen
    .replace(/^-+|-+$/g, '');    // strip leading/trailing hyphens
}

export interface DetectedName {
  name: string;
  source: string;
  /** true when the raw value had to be sanitized to match the schema regex */
  sanitized: boolean;
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

function found(raw: string, source: string): DetectedName {
  const name = VALID_NAME.test(raw) ? raw : sanitize(raw);
  return { name, source, sanitized: name !== raw };
}

export function detectProjectName(projectRoot: string): DetectedName {
  const pkg = tryReadJson(join(projectRoot, 'package.json'));
  if (typeof pkg?.name === 'string') {
    const raw = pkg.name.replace(/^@[^/]+\//, '').trim();
    if (raw) return found(raw, 'package.json');
  }

  const goMod = tryReadText(join(projectRoot, 'go.mod'));
  if (goMod) {
    const raw = goMod.match(/^module\s+(\S+)/m)?.[1].split('/').pop() ?? '';
    if (raw) return found(raw, 'go.mod');
  }

  const cargo = tryReadText(join(projectRoot, 'Cargo.toml'));
  if (cargo) {
    const raw = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1].trim() ?? '';
    if (raw) return found(raw, 'Cargo.toml');
  }

  const pyproject = tryReadText(join(projectRoot, 'pyproject.toml'));
  if (pyproject) {
    const raw = pyproject.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1].trim() ?? '';
    if (raw) return found(raw, 'pyproject.toml');
  }

  const composer = tryReadJson(join(projectRoot, 'composer.json'));
  if (typeof composer?.name === 'string') {
    const raw = composer.name.split('/').pop()?.trim() ?? '';
    if (raw) return found(raw, 'composer.json');
  }

  return found(basename(projectRoot), 'directory name');
}
