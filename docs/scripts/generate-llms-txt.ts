/**
 * Generates llms.txt and llms-full.txt from the Nextra docs structure.
 *
 * llms.txt  - Concise index with links to each page
 * llms-full.txt - All documentation concatenated into a single file
 *
 * Run: npx tsx scripts/generate-llms-txt.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DOCS_DIR = join(__dirname, '..', 'app');
const PUBLIC_DIR = join(__dirname, '..', 'public');
const BASE_URL = 'https://{{ current.env.docs_domain_name }}';

// ── Structure definition matching _meta.ts files ────────────────────────────

interface PageEntry {
  slug: string;
  title: string;
  path: string; // relative path from app/
  children?: PageEntry[];
}

const structure: PageEntry[] = [
  {
    slug: 'getting-started',
    title: 'Getting Started',
    path: 'getting-started',
  },
  {
    slug: 'configuration',
    title: 'Configuration',
    path: 'configuration',
    children: [
      { slug: 'connection', title: 'Connection', path: 'configuration/connection' },
      { slug: 'servers', title: 'Servers Configuration', path: 'configuration/servers' },
      { slug: 'environment', title: 'Environment Variables', path: 'configuration/environment' },
      { slug: 'docker-compose', title: 'Docker Compose', path: 'configuration/docker-compose' },
      { slug: 'accessories', title: 'Accessories (Databases, Caches)', path: 'configuration/accessories' },
      { slug: 'build-strategy', title: 'Build Strategy', path: 'configuration/build-strategy' },
      { slug: 'registry', title: 'Docker Registry', path: 'configuration/registry' },
      { slug: 'templates', title: 'Templates', path: 'configuration/templates' },
      { slug: 'hooks', title: 'Hooks', path: 'configuration/hooks' },
      { slug: 'multi-host', title: 'Multi-Host Deployment', path: 'configuration/multi-host' },
      { slug: 'config-file', title: 'Configuration File', path: 'configuration/config-file' },
    ],
  },
  {
    slug: 'deployment',
    title: 'Deployment',
    path: 'deployment',
    children: [
      { slug: 'swarm', title: 'Docker Swarm', path: 'deployment/swarm' },
    ],
  },
  { slug: 'cli', title: 'CLI Commands', path: 'cli' },
  { slug: 'advanced', title: 'Advanced Usage', path: 'advanced' },
  { slug: 'ai', title: 'AI Integration', path: 'ai' },
  { slug: 'examples', title: 'Examples', path: 'examples' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function readMdx(pagePath: string): string | null {
  const filePath = join(DOCS_DIR, pagePath, 'page.mdx');
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

/** Strip MDX front matter and JSX imports/components, keep markdown content */
function stripMdx(content: string): string {
  let result = content;
  // Remove front matter
  result = result.replace(/^---[\s\S]*?---\n*/m, '');
  // Remove import statements
  result = result.replace(/^import\s+.*$/gm, '');
  // Remove JSX block components (e.g. <Steps>...</Steps>, <Tabs>...</Tabs>)
  result = result.replace(/<[A-Z][\w.]*[\s\S]*?<\/[A-Z][\w.]*>/g, '');
  // Remove self-closing JSX (e.g. <Component /> or <br/>)
  result = result.replace(/<[A-Za-z][\w.]*\s*[^>]*\/>/g, '');
  // Remove remaining opening/closing JSX/HTML tags
  result = result.replace(/<\/?[A-Za-z][\w.]*(\s[^>]*)?>/g, '');
  // Remove JSX expressions like {props.something}
  result = result.replace(/\{[^}]*\}/g, '');
  // Remove export statements
  result = result.replace(/^export\s+.*$/gm, '');
  // Remove fenced code blocks
  result = result.replace(/^```[\s\S]*?^```/gm, '');
  // Clean up excess blank lines
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
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

function generateIndex(): string {
  const lines: string[] = [
    '# Dockflow',
    '',
    '> A powerful deployment framework that simplifies Docker deployments to remote servers using Docker Swarm.',
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

function generateFull(): string {
  const sections: string[] = [
    '# Dockflow - Complete Documentation',
    '',
    '> A powerful deployment framework that simplifies Docker deployments to remote servers using Docker Swarm.',
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

const index = generateIndex();
const full = generateFull();

writeFileSync(join(PUBLIC_DIR, 'llms.txt'), index, 'utf-8');
writeFileSync(join(PUBLIC_DIR, 'llms-full.txt'), full, 'utf-8');

console.log(`Generated llms.txt (${index.length} bytes)`);
console.log(`Generated llms-full.txt (${full.length} bytes)`);
