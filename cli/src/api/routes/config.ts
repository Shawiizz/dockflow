/**
 * Config API Routes
 * 
 * GET /api/config - Get current configuration
 * PUT /api/config - Update configuration
 */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig, loadServersConfig, getProjectRoot } from '../../utils/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * Handle /api/config/* routes
 */
export async function handleConfigRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;
  
  // GET /api/config - Get config.yml
  if (pathname === '/api/config' && method === 'GET') {
    return getConfig();
  }
  
  // PUT /api/config - Update config.yml
  if (pathname === '/api/config' && method === 'PUT') {
    return updateConfig(req);
  }
  
  // GET /api/config/servers - Get servers.yml
  if (pathname === '/api/config/servers' && method === 'GET') {
    return getServersConfig();
  }
  
  // PUT /api/config/servers - Update servers.yml
  if (pathname === '/api/config/servers' && method === 'PUT') {
    return updateServersConfig(req);
  }
  
  // GET /api/config/raw/:file - Get raw file content
  const rawMatch = pathname.match(/^\/api\/config\/raw\/(.+)$/);
  if (rawMatch && method === 'GET') {
    return getRawConfig(rawMatch[1]);
  }
  
  // PUT /api/config/raw/:file - Save raw file content
  const rawSaveMatch = pathname.match(/^\/api\/config\/raw\/(.+)$/);
  if (rawSaveMatch && method === 'PUT') {
    return saveRawConfig(rawSaveMatch[1], req);
  }
  
  return errorResponse('Endpoint not found', 404);
}

/**
 * Get parsed config.yml
 */
async function getConfig(): Promise<Response> {
  const config = loadConfig({ silent: true });
  
  if (!config) {
    return jsonResponse({
      exists: false,
      config: null,
      message: 'No config.yml found. Run "dockflow init" to create one.',
    });
  }
  
  return jsonResponse({
    exists: true,
    config,
  });
}

/**
 * Update config.yml
 */
async function updateConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const configPath = join(getProjectRoot(), '.dockflow', 'config.yml');
    
    if (!existsSync(configPath)) {
      return errorResponse('No config.yml found', 404);
    }
    
    // Validate the new config
    const { validateConfig } = await import('../../schemas');
    const result = validateConfig(body);
    
    if (!result.success) {
      return jsonResponse({
        success: false,
        errors: result.error.map((e: { path: string; message: string }) => ({
          path: e.path,
          message: e.message,
        })),
      }, 400);
    }
    
    // Write the updated config
    const yamlContent = stringifyYaml(body, { indent: 2 });
    writeFileSync(configPath, yamlContent, 'utf-8');
    
    return jsonResponse({
      success: true,
      config: body,
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to update config',
      500
    );
  }
}

/**
 * Get parsed servers.yml
 */
async function getServersConfig(): Promise<Response> {
  const serversConfig = loadServersConfig();
  
  if (!serversConfig) {
    return jsonResponse({
      exists: false,
      servers: null,
      message: 'No servers.yml found. Run "dockflow init" to create one.',
    });
  }
  
  return jsonResponse({
    exists: true,
    servers: serversConfig,
  });
}

/**
 * Update servers.yml
 */
async function updateServersConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const serversPath = join(getProjectRoot(), '.dockflow', 'servers.yml');
    
    if (!existsSync(serversPath)) {
      return errorResponse('No servers.yml found', 404);
    }
    
    // Validate the new config
    const { validateServersConfig } = await import('../../schemas');
    const result = validateServersConfig(body);
    
    if (!result.success) {
      return jsonResponse({
        success: false,
        errors: result.error.map((e: { path: string; message: string }) => ({
          path: e.path,
          message: e.message,
        })),
      }, 400);
    }
    
    // Write the updated config
    const yamlContent = stringifyYaml(body, { indent: 2 });
    writeFileSync(serversPath, yamlContent, 'utf-8');
    
    return jsonResponse({
      success: true,
      servers: body,
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to update servers config',
      500
    );
  }
}

/**
 * Get raw file content
 */
async function getRawConfig(fileName: string): Promise<Response> {
  // Sanitize filename to prevent directory traversal
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '');
  const allowedFiles = ['config.yml', 'servers.yml'];
  
  if (!allowedFiles.includes(safeName)) {
    return errorResponse('File not allowed', 403);
  }
  
  const filePath = join(getProjectRoot(), '.dockflow', safeName);
  
  if (!existsSync(filePath)) {
    return errorResponse('File not found', 404);
  }
  
  const content = readFileSync(filePath, 'utf-8');
  
  return jsonResponse({
    fileName: safeName,
    content,
  });
}

/**
 * Save raw file content
 */
async function saveRawConfig(fileName: string, req: Request): Promise<Response> {
  try {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '');
    const allowedFiles = ['config.yml', 'servers.yml'];

    if (!allowedFiles.includes(safeName)) {
      return errorResponse('File not allowed', 403);
    }

    const filePath = join(getProjectRoot(), '.dockflow', safeName);
    const body = await req.json();
    const content = body.content;

    if (typeof content !== 'string') {
      return errorResponse('Missing "content" field', 400);
    }

    // Validate YAML syntax
    try {
      parseYaml(content);
    } catch (e) {
      return jsonResponse({
        success: false,
        error: `Invalid YAML syntax: ${e instanceof Error ? e.message : 'parse error'}`,
      }, 400);
    }

    writeFileSync(filePath, content, 'utf-8');

    return jsonResponse({ success: true });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to save config',
      500,
    );
  }
}
