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

    sections.push({
      title,
      path: slug,
      content: trimmed,
    });
  }

  return sections;
}

function searchInSections(sections: DocSection[], query: string): DocSection[] {
  const lower = query.toLowerCase();
  const terms = lower.split(/\s+/).filter(Boolean);

  return sections
    .map(section => {
      const lowerContent = section.content.toLowerCase();
      const lowerTitle = section.title.toLowerCase();
      let score = 0;

      for (const term of terms) {
        if (lowerTitle.includes(term)) score += 10;
        const matches = lowerContent.split(term).length - 1;
        score += matches;
      }

      return { section, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ section }) => section);
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'dockflow',
  version: '1.0.0',
});

// Tool: list all documentation pages
server.tool(
  'list_pages',
  'List all available Dockflow documentation pages with descriptions',
  {},
  async () => {
    const index = await getIndex();
    return {
      content: [{ type: 'text', text: index }],
    };
  }
);

// Tool: search documentation
server.tool(
  'search_docs',
  'Search Dockflow documentation for a specific topic or keyword',
  {
    query: z.string().describe('Search query (e.g. "docker compose", "hooks", "multi-host")'),
    max_results: z.number().optional().default(5).describe('Maximum number of results to return'),
  },
  async ({ query, max_results }) => {
    const full = await getFull();
    const sections = parseSections(full);
    const results = searchInSections(sections, query).slice(0, max_results);

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No results found for "${query}".` }],
      };
    }

    const output = results
      .map((r, i) => `## ${i + 1}. ${r.title}\n\n${r.content}`)
      .join('\n\n---\n\n');

    return {
      content: [{ type: 'text', text: output }],
    };
  }
);

// Tool: get a specific page
server.tool(
  'get_page',
  'Get the full content of a specific Dockflow documentation page',
  {
    page: z.string().describe(
      'Page identifier (e.g. "getting-started", "configuration", "docker-compose", "cli", "hooks", "accessories", "swarm")'
    ),
  },
  async ({ page }) => {
    const full = await getFull();
    const sections = parseSections(full);
    const lower = page.toLowerCase().replace(/\s+/g, '-');

    const exact = sections.find(
      s => s.path === lower || s.title.toLowerCase().replace(/\s+/g, '-') === lower
    );

    if (exact) {
      return {
        content: [{ type: 'text', text: exact.content }],
      };
    }

    // Fuzzy match
    const matches = sections.filter(
      s => s.path.includes(lower) || s.title.toLowerCase().includes(lower.replace(/-/g, ' '))
    );

    if (matches.length === 1) {
      return {
        content: [{ type: 'text', text: matches[0].content }],
      };
    }

    if (matches.length > 1) {
      const list = matches.map(m => `- ${m.title} (${m.path})`).join('\n');
      return {
        content: [{ type: 'text', text: `Multiple pages match "${page}":\n${list}\n\nPlease be more specific.` }],
      };
    }

    return {
      content: [{ type: 'text', text: `Page "${page}" not found. Use list_pages to see available pages.` }],
    };
  }
);

// Tool: get configuration reference
server.tool(
  'get_config_reference',
  'Get the complete Dockflow configuration reference (servers.yml, config.yml, docker-compose, environment variables)',
  {
    section: z.string().optional().describe(
      'Specific config section: "servers", "environment", "docker-compose", "accessories", "build-strategy", "registry", "templates", "hooks", "multi-host", "config-file"'
    ),
  },
  async ({ section }) => {
    const full = await getFull();
    const sections = parseSections(full);

    if (section) {
      const lower = section.toLowerCase().replace(/\s+/g, '-');
      const match = sections.find(
        s => s.path.includes(lower) || s.title.toLowerCase().includes(lower.replace(/-/g, ' '))
      );
      if (match) {
        return { content: [{ type: 'text', text: match.content }] };
      }
      return {
        content: [{ type: 'text', text: `Configuration section "${section}" not found.` }],
      };
    }

    // Return all configuration sections
    const configSections = sections.filter(
      s => s.path.startsWith('configuration') || s.title.toLowerCase().includes('configuration')
        || ['connection', 'servers-configuration', 'environment-variables', 'docker-compose',
            'accessories-databases-caches', 'build-strategy', 'docker-registry',
            'templates', 'hooks', 'multi-host-deployment', 'configuration-file'].includes(s.path)
    );

    if (configSections.length === 0) {
      return { content: [{ type: 'text', text: 'No configuration sections found.' }] };
    }

    const output = configSections.map(s => s.content).join('\n\n---\n\n');
    return { content: [{ type: 'text', text: output }] };
  }
);

// Tool: get CLI commands
server.tool(
  'get_cli_commands',
  'Get the full Dockflow CLI command reference',
  {},
  async () => {
    const full = await getFull();
    const sections = parseSections(full);
    const cli = sections.find(
      s => s.title.toLowerCase().includes('cli') || s.path.includes('cli')
    );

    if (cli) {
      return { content: [{ type: 'text', text: cli.content }] };
    }

    return { content: [{ type: 'text', text: 'CLI commands section not found.' }] };
  }
);

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start Dockflow MCP server:', err);
  process.exit(1);
});
