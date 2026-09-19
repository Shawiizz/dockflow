// U-DOCS-01 (design-07 14.3): the generated compose support region of the docs equals the
// renderer's output, plus the generator's own contract (design-07 19.4, WORK-PACKAGES P48).

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ServiceExtensionSchema, VolumeExtensionSchema } from '../../../schemas/compose-extension.schema';
import { KEY_AREAS, KEY_POLICIES, type KeyPolicy } from '../../../services/orchestrator/kubernetes/normalize/keys';

interface RegionMarkers {
  begin: string;
  end: string;
}

interface GeneratorEnv {
  composeSupportPage: string;
  kubernetesPage: string;
  repoDir: string;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** The exports of cli/scripts/gen-compose-support.ts this file uses. */
interface Generator {
  COMPOSE_SUPPORT_MARKERS: RegionMarkers;
  X_DOCKFLOW_MARKERS: RegionMarkers;
  COMPOSE_SUPPORT_PAGE: string;
  extractRegion(page: string, markers: RegionMarkers): string | null;
  replaceRegion(page: string, markers: RegionMarkers, body: string): string | null;
  mdxCell(text: string): string;
  renderComposeSupport(policies: readonly KeyPolicy[], spec?: { commit: string; date: string }): string;
  renderXDockflowReference(serviceSchema: z.core.$ZodType, volumeSchema: z.core.$ZodType): string;
  main(argv: readonly string[], env?: GeneratorEnv): number;
}

// Loaded by URL: tsconfig's rootDir is src/, so a static import of scripts/ is a TS6059 error.
const GENERATOR_PATH = join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'gen-compose-support.ts');
const generator = (await import(pathToFileURL(GENERATOR_PATH).href)) as Generator;
const {
  COMPOSE_SUPPORT_MARKERS,
  COMPOSE_SUPPORT_PAGE,
  X_DOCKFLOW_MARKERS,
  extractRegion,
  main,
  mdxCell,
  renderComposeSupport,
  renderXDockflowReference,
  replaceRegion,
} = generator;

const REGENERATE = 'Run: bun run scripts/gen-compose-support.ts';

test('the generator exports what this file uses', () => {
  const exports: Record<string, unknown> = { ...generator };
  for (const name of ['extractRegion', 'replaceRegion', 'mdxCell', 'renderComposeSupport', 'renderXDockflowReference', 'main']) {
    expect(typeof exports[name], name).toBe('function');
  }
  for (const name of ['COMPOSE_SUPPORT_MARKERS', 'X_DOCKFLOW_MARKERS']) {
    expect(Object.keys(exports[name] ?? {}).sort(), name).toEqual(['begin', 'end']);
  }
  expect(COMPOSE_SUPPORT_PAGE.split('\\').join('/')).toEndWith('docs/app/en/configuration/kubernetes/compose-support/page.mdx');
});

function policy(overrides: Partial<KeyPolicy>): KeyPolicy {
  return {
    path: 'services.*.example',
    policy: 'translate',
    table: 'T',
    whole: false,
    freeform: false,
    handler: 'identity',
    codes: [],
    area: 'identity-image',
    swarm: 'supported',
    k3s: 'Translated',
    ...overrides,
  };
}

function tableRows(body: string): string[] {
  return body.split('\n').filter((line) => line.startsWith('| `'));
}

/** Rows of the table under `### <title>`. */
function section(body: string, title: string): string[] {
  const start = body.indexOf(`### ${title}\n`);
  if (start < 0) return [];
  const next = body.indexOf('\n### ', start + 1);
  return tableRows(body.slice(start, next < 0 ? undefined : next));
}

describe('U-DOCS-01 compose support page', () => {
  test('the committed compose-support region equals renderComposeSupport(KEY_POLICIES)', () => {
    const page = readFileSync(COMPOSE_SUPPORT_PAGE, 'utf8');
    const region = extractRegion(page, COMPOSE_SUPPORT_MARKERS);
    expect(region, `${COMPOSE_SUPPORT_PAGE} has no compose-support region. ${REGENERATE}`).not.toBeNull();
    expect(region, `The compose support table is stale. ${REGENERATE}`).toBe(renderComposeSupport(KEY_POLICIES));
  });
});

