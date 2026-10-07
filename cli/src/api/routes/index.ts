/**
 * API Routes - Handle all /api/* endpoints
 */

import { jsonResponse, errorResponse } from '../server';
import { printDebug } from '../../utils/output';
import { handleServersRoutes } from './servers';
import { handleConfigRoutes } from './config';
import { handleProjectRoutes } from './project';
import { handleServicesRoutes } from './services';
import { handleDeployRoutes } from './deploy';
import { handleAccessoriesRoutes } from './accessories';
import { handleBackupRoutes } from './backup';
import { handleOperationsRoutes } from './operations';
import { handleResourcesRoutes, handleLocksRoutes } from './resources';
import { handleMetricsRoutes } from './metrics';
import { handleComposeRoutes } from './compose';
import { handleTopologyRoutes } from './topology';
import pkg from '../../../package.json';

/**
 * Main API router
 */
export async function handleApiRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  
  try {
    // /api/servers/* - Server management
    if (pathname.startsWith('/api/servers')) {
      return await handleServersRoutes(req);
    }
    
    // /api/services/* - Docker services
    if (pathname.startsWith('/api/services')) {
      return await handleServicesRoutes(req);
    }
    
    // /api/config/* - Configuration
    if (pathname.startsWith('/api/config')) {
      return await handleConfigRoutes(req);
    }
    
    // /api/project/* - Project info
    if (pathname.startsWith('/api/project')) {
      return await handleProjectRoutes(req);
    }
    
    // /api/operations/* - Deploy/Build streaming
    if (pathname.startsWith('/api/operations')) {
      return await handleOperationsRoutes(req);
    }

    // /api/deploy/* - Deploy history
    if (pathname.startsWith('/api/deploy')) {
      return await handleDeployRoutes(req);
    }

    // /api/accessories/* - Accessories
    if (pathname.startsWith('/api/accessories')) {
      return await handleAccessoriesRoutes(req);
    }

    // /api/backup/* - Backup & Restore
    if (pathname.startsWith('/api/backup')) {
      return await handleBackupRoutes(req);
    }

    // /api/resources/* - Prune & disk usage
    if (pathname.startsWith('/api/resources')) {
      return await handleResourcesRoutes(req);
    }

    // /api/locks/* - Deploy locks
    if (pathname.startsWith('/api/locks')) {
      return await handleLocksRoutes(req);
    }

    // /api/metrics/* - Container stats & audit
    if (pathname.startsWith('/api/metrics')) {
      return await handleMetricsRoutes(req);
    }

    // /api/compose/* - Docker Compose
    if (pathname.startsWith('/api/compose')) {
      return await handleComposeRoutes(req);
    }

    // /api/topology - Service-to-server topology
    if (pathname.startsWith('/api/topology')) {
      return await handleTopologyRoutes(req);
    }

    // /api/health - Health check
    if (pathname === '/api/health') {
      return jsonResponse({ 
        status: 'ok', 
        version: pkg.version,
        timestamp: new Date().toISOString(),
      });
    }
    
    // 404 for unknown API routes
    return errorResponse('API endpoint not found', 404);
    
  } catch (error) {
    printDebug('API Error', { error: error instanceof Error ? error.message : String(error) });
    return errorResponse(
      error instanceof Error ? error.message : 'Internal server error',
      500
    );
  }
}
