/** Dispatches /api/* requests to the route module of each prefix. */

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

export async function handleApiRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/servers')) {
      return await handleServersRoutes(req);
    }

    if (pathname.startsWith('/api/services')) {
      return await handleServicesRoutes(req);
    }

    if (pathname.startsWith('/api/config')) {
      return await handleConfigRoutes(req);
    }

    if (pathname.startsWith('/api/project')) {
      return await handleProjectRoutes(req);
    }

    if (pathname.startsWith('/api/operations')) {
      return await handleOperationsRoutes(req);
    }

    if (pathname.startsWith('/api/deploy')) {
      return await handleDeployRoutes(req);
    }

    if (pathname.startsWith('/api/accessories')) {
      return await handleAccessoriesRoutes(req);
    }

    if (pathname.startsWith('/api/backup')) {
      return await handleBackupRoutes(req);
    }

    if (pathname.startsWith('/api/resources')) {
      return await handleResourcesRoutes(req);
    }

    if (pathname.startsWith('/api/locks')) {
      return await handleLocksRoutes(req);
    }

    if (pathname.startsWith('/api/metrics')) {
      return await handleMetricsRoutes(req);
    }

    if (pathname.startsWith('/api/compose')) {
      return await handleComposeRoutes(req);
    }

    if (pathname.startsWith('/api/topology')) {
      return await handleTopologyRoutes(req);
    }

    if (pathname === '/api/health') {
      return jsonResponse({
        status: 'ok',
        version: pkg.version,
        timestamp: new Date().toISOString(),
      });
    }

    return errorResponse('API endpoint not found', 404);

  } catch (error) {
    printDebug('API Error', { error: error instanceof Error ? error.message : String(error) });
    return errorResponse(
      error instanceof Error ? error.message : 'Internal server error',
      500
    );
  }
}
