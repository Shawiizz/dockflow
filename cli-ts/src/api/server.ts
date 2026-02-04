/**
 * API Server - Bun HTTP server for Dockflow WebUI
 * 
 * Serves the Angular frontend and exposes REST API endpoints
 * for interacting with the Dockflow CLI functionality.
 * 
 * Supports three modes:
 * 1. Dev mode: proxies to Angular dev server (ng serve on port 4201)
 * 2. Compiled binary: serves embedded UI assets via generated manifest
 * 3. Source mode: serves from ui/dist/browser/browser on disk
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { handleApiRoutes } from './routes/index';

/**
 * Server configuration options
 */
export interface ServerOptions {
  /** Development mode - proxy to Angular dev server */
  devMode?: boolean;
}

/**
 * Try to load embedded UI assets (only available in compiled binary)
 */
async function loadEmbeddedAssets(): Promise<Map<string, string> | null> {
  try {
    // This file is generated at build time and only exists in compiled binaries
    // @ts-ignore - file is auto-generated at compile time
    const mod = await import('../ui-manifest.generated');
    return mod.UI_ASSETS as Map<string, string>;
  } catch {
    return null;
  }
}

/**
 * Get the path to the UI dist folder (for source/dev mode)
 */
function getUIDistPath(): string {
  // Angular 21 with application builder outputs to dist/browser/browser
  // When running from source: cli-ts/src/api -> cli-ts/ui/dist/browser/browser
  const devPath = join(import.meta.dir, '../../ui/dist/browser/browser');
  
  if (existsSync(devPath)) return devPath;
  
  return devPath; // Default to dev path, will show fallback if not built
}

/**
 * CORS headers for API responses
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Create a JSON response with CORS headers
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

/**
 * Create an error response
 */
export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Start the Dockflow WebUI server
 */
export async function startWebServer(port: number, options: ServerOptions = {}): Promise<void> {
  const { devMode = false } = options;
  const uiDistPath = getUIDistPath();
  const angularDevServer = 'http://localhost:4201';
  
  // Try to load embedded assets (compiled binary mode)
  const embeddedAssets = !devMode ? await loadEmbeddedAssets() : null;
  const hasEmbeddedUI = embeddedAssets !== null && embeddedAssets.size > 0;
  const hasDiskUI = existsSync(join(uiDistPath, 'index.html'));
  
  Bun.serve({
    port,
    
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      
      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }
      
      // API routes
      if (pathname.startsWith('/api/')) {
        return handleApiRoutes(req);
      }
      
      // WebSocket upgrade for logs streaming (future)
      if (pathname.startsWith('/ws/')) {
        // TODO: Handle WebSocket connections
        return new Response('WebSocket not implemented yet', { status: 501 });
      }
      
      // In dev mode, proxy to Angular dev server
      if (devMode) {
        try {
          const proxyUrl = `${angularDevServer}${pathname}${url.search}`;
          const proxyResponse = await fetch(proxyUrl, {
            method: req.method,
            headers: req.headers,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
          });
          return proxyResponse;
        } catch {
          return new Response('Angular dev server not running. Start it with: cd ui && pnpm start', {
            status: 503,
          });
        }
      }
      
      // Serve from embedded assets (compiled binary)
      if (hasEmbeddedUI && embeddedAssets) {
        const assetPath = pathname === '/' ? '/index.html' : pathname;
        const embeddedPath = embeddedAssets.get(assetPath);
        
        if (embeddedPath) {
          const file = Bun.file(embeddedPath);
          return new Response(file, {
            headers: { 'Content-Type': getMimeType(assetPath) },
          });
        }
        
        // SPA fallback - serve index.html for unknown routes
        const indexPath = embeddedAssets.get('/index.html');
        if (indexPath) {
          return new Response(Bun.file(indexPath), {
            headers: { 'Content-Type': 'text/html' },
          });
        }
      }
      
      // Serve from disk (source/dev mode with built UI)
      if (hasDiskUI) {
        let filePath = join(uiDistPath, pathname === '/' ? 'index.html' : pathname);
        let file = Bun.file(filePath);
        
        if (await file.exists()) {
          return new Response(file, {
            headers: { 'Content-Type': getMimeType(filePath) },
          });
        }
        
        // SPA fallback
        const indexFilePath = join(uiDistPath, 'index.html');
        const indexFile = Bun.file(indexFilePath);
        
        if (await indexFile.exists()) {
          return new Response(indexFile, {
            headers: { 'Content-Type': 'text/html' },
          });
        }
      }
      
      // No UI available
      return new Response(getNoUIHTML(), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    },
  });
}

/**
 * Get MIME type for a file path
 */
function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  const mimeTypes: Record<string, string> = {
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    eot: 'application/vnd.ms-fontobject',
  };
  
  return mimeTypes[ext || ''] || 'application/octet-stream';
}

/**
 * HTML page shown when UI is not built
 */
function getNoUIHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dockflow UI</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e2e8f0;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .logo {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 2rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: #94a3b8;
      margin-bottom: 1.5rem;
    }
    .code {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 1rem 1.5rem;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.9rem;
      color: #60a5fa;
      margin-bottom: 1rem;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: #166534;
      color: #86efac;
      padding: 0.5rem 1rem;
      border-radius: 9999px;
      font-size: 0.875rem;
    }
    .status::before {
      content: '';
      width: 8px;
      height: 8px;
      background: #86efac;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🐳</div>
    <h1>Dockflow UI</h1>
    <p>The WebUI needs to be built first.</p>
    <div class="code">cd cli-ts/ui && pnpm install && pnpm build</div>
    <p>Or run in development mode:</p>
    <div class="code">dockflow ui --dev</div>
    <br>
    <div class="status">API Server Running</div>
  </div>
</body>
</html>`;
}
