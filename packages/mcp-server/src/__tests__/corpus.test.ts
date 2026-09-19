import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { validateFile, type ConfigFileType, type Orchestrator } from '../validate.js';

// The same rows are checked against the CLI schemas by cli/src/__tests__/kubernetes/mcp/corpus.test.ts:
// agreeing with cliValid here is what proves validate_config enforces no rule the CLI does not.

interface CorpusRow {
  name: string;
  file: ConfigFileType;
  orchestrator?: Orchestrator;
  yaml: string;
  cliValid: boolean;
  mcpErrors: string[];
}

const rows = parseYaml(readFileSync(new URL('../../test-corpus/configs.yaml', import.meta.url), 'utf8')) as CorpusRow[];

describe('test-corpus/configs.yaml', () => {
  it('holds accepted and refused rows of every file kind', () => {
    for (const file of ['config', 'servers', 'root'] as const) {
      assert.ok(rows.some((r) => r.file === file && r.cliValid), `accepted ${file}`);
      assert.ok(rows.some((r) => r.file === file && !r.cliValid), `refused ${file}`);
    }
    assert.equal(new Set(rows.map((r) => r.name)).size, rows.length, 'row names are unique');
  });

  for (const row of rows) {
    it(row.name, () => {
      const result = validateFile(row.yaml, row.file, { orchestrator: row.orchestrator });
      assert.equal(result.valid, row.cliValid, result.errors.join('\n'));
      if (row.cliValid) assert.deepEqual(row.mcpErrors, [], 'an accepted row lists no error');
      for (const fragment of row.mcpErrors) {
        assert.ok(result.errors.some((line) => line.includes(fragment)), `"${fragment}" in\n${result.errors.join('\n')}`);
      }
    });
  }
});
