/**
 * Accessories API Routes
 *
 * GET /api/accessories - List configured accessories
 */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig } from '../../utils/config';
import type { AccessoryInfo, AccessoriesResponse } from '../types';

/**
 * Handle /api/accessories/* routes
 */
export async function handleAccessoriesRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /api/accessories
  if (pathname === '/api/accessories' && method === 'GET') {
    return listAccessories();
  }

  return errorResponse('Endpoint not found', 404);
}

/**
 * List configured accessories from config.yml
 */
async function listAccessories(): Promise<Response> {
  const config = loadConfig({ silent: true });

  if (!config) {
    return jsonResponse({
      accessories: [],
      total: 0,
      message: 'No config.yml found.',
    } satisfies AccessoriesResponse & { message?: string });
  }

  const accessoriesConfig = (config as unknown as Record<string, unknown>)['accessories'];
  const accessories: AccessoryInfo[] = [];

  if (accessoriesConfig && typeof accessoriesConfig === 'object') {
    for (const [name, value] of Object.entries(accessoriesConfig as Record<string, unknown>)) {
      const acc = value as Record<string, unknown>;
      accessories.push({
        name,
        image: (acc['image'] as string) || undefined,
        volumes: Array.isArray(acc['volumes']) ? acc['volumes'] as string[] : undefined,
        ports: Array.isArray(acc['ports']) ? acc['ports'] as string[] : undefined,
        env: (acc['env'] && typeof acc['env'] === 'object')
          ? acc['env'] as Record<string, string>
          : undefined,
      });
    }
  }

  return jsonResponse({
    accessories,
    total: accessories.length,
  } satisfies AccessoriesResponse);
}