describe('renderComposeSupport', () => {
  const body = renderComposeSupport(KEY_POLICIES);

  test('one row per registry entry, grouped by area in KEY_AREAS order', () => {
    expect(tableRows(body)).toHaveLength(KEY_POLICIES.length);
    const headings = body
      .split('\n')
      .filter((line) => line.startsWith('### '))
      .map((line) => line.slice(4));
    const used = KEY_AREAS.filter(({ area }) => KEY_POLICIES.some((entry) => entry.area === area)).map(({ title }) => title);
    expect(headings).toEqual(used);
    for (const { area, title } of KEY_AREAS) {
      const expected = KEY_POLICIES.filter((entry) => entry.area === area).map((entry) => `\`${entry.path}\``);
      expect(section(body, title).map((row) => row.split(' | ')[0].slice(2))).toEqual(expected);
    }
  });

  test('the Swarm and k3s columns come from the policy', () => {
    const rows = tableRows(renderComposeSupport([policy({ swarm: 'ignored', k3s: 'Ignored with warning', note: 'Why' })]));
    expect(rows).toEqual(['| `services.*.example` | Ignored | Ignored with warning | Why |']);
    const rejected = tableRows(renderComposeSupport([policy({ swarm: 'rejected', k3s: 'Rejected' })]));
    expect(rejected).toEqual(['| `services.*.example` | Rejected | Rejected |  |']);
  });

  test('names the pinned Compose specification', () => {
    const text = renderComposeSupport([policy({})], { commit: '0123456789abcdef', date: '2030-01-02' });
    expect(text.split('\n')[0]).toBe(
      'Generated from the key registry of this Dockflow release, which follows the Compose specification of 2030-01-02 (upstream commit `0123456`).',
    );
  });

  test('appends the x-dockflow keys the note does not already name', () => {
    const ports = policy({
      note: 'Published ports use `x-dockflow.publish`',
      xDockflow: ['publish', 'lb_source_ranges'],
    });
    expect(tableRows(renderComposeSupport([ports]))[0]).toEndWith(
      '| Published ports use `x-dockflow.publish`; see also `x-dockflow.lb_source_ranges` |',
    );
    const bare = policy({ xDockflow: ['kind'] });
    expect(tableRows(renderComposeSupport([bare]))[0]).toEndWith('| See also `x-dockflow.kind` |');
    const prefix = policy({ note: 'Uses `x-dockflow.probes_extra`', xDockflow: ['probes'] });
    expect(tableRows(renderComposeSupport([prefix]))[0]).toEndWith('; see also `x-dockflow.probes` |');
  });

  test('refuses a policy whose area has no table', () => {
    const stray = { ...policy({}), area: 'nowhere' } as unknown as KeyPolicy;
    expect(() => renderComposeSupport([stray])).toThrow('services.*.example has area nowhere');
  });

  test('is deterministic', () => {
    expect(renderComposeSupport(KEY_POLICIES)).toBe(body);
  });
});

describe('mdxCell', () => {
  test('escapes MDX and table syntax outside code spans', () => {
    expect(mdxCell('a | b {x} <y> *z* [l] ~t & _u_ \\')).toBe('a \\| b \\{x\\} \\<y\\> \\*z\\* \\[l\\] \\~t \\& \\_u\\_ \\\\');
  });

  test('keeps code spans literal except for pipes', () => {
    expect(mdxCell('use `{% include %}` or `<<: *common` and `a|b`')).toBe('use `{% include %}` or `<<: *common` and `a\\|b`');
    expect(mdxCell('double ``a ` b`` span')).toBe('double ``a ` b`` span');
  });

  test('escapes an unmatched backtick and joins lines', () => {
    expect(mdxCell('one ` two')).toBe('one \\` two');
    expect(mdxCell('  first\n  second \r\n third ')).toBe('first second third');
  });
});

