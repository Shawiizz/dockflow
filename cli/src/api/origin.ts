/**
 * Origin guard for the local WebUI server.
 *
 * The server binds to loopback, which stops network peers — but not a
 * malicious web page open in the user's own browser. Such a page can POST to
 * http://localhost:<port>/api/... or open a WebSocket to /ws/ssh/<server>
 * (WebSockets are not subject to the same-origin policy on connect), which
 * would let it drive deployments or open an SSH shell to production.
 *
 * The UI is always same-origin (served by this server in production, reached
 * through the Angular dev proxy in development), so any cross-origin request
 * is illegitimate. We reject requests whose Origin or Host is not loopback.
 * Non-browser clients (curl, etc.) send no Origin header and are unaffected.
 */

/** Loopback hostnames the local UI may legitimately originate from. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * True when a request is safe to serve: its Host and Origin (when present)
 * both resolve to a loopback hostname. Any other value indicates a
 * cross-site request and is rejected.
 */
export function isSameOriginRequest(req: Request): boolean {
  const host = req.headers.get('host');
  if (host) {
    try {
      if (!isLoopbackHostname(new URL(`http://${host}`).hostname)) return false;
    } catch {
      return false;
    }
  }

  const origin = req.headers.get('origin');
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }

  return true;
}
