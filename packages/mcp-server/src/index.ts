#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getIndex, getFull, parseSections } from './docs.js';
import { EXAMPLES, listExamples, formatExample } from './examples.js';
import { validateConfig, validateServersOnly, formatValidationResult } from './validate.js';
import { readProjectConfig, formatProjectConfig } from './project.js';

const server = new McpServer({
  name: 'dockflow',
  version: '1.0.0',
});

// ── Documentation tools ──────────────────────────────────────────────────────

server.registerTool('list_pages', {
  description: 'List all available Dockflow documentation pages with descriptions',
}, async () => {
  const index = await getIndex();
  return { content: [{ type: 'text', text: index }] };
});

server.registerTool('search_docs', {
  description: 'Search Dockflow documentation for a specific topic or keyword',
  inputSchema: {
    query: z.string().describe('Search query (e.g. "docker compose", "hooks", "multi-host", "registry")'),
    max_results: z.number().optional().default(5).describe('Maximum number of results to return'),
  },
}, async ({ query, max_results }) => {
  const full = await getFull();
  const sections = parseSections(full);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

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
    page: z.string().describe('Page identifier (e.g. "getting-started", "docker-compose", "hooks", "proxy", "servers")'),
  },
}, async ({ page }) => {
  const full = await getFull();
  const sections = parseSections(full);
  const lower = page.toLowerCase().replace(/\s+/g, '-');

  const exact = sections.find(
    s => s.path === lower || s.title.toLowerCase().replace(/\s+/g, '-') === lower,
  );
  if (exact) return { content: [{ type: 'text', text: exact.content }] };

  const matches = sections.filter(
    s => s.path.includes(lower) || s.title.toLowerCase().includes(lower.replace(/-/g, ' ')),
  );
  if (matches.length === 1) return { content: [{ type: 'text', text: matches[0].content }] };
  if (matches.length > 1) {
    const list = matches.map(m => `- ${m.title} (${m.path})`).join('\n');
    return { content: [{ type: 'text', text: `Multiple pages match "${page}":\n${list}\n\nBe more specific.` }] };
  }

  return { content: [{ type: 'text', text: `Page "${page}" not found. Use list_pages to see available pages.` }] };
});

// ── Setup tools ──────────────────────────────────────────────────────────────

server.registerTool('get_examples', {
  description: 'Get complete, ready-to-use Dockflow configuration examples for common project setups. Call without arguments to list available scenarios, or with a scenario id to get the full files.',
  inputSchema: {
    scenario: z.string().optional().describe(
      'Scenario id: simple, standard, app-with-database, with-proxy, with-registry, multi-server, k3s, with-hooks, with-ci. Omit to list all.',
    ),
  },
}, async ({ scenario }) => {
  if (!scenario) {
    return { content: [{ type: 'text', text: listExamples() }] };
  }

  const ex = EXAMPLES.find(e => e.id === scenario);
  if (!ex) {
    const ids = EXAMPLES.map(e => e.id).join(', ');
    return { content: [{ type: 'text', text: `Unknown scenario "${scenario}". Available: ${ids}` }] };
  }

  return { content: [{ type: 'text', text: formatExample(ex) }] };
});

server.registerTool('validate_config', {
  description: 'Validate the content of a dockflow.yml, config.yml, or servers.yml file. Returns validation errors with field paths to help fix issues before deploying.',
  inputSchema: {
    content: z.string().describe('Raw YAML content to validate'),
    type: z.enum(['auto', 'root', 'config', 'servers']).optional().default('auto').describe(
      'auto: detect from content (default). root: dockflow.yml (config + servers merged). config: .dockflow/config.yml only. servers: .dockflow/servers.yml only.',
    ),
  },
}, async ({ content, type }) => {
  let detectedType = type;

  if (detectedType === 'auto') {
    try {
      const parsed = parseYaml(content);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (obj.project_name && obj.servers) detectedType = 'root';
        else if (obj.servers && !obj.project_name) detectedType = 'servers';
        else detectedType = 'config';
      }
    } catch {
      detectedType = 'config';
    }
  }

  const result = detectedType === 'servers'
    ? validateServersOnly(content)
    : validateConfig(content);

  const filename = detectedType === 'servers' ? 'servers.yml'
    : detectedType === 'root' ? 'dockflow.yml'
    : 'config.yml';

  return { content: [{ type: 'text', text: formatValidationResult(result, filename) }] };
});

server.registerTool('read_project_config', {
  description: 'Read the Dockflow configuration files from the current project. Returns the layout type (rootless dockflow.yml or standard .dockflow/) and the content of all config files found.',
}, async () => {
  const result = readProjectConfig(process.cwd());
  return { content: [{ type: 'text', text: formatProjectConfig(result) }] };
});

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start Dockflow MCP server:', err);
  process.exit(1);
});