describe('renderXDockflowReference', () => {
  const body = renderXDockflowReference(ServiceExtensionSchema, VolumeExtensionSchema);
  const rowFor = (key: string): string | undefined => tableRows(body).find((row) => row.startsWith(`| \`${key}\` |`));

  test('lists every field of both schemas with its .describe() text', () => {
    const service = section(body, 'Service keys');
    const volume = section(body, 'Volume keys');
    for (const key of Object.keys(ServiceExtensionSchema.shape)) {
      expect(service.some((row) => row.startsWith(`| \`${key}\` |`))).toBe(true);
    }
    for (const key of Object.keys(VolumeExtensionSchema.shape)) {
      expect(volume.some((row) => row.startsWith(`| \`${key}\` |`))).toBe(true);
    }
    const kindDescription = ServiceExtensionSchema.shape.kind.description;
    expect(kindDescription).toBeString();
    expect(rowFor('kind')).toBe(`| \`kind\` | one of \`deployment\`, \`statefulset\` | ${mdxCell(kindDescription ?? '')} |`);
    expect(body).toContain(mdxCell(ServiceExtensionSchema.description ?? ''));
    expect(body).toContain(mdxCell(VolumeExtensionSchema.description ?? ''));
  });

  test('descends into nested mappings and list items', () => {
    expect(section(body, 'Service keys').map((row) => row.split(' | ')[0].slice(2))).toEqual([
      '`kind`',
      '`publish`',
      '`lb_source_ranges`',
      '`probes`',
      '`probes.use`',
      '`probes.http`',
      '`probes.http.path`',
      '`probes.http.port`',
      '`probes.http.scheme`',
      '`probes.tcp`',
      '`probes.tcp.port`',
      '`node_selector`',
      '`tolerations`',
      '`tolerations[].key`',
      '`tolerations[].operator`',
      '`tolerations[].value`',
      '`tolerations[].effect`',
      '`tolerations[].toleration_seconds`',
      '`fs_group`',
      '`pod_labels`',
    ]);
    expect(section(body, 'Volume keys').map((row) => row.split(' | ')[0].slice(2))).toEqual([
      '`size`',
      '`storage_class`',
      '`access_mode`',
      '`per_replica`',
    ]);
  });

  test('types carry ranges, formats and required fields', () => {
    const type = (key: string): string | undefined => rowFor(key)?.split(' | ')[1];
    expect(type('probes.http.port')).toBe('integer from 1 to 65535, required');
    expect(type('probes.http.path')).toBe('string, required');
    expect(type('probes.http.scheme')).toBe('one of `HTTP`, `HTTPS`');
    expect(type('fs_group')).toBe('integer from 0 to 2147483647');
    expect(type('tolerations[].toleration_seconds')).toBe('integer, at least 0');
    expect(type('lb_source_ranges')).toBe('list of IPv4 CIDR or IPv6 CIDR');
    expect(type('tolerations')).toBe('list of mappings');
    expect(type('node_selector')).toBe('mapping of string to string');
    expect(type('probes')).toBe('mapping');
    expect(type('per_replica')).toBe('boolean');
  });

  test('refuses a field without a .describe() text (R-S1-03)', () => {
    const service = z.object({ ok: z.boolean().optional().describe('Described.'), bare: z.string().optional() }).describe('Service.');
    const volume = z.object({}).describe('Volume.');
    expect(() => renderXDockflowReference(service, volume)).toThrow('ServiceExtensionSchema field bare has no .describe() text');
    const nested = z.object({ outer: z.object({ inner: z.number() }).optional().describe('Outer.') }).describe('Service.');
    expect(() => renderXDockflowReference(nested, volume)).toThrow('field outer.inner has no .describe() text');
    const described = z.object({ ok: z.boolean().optional().describe('Described.') }).describe('Service.');
    expect(() => renderXDockflowReference(described, z.object({}))).toThrow('VolumeExtensionSchema has no .describe() text');
  });

  test('refuses a zod type it cannot describe', () => {
    const service = z.object({ when: z.date().optional().describe('A date.') }).describe('Service.');
    expect(() => renderXDockflowReference(service, z.object({}).describe('Volume.'))).toThrow('does not know zod type date');
  });
});

describe('regions', () => {
  const markers = { begin: '{/* begin */}', end: '{/* end */}' };

  test('replaceRegion rewrites only the region and keeps CRLF line endings', () => {
    const page = '# Title\r\n\r\n{/* begin */}\r\nold\r\n{/* end */}\r\n\r\nafter\r\n';
    const replaced = replaceRegion(page, markers, 'new\nbody');
    expect(replaced).toBe('# Title\r\n\r\n{/* begin */}\r\n\r\nnew\r\nbody\r\n\r\n{/* end */}\r\n\r\nafter\r\n');
    expect(extractRegion(replaced ?? '', markers)).toBe('new\nbody');
  });

  test('a page without exactly one pair of markers has no region', () => {
    expect(replaceRegion('no markers', markers, 'x')).toBeNull();
    expect(extractRegion('{/* begin */} only', markers)).toBeNull();
    expect(extractRegion('{/* end */}\n{/* begin */}', markers)).toBeNull();
    expect(extractRegion('{/* begin */}\n\na\n\n{/* end */}\n{/* begin */}\n\nb\n\n{/* end */}', markers)).toBeNull();
  });

  test('extractRegion keeps extra framing so a hand-edited region is reported stale', () => {
    expect(extractRegion('{/* begin */}\n\n\nbody\n\n{/* end */}', markers)).toBe('\nbody');
    expect(extractRegion('{/* begin */}\nbody\n{/* end */}', markers)).toBe('\nbody\n');
  });
});

