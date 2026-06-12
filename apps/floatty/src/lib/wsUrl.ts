/**
 * wsUrl - WebSocket URL construction with auth token (FLO-762).
 *
 * Shared by useSyncedYDoc (main sync socket) and doorSandbox (door WS access)
 * so every /ws connection carries the key the same way.
 */

/**
 * Build the WebSocket URL from the HTTP server URL.
 *
 * The API key rides as a `?token=` query param because browsers can't set
 * headers on `new WebSocket()`. The server skips the check for loopback
 * peers (local spawn stays keyless) and enforces it for remote authorities —
 * without it, /ws is an unauthenticated read firehose of every block edit
 * to anyone who can reach the port.
 *
 * NOTE: the token is a credential — never log the full URL this returns
 * (logging-discipline §1). Log `url.split('?')[0]` instead.
 */
export function buildWsUrl(serverUrl: string, apiKey: string | undefined): string {
  const base = serverUrl.replace(/^http/, 'ws') + '/ws';
  return apiKey ? `${base}?token=${encodeURIComponent(apiKey)}` : base;
}
