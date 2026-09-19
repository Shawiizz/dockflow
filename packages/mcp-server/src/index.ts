#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getIndex, getFull, parseSections } from './docs.js';
import { EXAMPLES, SCENARIO_DESCRIPTION, listExamples, formatExample } from './examples.js';
import { detectFileType, FILE_NAMES, formatValidationResult, validateFile } from './validate.js';
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
    query: z.string().describe('Search query (e.g. "docker compose", "hooks", "multi-host", "registry", "kubernetes", "helm")'),
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
    page: z.string().describe('Page identifier (e.g. "getting-started", "docker-compose", "hooks", "proxy", "servers", "kubernetes", "helm")'),
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
  description: 'Get complete, ready-to-use Dockflow configuration examples for common project setups, on Docker Swarm or k3s (Kubernetes, including Helm releases). Call without arguments to list available scenarios, or with a scenario id to get the full files.',
  inputSchema: {
    scenario: z.string().optional().describe(SCENARIO_DESCRIPTION),
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
  description: 'Validate the content of a dockflow.yml, config.yml, or servers.yml file with the same rules as the Dockflow CLI, including the k3s ones (Helm releases, private_host, node_labels, manager count). Returns validation errors with field paths to help fix issues before deploying.',
  inputSchema: {
    content: z.string().describe('Raw YAML content to validate'),
    type: z.enum(['auto', 'root', 'config', 'servers']).optional().default('auto').describe(
      'auto: detect from content (default). root: dockflow.yml (config + servers merged). config: .dockflow/config.yml only. servers: .dockflow/servers.yml only.',
    ),
    orchestrator: z.enum(['swarm', 'k3s']).optional().describe(
      'Orchestrator of the project, for a servers.yml validated alone (config.yml and dockflow.yml declare their own). With k3s, the cluster rules apply: an odd manager count, distinct node names, no IPv6 cluster address.',
    ),
  },
}, async ({ content, type, orchestrator }) => {
  const fileType = type === 'auto' ? detectFileType(content) : type;
  const result = validateFile(content, fileType, { orchestrator });
  return { content: [{ type: 'text', text: formatValidationResult(result, FILE_NAMES[fileType]) }] };
});

server.registerTool('read_project_config', {
  description: 'Read the Dockflow configuration files from the current project. Returns the layout type (flat dockflow.yml or standard .dockflow/), the orchestrator (swarm or k3s) and the content of the config, servers, docker-compose and accessories files found. .env.dockflow and Helm values files are never read.',
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
  // stdout carries the MCP protocol: report on stderr only
  process.stderr.write(`Failed to start Dockflow MCP server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
