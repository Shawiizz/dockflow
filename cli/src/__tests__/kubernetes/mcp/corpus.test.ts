import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { k3sTopologyIssues, type TopologyServer } from '../../../schemas/servers.schema';
import {
  type ValidationIssue,
  validateConfig,
  validateRootConfig,
  validateServersConfig,
} from '../../../schemas/validation';
import { M } from '../../../services/orchestrator/messages';
import type { Result } from '../../../types';

// U-MCP-01: the corpus the MCP validator is tested against carries the CLI's verdict. Each row is
// checked here as `dockflow validate` checks the file: the zod schema, then for orchestrator: k3s
// the topology rules of every environment. Every message fragment the MCP test expects must be
// printed by the CLI too, so both tools are pinned to the same strings.

type FileKind = 'config' | 'servers' | 'root';

interface CorpusRow {
  name: string;
  file: FileKind;
  orchestrator?: 'swarm' | 'k3s';
  yaml: string;
  cliValid: boolean;
  mcpErrors: string[];
}

interface CliVerdict {
  valid: boolean;
  /** What the CLI prints: `<path>: <message>` for schema issues, topology messages as they are */
  lines: string[];
}

const CORPUS_PATH = join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'mcp-server', 'test-corpus', 'configs.yaml');
const rows = parseYaml(readFileSync(CORPUS_PATH, 'utf8')) as CorpusRow[];

interface Parsed {
  orchestrator?: 'swarm' | 'k3s';
  servers?: Record<string, TopologyServer>;
}

function schemaResult(file: FileKind, data: unknown): Result<Parsed, ValidationIssue[]> {
  if (file === 'config') return validateConfig(data);
  if (file === 'servers') return validateServersConfig(data);
  return validateRootConfig(data);
}

function cliVerdict(row: CorpusRow): CliVerdict {
  const result = schemaResult(row.file, parseYaml(row.yaml));
  if (!result.success) {
    return { valid: false, lines: result.error.map((issue) => `${issue.path}: ${issue.message}`) };
  }

  const orchestrator = row.file === 'servers' ? row.orchestrator : result.data.orchestrator;
  const servers = result.data.servers;
  if (orchestrator !== 'k3s' || servers === undefined) return { valid: true, lines: [] };

  const environments = [...new Set(Object.values(servers).flatMap((server) => server.tags))];
  const lines = [...new Set(environments.flatMap((env) => k3sTopologyIssues(servers, env).map((issue) => issue.message)))];
  return { valid: lines.length === 0, lines };
}

describe('U-MCP-01 packages/mcp-server/test-corpus/configs.yaml', () => {
  it('is a list of well-formed rows', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['config', 'servers', 'root']).toContain(row.file);
      expect(typeof row.yaml).toBe('string');
      expect(typeof row.cliValid).toBe('boolean');
      expect(Array.isArray(row.mcpErrors)).toBe(true);
      if (row.orchestrator !== undefined) expect(row.file).toBe('servers');
    }
  });

  for (const row of rows) {
    it(row.name, () => {
      const verdict = cliVerdict(row);
      // The lines ride along so a failure shows what the CLI printed
      expect({ valid: verdict.valid, lines: verdict.lines }).toMatchObject({ valid: row.cliValid });
      for (const fragment of row.mcpErrors) {
        expect(verdict.lines.some((line) => line.includes(fragment))).toBe(true);
      }
    });
  }

  it('pins the k3s topology rules and the Helm and proxy rules with the shared constants', () => {
    const fragments = rows.flatMap((row) => row.mcpErrors);
    const expected = [
      M.managerCount('production', 2),
      M.duplicateNode('web_1', 'web-1', 'web-1'),
      M.privateHostIpv6K3s('main'),
      M.helmRequiresK3s,
      M.remoteBuildK3s,
      M.proxyKeyRequiresK3s('proxy.manage'),
      M.privateHostIp,
      M.labelKeyReserved,
    ];
    for (const message of expected) {
      expect(fragments.some((fragment) => fragment.includes(message))).toBe(true);
    }
  });
});
