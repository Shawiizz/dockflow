/**
 * Notification — webhook module.
 *
 * Fires HTTP webhooks after deployment events (success / failure).
 * Non-fatal — a webhook failure logs a warning but never blocks the deploy.
 *
 * Payload format (JSON):
 * {
 *   "event":       "deploy.success" | "deploy.failure",
 *   "project":     "my-app",
 *   "env":         "production",
 *   "version":     "1.2.3",
 *   "branch":      "main",
 *   "performer":   "user@host",
 *   "status":      "success" | "failed",
 *   "duration_ms": 12345,
 *   "message":     "Deployed 1.2.3 to production successfully",
 *   "timestamp":   "2026-04-12T..."
 * }
 *
 * Optional HMAC-SHA256 signature:
 *   X-Dockflow-Signature: sha256=<hex>
 */

import { createHmac } from 'crypto';
import { printDebug, printWarning } from '../utils/output';
import type { WebhookConfig } from '../utils/config';

export interface DeployEventPayload {
  project: string;
  env: string;
  version: string;
  branch: string;
  performer: string;
  status: 'success' | 'failed';
  duration_ms: number;
  message: string;
}

interface WebhookBody extends DeployEventPayload {
  event: string;
  timestamp: string;
}

function buildSignature(secret: string, body: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

function shouldFire(webhook: WebhookConfig, status: 'success' | 'failed'): boolean {
  const events = webhook.on ?? ['always'];
  if (events.includes('always')) return true;
  if (status === 'success' && events.includes('success')) return true;
  if (status === 'failed' && events.includes('failure')) return true;
  return false;
}

async function sendWebhook(webhook: WebhookConfig, payload: DeployEventPayload): Promise<void> {
  const body: WebhookBody = {
    event: `deploy.${payload.status}`,
    timestamp: new Date().toISOString(),
    ...payload,
  };
  const bodyStr = JSON.stringify(body);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'dockflow-webhook/1.0',
    ...webhook.headers,
  };

  if (webhook.secret) {
    headers['X-Dockflow-Signature'] = buildSignature(webhook.secret, bodyStr);
  }

  const timeoutMs = (webhook.timeout ?? 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    });

    if (!res.ok) {
      printWarning(`Webhook ${webhook.url} returned HTTP ${res.status}`);
    } else {
      printDebug(`Webhook ${webhook.url} → ${res.status}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    printWarning(`Webhook ${webhook.url} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send all configured webhooks for a deployment event.
 * Best-effort — never throws.
 */
export async function notify(
  webhooks: WebhookConfig[] | undefined,
  payload: DeployEventPayload,
): Promise<void> {
  if (!webhooks || webhooks.length === 0) return;

  const eligible = webhooks.filter((w) => shouldFire(w, payload.status));
  if (eligible.length === 0) return;

  printDebug(`Sending ${eligible.length} webhook(s) for deploy.${payload.status}`);

  await Promise.allSettled(
    eligible.map((w) => sendWebhook(w, payload)),
  );
}