describe('main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dockflow-gen-compose-support-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const skeleton = (markers: typeof COMPOSE_SUPPORT_MARKERS): string => `# Page\n\n${markers.begin}\nstale\n${markers.end}\n\nfooter\n`;

  function setup(name: string, kubernetes: string | null): { env: GeneratorEnv; output: string[]; composePage: string; kubePage: string } {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    const composePage = join(root, 'compose-support.mdx');
    const kubePage = join(root, 'kubernetes.mdx');
    writeFileSync(composePage, skeleton(COMPOSE_SUPPORT_MARKERS));
    if (kubernetes !== null) writeFileSync(kubePage, kubernetes);
    const output: string[] = [];
    const env: GeneratorEnv = {
      composeSupportPage: composePage,
      kubernetesPage: kubePage,
      repoDir: root,
      cwd: root,
      out: (text) => output.push(text),
      err: (text) => output.push(text),
    };
    return { env, output, composePage, kubePage };
  }

  test('--check reports a stale region with a diff, a write fixes it, --check then passes', () => {
    const { env, output, composePage } = setup('compose-only', null);
    expect(main(['--check'], env)).toBe(1);
    expect(output.join('\n')).toContain('differs  ');
    expect(output.join('\n')).toContain('-4: stale');
    expect(output.join('\n')).toContain(REGENERATE);
    expect(readFileSync(composePage, 'utf8')).toBe(skeleton(COMPOSE_SUPPORT_MARKERS));

    expect(main([], env)).toBe(0);
    const written = readFileSync(composePage, 'utf8');
    expect(extractRegion(written, COMPOSE_SUPPORT_MARKERS)).toBe(renderComposeSupport(KEY_POLICIES));
    expect(written.startsWith('# Page\n\n')).toBe(true);
    expect(written.endsWith('\n\nfooter\n')).toBe(true);

    output.length = 0;
    expect(main(['--check'], env)).toBe(0);
    expect(output.some((line) => line.startsWith('ok       '))).toBe(true);
    expect(output.some((line) => line.includes('x-dockflow region was not generated'))).toBe(true);
  });

  test('the default Kubernetes page gets its x-dockflow region when it carries the markers', () => {
    const { env, kubePage } = setup('with-kubernetes', skeleton(X_DOCKFLOW_MARKERS));
    expect(main(['--check'], env)).toBe(1);
    expect(main([], env)).toBe(0);
    expect(extractRegion(readFileSync(kubePage, 'utf8'), X_DOCKFLOW_MARKERS)).toBe(
      renderXDockflowReference(ServiceExtensionSchema, VolumeExtensionSchema),
    );
    expect(main(['--check'], env)).toBe(0);
  });

  test('a default Kubernetes page without markers is skipped; a named one is required', () => {
    const { env, output } = setup('unmarked-kubernetes', '# Kubernetes\n');
    expect(main([], env)).toBe(0);
    expect(output.some((line) => line.includes('has no {/* x-dockflow:begin */}'))).toBe(true);
    expect(main(['--check', '--kubernetes-page', 'kubernetes.mdx'], env)).toBe(1);
    expect(main(['--kubernetes-page=missing.mdx'], env)).toBe(1);
    expect(output.some((line) => line.startsWith('missing  '))).toBe(true);
  });

  test('a compose-support page without a region fails', () => {
    const { env, output, composePage } = setup('no-region', null);
    writeFileSync(composePage, '# Page\n');
    expect(main([], env)).toBe(1);
    expect(output.some((line) => line.startsWith('no region '))).toBe(true);
  });

  test('usage errors exit 2', () => {
    const { env, output } = setup('usage', null);
    expect(main(['--bogus'], env)).toBe(2);
    expect(main(['--kubernetes-page'], env)).toBe(2);
    expect(main(['--kubernetes-page', 'a', '--kubernetes-page', 'b'], env)).toBe(2);
    expect(output.join('\n')).toContain('Unknown argument --bogus');
    expect(main(['--help'], env)).toBe(0);
  });
});
