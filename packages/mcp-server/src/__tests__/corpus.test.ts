import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { type ConfigFileType, validateFile } from '../validate.js';

// cli/src/__tests__/mcp-corpus.test.ts checks the same rows against the CLI schemas. Agreeing with
// cliValid here is what proves validate_config neither refuses a file the CLI accepts nor accepts
// one it refuses.

interface CorpusRow {
  name: string;
  file: ConfigFileType;
  yaml: string;
  cliValid: boolean;
  mcpErrors: string[];
}

const rows = parseYaml(readFileSync(new URL('../../test-corpus/configs.yaml', import.meta.url), 'utf8')) as CorpusRow[];

describe('test-corpus/configs.yaml', () => {
  it('holds accepted and refused rows of every file kind, with unique names', () => {
    for (const file of ['config', 'servers', 'root'] as const) {
      assert.ok(rows.some((row) => row.file === file && row.cliValid), `an accepted ${file} row`);
      assert.ok(rows.some((row) => row.file === file && !row.cliValid), `a refused ${file} row`);
    }
    assert.equal(new Set(rows.map((row) => row.name)).size, rows.length);
  });

  for (const row of rows) {
    it(row.name, () => {
      const result = validateFile(row.yaml, row.file);
      assert.equal(result.valid, row.cliValid, result.errors.join('\n'));
      for (const fragment of row.mcpErrors) {
        assert.ok(result.errors.some((line) => line.includes(fragment)), `"${fragment}" in\n${result.errors.join('\n')}`);
      }
    });
  }
});
