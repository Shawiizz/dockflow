/**
 * Generates llms.txt and llms-full.txt from the Nextra docs structure.
 *
 * llms.txt  - Concise index with links to each page
 * llms-full.txt - All documentation concatenated into a single file
 *
 * Run: npx tsx scripts/generate-llms-txt.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DOCS_DIR = join(__dirname, '..', 'app');
const PUBLIC_DIR = join(__dirname, '..', 'public');
const BASE_URL = 'https://{{ current.env.docs_domain_name }}';

interface PageEntry {
  slug: string;
  title: string;
  path: string; // relative path from app/
  children?: PageEntry[];
}

// ── Structure auto-discovery ────────────────────────────────────────────────
//
// The nav order and titles live in the app/**/_meta.{ts,tsx} files — the same
// source of truth the rendered site uses. We import those modules and derive
// the page tree from them, so the llms files can never drift from the nav (no
// hand-maintained list to forget). A directory is a section only when it has
// child sub-pages; a lone `index` key (e.g. deployment/_meta.ts) is just a
// label for the page itself, not a section.

/** Locate a dir's meta module (.tsx for JSX titles, .ts otherwise). */
function findMeta(dir: string): string | null {
  for (const ext of ['tsx', 'ts']) {
    const p = join(dir, `_meta.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

async function loadMeta(dir: string): Promise<Record<string, unknown> | null> {
  const metaPath = findMeta(dir);
  if (!metaPath) return null;
  const mod = await import(pathToFileURL(metaPath).href);
  return (mod.default ?? {}) as Record<string, unknown>;
}

/** Flatten a meta title that may be a string or a JSX/React element. */
function reactText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(reactText).join('');
  if (node && typeof node === 'object') {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props && 'children' in props) return reactText(props.children);
  }
  return '';
}

/** Resolve a meta entry's display title, or null when it should be skipped. */
function metaTitle(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.display === 'hidden') return null; // e.g. the hidden home page
    if ('title' in v) return reactText(v.title).trim() || null;
  }
  return null;
}

const hasPage = (relPath: string): boolean => existsSync(join(DOCS_DIR, relPath, 'page.mdx'));

/** Build the page tree from the _meta nav files (ordered, titled, nested). */
async function buildStructure(): Promise<PageEntry[]> {
  const rootMeta = await loadMeta(DOCS_DIR);
  if (!rootMeta) throw new Error('app/_meta.{ts,tsx} not found');

  const result: PageEntry[] = [];
  for (const [slug, value] of Object.entries(rootMeta)) {
    const title = metaTitle(value);
    if (!title || !hasPage(slug)) continue;

    const childMeta = await loadMeta(join(DOCS_DIR, slug));
    const children: PageEntry[] = [];
    for (const [childSlug, childValue] of Object.entries(childMeta ?? {})) {
      if (childSlug === 'index') continue; // the section's own page, not a child
      const childTitle = metaTitle(childValue);
      const childPath = `${slug}/${childSlug}`;
      if (childTitle && hasPage(childPath)) {
        children.push({ slug: childSlug, title: childTitle, path: childPath });
      }
    }

    result.push(children.length > 0 ? { slug, title, path: slug, children } : { slug, title, path: slug });
  }
  return result;
}

/**
 * Fail loudly if a page.mdx exists on disk but is not reachable through the
 * _meta nav (so it would be silently absent from llms.txt / llms-full.txt).
 * The hidden home page (app/page.mdx) is intentionally excluded.
 */
function assertComplete(structure: PageEntry[]): void {
  const registered = new Set<string>();
  for (const entry of structure) {
    registered.add(entry.path);
    entry.children?.forEach((c) => registered.add(c.path));
  }

  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full, rel ? `${rel}/${name}` : name);
      } else if (name === 'page.mdx' && rel) {
        found.push(rel);
      }
    }
  };
  walk(DOCS_DIR, '');

  const missing = found.filter((p) => !registered.has(p));
  if (missing.length > 0) {
    throw new Error(
      `Documentation pages not reachable through the _meta nav: ${missing.join(', ')}.\n` +
      `Add them to the relevant app/**/_meta.{ts,tsx} so they appear in the site nav and the llms files.`,
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readMdx(pagePath: string): string | null {
  const filePath = join(DOCS_DIR, pagePath, 'page.mdx');
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

// ── MDX → Markdown via AST ────────────────────────────────────────────────
//
// MDX is markdown + JSX, a structured (tree) format — so we parse it to an
// mdast and transform the tree rather than running regexes over text. Code
// blocks, inline code and tables are real nodes that are never touched, so
// `{{ env }}` placeholders and `<SSH key content>` examples survive intact.
// JSX components are unwrapped (their children are kept); MDX-only nodes
// (imports, expressions, front matter) are dropped.

// One processor reused for both parsing and stringifying. remark-mdx is kept
// on the stringify side too so any unhandled MDX node serializes rather than
// crashing the build.
const mdxProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkMdx)
  .use(remarkStringify, { bullet: '-', emphasis: '_', fences: true, rule: '-' });

// Minimal structural typing for the mdast nodes we touch.
interface MdNode {
  type: string;
  name?: string;
  value?: string;
  children?: MdNode[];
  attributes?: Array<{ name?: string; value?: string | { value?: string } }>;
}

// MDX-specific nodes with no plain-markdown equivalent.
const DROP_TYPES = new Set(['yaml', 'mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression']);

/** Read a string-valued JSX attribute (e.g. name="src"). */
function stringAttr(node: MdNode, attr: string): string | undefined {
  const found = node.attributes?.find((a) => a.name === attr);
  return typeof found?.value === 'string' ? found.value : undefined;
}

/** Pull labels out of a Tabs `items={['a', 'b']}` expression attribute. */
function tabLabels(node: MdNode): string[] {
  const items = node.attributes?.find((a) => a.name === 'items');
  const expr = items && typeof items.value === 'object' ? items.value.value : undefined;
  if (!expr) return [];
  return [...expr.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
}

/** Flatten a <FileTree> into indented name lines, returned as one code node. */
function fileTreeToNodes(node: MdNode): MdNode[] {
  const lines: string[] = [];
  const walk = (el: MdNode, depth: number): void => {
    for (const child of el.children ?? []) {
      if (child.type !== 'mdxJsxFlowElement' && child.type !== 'mdxJsxTextElement') continue;
      const name = stringAttr(child, 'name');
      if (!name) continue;
      lines.push('  '.repeat(depth) + (child.name?.endsWith('Folder') ? `${name}/` : name));
      if (child.name?.endsWith('Folder')) walk(child, depth + 1);
    }
  };
  walk(node, 0);
  return lines.length > 0 ? [{ type: 'code', value: lines.join('\n') }] : [];
}

/** Transform one node into its replacement list (drop, unwrap, or keep). */
function rewriteNode(node: MdNode): MdNode[] {
  if (DROP_TYPES.has(node.type)) return [];

  if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
    const name = node.name ?? '';

    if (name === 'FileTree') return fileTreeToNodes(node);

    if (name === 'Tabs') {
      // Emit each tab's label (from items=) as a bold line, then its content,
      // so the tabbed structure stays legible once flattened.
      const labels = tabLabels(node);
      const tabs = (node.children ?? []).filter((c) => c.name === 'Tabs.Tab');
      return tabs.flatMap((tab, i) => {
        const content = rewriteChildren(tab.children ?? []);
        if (!labels[i]) return content;
        const label: MdNode = { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: labels[i] }] }] };
        return [label, ...content];
      });
    }

    // Any other component: drop the wrapper, keep its content.
    return rewriteChildren(node.children ?? []);
  }

  if (node.children) node.children = rewriteChildren(node.children);
  return [node];
}

function rewriteChildren(children: MdNode[]): MdNode[] {
  return children.flatMap(rewriteNode);
}

/** Convert MDX source to plain Markdown for the llms text files. */
function stripMdx(content: string): string {
  const tree = mdxProcessor.parse(content) as unknown as MdNode;
  tree.children = rewriteChildren(tree.children ?? []);
  return mdxProcessor.stringify(tree as never).trim();
}

function getDescription(content: string): string {
  const stripped = stripMdx(content);
  const lines = stripped.split('\n');
  let foundHeading = false;
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('#')) {
      foundHeading = true;
      descLines.length = 0; // reset for each heading until we find prose
      continue;
    }
    if (!foundHeading) continue;
    const trimmed = line.trim();
    if (!trimmed) {
      if (descLines.length > 0) break;
      continue;
    }
    // Skip non-prose lines
    if (trimmed.startsWith('```') || trimmed.startsWith('|') || trimmed.startsWith('---')) continue;
    // Skip lines that are just bold labels (e.g. "**Prerequisites:**")
    if (/^\*\*[^*]+:\*\*$/.test(trimmed)) continue;
    // Skip bare list items that are not sentences
    if (/^[-*]\s+\S+$/.test(trimmed)) continue;
    descLines.push(trimmed);
    if (descLines.length >= 2) break;
  }
  const desc = descLines.join(' ');
  return desc.length > 150 ? desc.slice(0, 147) + '...' : desc;
}

// ── Generate llms.txt ───────────────────────────────────────────────────────

function generateIndex(structure: PageEntry[]): string {
  const lines: string[] = [
    '# Dockflow',
    '',
    '> A deployment framework for Docker Swarm and k3s (Kubernetes). Single binary, SSH-only, no runtime dependencies.',
    '',
  ];

  for (const entry of structure) {
    lines.push(`## ${entry.title}`);

    if (entry.children) {
      // Section index page
      const indexContent = readMdx(entry.path);
      if (indexContent) {
        const desc = getDescription(indexContent);
        if (desc) lines.push(`- [${entry.title}](${BASE_URL}/${entry.slug}.md): ${desc}`);
      }
      for (const child of entry.children) {
        const content = readMdx(child.path);
        if (!content) continue;
        const desc = getDescription(content);
        lines.push(`- [${child.title}](${BASE_URL}/${child.path}.md): ${desc}`);
      }
    } else {
      const content = readMdx(entry.path);
      if (content) {
        const desc = getDescription(content);
        lines.push(`- [${entry.title}](${BASE_URL}/${entry.slug}.md): ${desc}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Generate llms-full.txt ──────────────────────────────────────────────────

function generateFull(structure: PageEntry[]): string {
  const sections: string[] = [
    '# Dockflow - Complete Documentation',
    '',
    '> A deployment framework for Docker Swarm and k3s (Kubernetes). Single binary, SSH-only, no runtime dependencies.',
    '',
  ];

  function addPage(entry: PageEntry) {
    const content = readMdx(entry.path);
    if (!content) return;
    sections.push('---');
    sections.push('');
    sections.push(stripMdx(content));
    sections.push('');
  }

  for (const entry of structure) {
    addPage(entry);
    if (entry.children) {
      for (const child of entry.children) {
        addPage(child);
      }
    }
  }

  return sections.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────
// Wrapped in an async function (not top-level await) so tsx can run this file
// under its CJS transform. Errors (e.g. the assertComplete guard) exit non-zero
// to fail the docs build.

async function main(): Promise<void> {
  const structure = await buildStructure();
  assertComplete(structure);
  const index = generateIndex(structure);
  const full = generateFull(structure);

  mkdirSync(PUBLIC_DIR, { recursive: true });
  writeFileSync(join(PUBLIC_DIR, 'llms.txt'), index, 'utf-8');
  writeFileSync(join(PUBLIC_DIR, 'llms-full.txt'), full, 'utf-8');

  console.log(`Generated llms.txt (${index.length} bytes)`);
  console.log(`Generated llms-full.txt (${full.length} bytes)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
