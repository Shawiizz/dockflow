#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = 'https://dockflow.shawiizz.dev';

// ── Documentation cache ─────────────────────────────────────────────────────

let cachedIndex: string | null = null;
let cachedFull: string | null = null;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

async function getIndex(): Promise<string> {
  if (!cachedIndex) {
    cachedIndex = await fetchText(`${BASE_URL}/llms.txt`);
  }
  return cachedIndex;
}

async function getFull(): Promise<string> {
  if (!cachedFull) {
    cachedFull = await fetchText(`${BASE_URL}/llms-full.txt`);
  }
  return cachedFull;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface DocSection {
  title: string;
  path: string;
  content: string;
}

function parseSections(full: string): DocSection[] {
  const sections: DocSection[] = [];
  const parts = full.split(/^---$/m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const headingMatch = trimmed.match(/^#\s+(.+)/m);
    if (!headingMatch) continue;

    const title = headingMatch[1].trim();
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-');

    sections.push({ title, path: slug, content: trimmed });
  }

  return sections;
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'dockflow',
  version: '1.0.0',
});

server.registerTool('list_pages', {
  description: 'List all available Dockflow documentation pages with descriptions',
}, async () => {
  const index = await getIndex();
  return { content: [{ type: 'text', text: index }] };
});

server.registerTool('search_docs', {
  description: 'Search Dockflow documentation for a specific topic or keyword',
  inputSchema: {
    query: z.string().describe('Search query (e.g. "docker compose", "hooks", "multi-host", "cli", "configuration")'),
    max_results: z.number().optional().default(5).describe('Maximum number of results to return'),
  },
}, async ({ query, max_results }) => {
  const full = await getFull();
  const sections = parseSections(full);
  const lower = query.toLowerCase();
  const terms = lower.split(/\s+/).filter(Boolean);

  const results = sections
    .map(section => {
      const lowerContent = section.content.toLowerCase();
      const lowerTitle = section.title.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (lowerTitle.includes(term)) score += 10;
        score += lowerContent.split(term).length - 1;
      }
      return { section, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max_results)
    .map(({ section }) => section);

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No results found for "${query}".` }] };
  }

  const output = results
    .map((r, i) => `## ${i + 1}. ${r.title}\n\n${r.content}`)
    .join('\n\n---\n\n');

  return { content: [{ type: 'text', text: output }] };
});

server.registerTool('get_page', {
  description: 'Get the full content of a specific Dockflow documentation page by name or slug',
  inputSchema: {
    page: z.string().describe('Page identifier (e.g. "getting-started", "configuration", "docker-compose", "cli", "hooks", "accessories", "swarm")'),
  },
}, async ({ page }) => {
  const full = await getFull();
  const sections = parseSections(full);
  const lower = page.toLowerCase().replace(/\s+/g, '-');

  const exact = sections.find(
    s => s.path === lower || s.title.toLowerCase().replace(/\s+/g, '-') === lower
  );

  if (exact) {
    return { content: [{ type: 'text', text: exact.content }] };
  }

  const matches = sections.filter(
    s => s.path.includes(lower) || s.title.toLowerCase().includes(lower.replace(/-/g, ' '))
  );

  if (matches.length === 1) {
    return { content: [{ type: 'text', text: matches[0].content }] };
  }

  if (matches.length > 1) {
    const list = matches.map(m => `- ${m.title} (${m.path})`).join('\n');
    return { content: [{ type: 'text', text: `Multiple pages match "${page}":\n${list}\n\nPlease be more specific.` }] };
  }

  return { content: [{ type: 'text', text: `Page "${page}" not found. Use list_pages to see available pages.` }] };
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start Dockflow MCP server:', err);
  process.exit(1);
});
