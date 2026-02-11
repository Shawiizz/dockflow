import { jsonResponse, errorResponse } from '../server';
import { getProjectRoot } from '../../utils/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ComposeFile } from '../types';

export async function handleComposeRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/compose' && method === 'GET') {
    return getCompose();
  }

  if (pathname === '/api/compose' && method === 'PUT') {
    return updateCompose(req);
  }

  return errorResponse('Endpoint not found', 404);
}

function getComposePath(): string | null {
  const root = getProjectRoot();
  const ymlPath = join(root, '.dockflow', 'docker', 'docker-compose.yml');
  if (existsSync(ymlPath)) return ymlPath;

  const yamlPath = join(root, '.dockflow', 'docker', 'docker-compose.yaml');
  if (existsSync(yamlPath)) return yamlPath;

  return null;
}

async function getCompose(): Promise<Response> {
  const composePath = getComposePath();

  if (!composePath) {
    return jsonResponse({
      exists: false,
      compose: null,
      message: 'No docker-compose.yml found in .dockflow/docker/',
    });
  }

  try {
    const content = readFileSync(composePath, 'utf-8');
    const parsed = parseYaml(content) as ComposeFile;
    return jsonResponse({ exists: true, compose: parsed });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to parse docker-compose.yml',
      500,
    );
  }
}

async function updateCompose(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as ComposeFile;
    const composePath = getComposePath();

    if (!composePath) {
      return errorResponse('No docker-compose.yml found in .dockflow/docker/', 404);
    }

    if (!body.services || typeof body.services !== 'object') {
      return jsonResponse({ success: false, error: 'Invalid compose: missing services' }, 400);
    }

    const yamlContent = stringifyYaml(body, { indent: 2 });
    writeFileSync(composePath, yamlContent, 'utf-8');

    return jsonResponse({ success: true, message: 'docker-compose.yml updated' });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to update docker-compose.yml',
      500,
    );
  }
}
