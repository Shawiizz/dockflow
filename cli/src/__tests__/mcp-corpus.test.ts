import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type ValidationIssue,
  validateConfig,
  validateRootConfig,
  validateServersConfig,
} from '../schemas/validation';
import type { Result } from '../types';

// packages/mcp-server validates the same files with its own rules. Each row of its corpus carries
// the verdict of the schemas below; its test checks the MCP validator against that verdict, this
// one checks the verdict against the schemas, so neither validator can drift alone.

type FileKind = 'config' | 'servers' | 'root';

interface CorpusRow {
  name: string;
  file: FileKind;
  yaml: string;
  cliValid: boolean;
  mcpErrors: string[];
}

const CORPUS_PATH = join(import.meta.dir, '..', '..', '..', 'packages', 'mcp-server', 'test-corpus', 'configs.yaml');
const rows = parseYaml(readFileSync(CORPUS_PATH, 'utf8')) as CorpusRow[];

function validate(file: FileKind, data: unknown): Result<unknown, ValidationIssue[]> {
  if (file === 'config') return validateConfig(data);
  if (file === 'servers') return validateServersConfig(data);
  return validateRootConfig(data);
}

/** What `dockflow validate` prints for each issue */
function issueLines(row: CorpusRow): { valid: boolean; lines: string[] } {
  const result = validate(row.file, parseYaml(row.yaml));
  if (result.success) return { valid: true, lines: [] };
  return { valid: false, lines: result.error.map((issue) => `${issue.path}: ${issue.message}`) };
}

describe('packages/mcp-server/test-corpus/configs.yaml', () => {
  it('holds accepted and refused rows of every file kind, with unique names', () => {
    for (const file of ['config', 'servers', 'root'] as const) {
      expect(rows.some((row) => row.file === file && row.cliValid)).toBe(true);
      expect(rows.some((row) => row.file === file && !row.cliValid)).toBe(true);
    }
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
  });

  for (const row of rows) {
    it(row.name, () => {
      const { valid, lines } = issueLines(row);
      expect({ valid, lines }).toMatchObject({ valid: row.cliValid });
      if (row.cliValid) expect(row.mcpErrors).toEqual([]);
      for (const fragment of row.mcpErrors) {
        expect(lines.some((line) => line.includes(fragment))).toBe(true);
      }
    });
  }
});
