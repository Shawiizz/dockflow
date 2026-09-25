// U-DOCS-03 (design-07 14.3): every fenced `yaml` block of
// `configuration/{kubernetes,helm,volumes,orchestrator,accessories,proxy}/**/page.mdx` whose first
// line is one of the four file headers parses and validates — zod for `config.yml`/`servers.yml`/
// `dockflow.yml`, normalize+translate for a `docker-compose.yml` block on a k3s-only page (the
// `kubernetes/` and `helm/` directories: every other scanned directory covers both orchestrators, so
// its compose snippets are Swarm-valid too and are only required to parse). A block whose first
// lines carry `# dockflow-docs: invalid-example` is a deliberately-bad example and is skipped.
//
// A block is very often a fragment continuing an existing file (the page shows one new key, not a
// whole project) rather than a complete document, so the required top-level field the fragment would
// naturally omit (`project_name` for config.yml/dockflow.yml, `servers` for servers.yml/dockflow.yml)
// is filled with a placeholder before validation — every other field is still checked at full
// strictness. A compose fragment missing `image`/`build` on some service is, for the same reason,
// only parsed, never translated: `identity.missing-image` would fire on a fragment that was never
// meant to be a deployable document by itself.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as Compose from '../../../services/compose';
import { ComposeTranslationError } from '../../../services/orchestrator/diagnostics';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { renderStackArtifact, type RenderEnvironment } from '../../../services/orchestrator/kubernetes/render';
import { validateConfig, validateRootConfig, validateServersConfig } from '../../../schemas';
import { deployInput } from '../support/builders';

const REPO_DIR = resolve(import.meta.dir, '..', '..', '..', '..', '..');
const CONFIGURATION_DIR = join(REPO_DIR, 'docs', 'app', 'en', 'configuration');
const SCANNED_DIRS = ['kubernetes', 'helm', 'volumes', 'orchestrator', 'accessories', 'proxy'];
/** Directories whose pages describe k3s and nothing else (design-07 19.1's own "k3s only" callouts). */
const K3S_ONLY_DIRS = new Set(['kubernetes', 'helm']);

const HEADERS = ['# .dockflow/config.yml', '# .dockflow/servers.yml', '# dockflow.yml', '# .dockflow/docker/docker-compose.yml'] as const;
type Header = (typeof HEADERS)[number];

const INVALID_MARKER = '# dockflow-docs: invalid-example';
const REGENERATE_STEP = 'a fenced yaml block starting with one of the four headers must be a valid, standalone example';

interface ExampleBlock {
  file: string;
  /** 1-indexed line the fence opens on, for a readable failure message */
  line: number;
  header: Header;
  text: string;
}

// ---------------------------------------------------------------------------
// Collecting the pages and their blocks
// ---------------------------------------------------------------------------

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => entry.toString())
    .filter((entry) => entry.replace(/\\/g, '/').endsWith('page.mdx'))
    .map((entry) => join(dir, entry))
    .sort();
}

const FENCE_RE = /^```yaml[^\n]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

function blocksOf(file: string): ExampleBlock[] {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const blocks: ExampleBlock[] = [];
  for (const match of text.matchAll(FENCE_RE)) {
    const body = match[1];
    const lines = body.split('\n');
    const header = lines[0]?.trim();
    if (!(HEADERS as readonly string[]).includes(header)) continue;
    if (lines.slice(0, 3).some((l) => l.trim() === INVALID_MARKER)) continue;
    const line = text.slice(0, match.index).split('\n').length;
    blocks.push({ file, line, header: header as Header, text: body });
  }
  return blocks;
}

const ALL_BLOCKS: ExampleBlock[] = SCANNED_DIRS.flatMap((dir) => pageFiles(join(CONFIGURATION_DIR, dir)).flatMap(blocksOf));

// ---------------------------------------------------------------------------
// zod validation, lenient about the one top-level field a fragment omits
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const PLACEHOLDER_SERVERS = { docs_example: { role: 'manager', tags: ['production'] } };

/**
 * A fragment on a k3s-only page (`configuration/kubernetes/`, `configuration/helm/`) that sets a
 * k3s-only key (`helm:`, `proxy.manage`, ...) without repeating `orchestrator: k3s` is not missing
 * anything a reader would consider part of the example — the page has no other orchestrator to mean.
 */
function asConfigPatch(parsed: unknown, k3sOnlyPage: boolean): unknown {
  if (!isRecord(parsed)) return parsed;
  const withProject = 'project_name' in parsed ? parsed : { project_name: 'docs-example', ...parsed };
  if (!k3sOnlyPage || 'orchestrator' in withProject) return withProject;
  return { ...withProject, orchestrator: 'k3s' };
}

function asServersPatch(parsed: unknown): unknown {
  if (!isRecord(parsed)) return parsed;
  return 'servers' in parsed ? parsed : { servers: PLACEHOLDER_SERVERS, ...parsed };
}

function asRootPatch(parsed: unknown, k3sOnlyPage: boolean): unknown {
  return asServersPatch(asConfigPatch(parsed, k3sOnlyPage));
}

function describeIssues(issues: readonly { path: string; message: string }[]): string {
  return issues.map((i) => `  ${i.path}: ${i.message}`).join('\n');
}

// ---------------------------------------------------------------------------
// Compose: parse always, normalize+translate on a k3s-only page with a full service
// ---------------------------------------------------------------------------

function isK3sOnlyPage(file: string): boolean {
  const rel = file.replace(/\\/g, '/');
  return [...K3S_ONLY_DIRS].some((dir) => rel.includes(`/configuration/${dir}/`));
}

/** Every declared service names an image directly or through a build, i.e. this is not a "just this key" fragment. */
function isDeployableCompose(services: Record<string, Record<string, unknown>>): boolean {
  const keys = Object.keys(services);
  return keys.length > 0 && keys.every((key) => 'image' in services[key] || 'build' in services[key]);
}

function renderEnvironment(): RenderEnvironment {
  return {
    traits: k3sDistribution.traits,
    imageDelivery: 'none',
    extraReservedHostPorts: [{ port: 22, protocol: 'TCP', reason: 'SSH port of server_1' }],
  };
}

function translateErrors(block: ExampleBlock): string[] {
  try {
    const { artifact } = renderStackArtifact(deployInput({ compose: block.text }), renderEnvironment());
    return artifact.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.path}: ${d.message}`);
  } catch (error) {
    if (error instanceof ComposeTranslationError) return error.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.path}: ${d.message}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// One test per block
// ---------------------------------------------------------------------------

function label(block: ExampleBlock): string {
  return `${block.file.replace(/\\/g, '/').replace(`${CONFIGURATION_DIR.replace(/\\/g, '/')}/`, '')}:${block.line} ${block.header}`;
}

describe('U-DOCS-03 docs examples', () => {
  test('at least one example of each header was found (the scan is not silently empty)', () => {
    for (const header of HEADERS) {
      expect(ALL_BLOCKS.some((b) => b.header === header), `no ${header} example found under configuration/{${SCANNED_DIRS.join(',')}}`).toBeDefined();
    }
  });

  for (const block of ALL_BLOCKS) {
    test(label(block), () => {
      let parsed: unknown;
      switch (block.header) {
        case '# .dockflow/config.yml': {
          expect(() => (parsed = parseYaml(block.text)), REGENERATE_STEP).not.toThrow();
          const result = validateConfig(asConfigPatch(parsed, isK3sOnlyPage(block.file)));
          expect(result.success, result.success ? '' : describeIssues(result.error)).toBe(true);
          break;
        }
        case '# .dockflow/servers.yml': {
          expect(() => (parsed = parseYaml(block.text)), REGENERATE_STEP).not.toThrow();
          const result = validateServersConfig(asServersPatch(parsed));
          expect(result.success, result.success ? '' : describeIssues(result.error)).toBe(true);
          break;
        }
        case '# dockflow.yml': {
          expect(() => (parsed = parseYaml(block.text)), REGENERATE_STEP).not.toThrow();
          const result = validateRootConfig(asRootPatch(parsed, isK3sOnlyPage(block.file)));
          expect(result.success, result.success ? '' : describeIssues(result.error)).toBe(true);
          break;
        }
        case '# .dockflow/docker/docker-compose.yml': {
          let compose: Compose.ParsedCompose | undefined;
          expect(() => (compose = Compose.loadFromString(block.text, block.file)), REGENERATE_STEP).not.toThrow();
          if (isK3sOnlyPage(block.file) && compose && isDeployableCompose(compose.services)) {
            expect(translateErrors(block)).toEqual([]);
          }
          break;
        }
      }
    });
  }
});
