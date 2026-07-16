/**
 * httpClient.ts - HTTP client for floatty-server communication
 *
 * Replaces Tauri IPC for Y.Doc sync operations.
 * Server is spawned by Tauri on app start; this client connects to it.
 */

import { invoke } from './tauriTypes';
import { base64ToBytes, bytesToBase64 } from './encoding';
import { createLogger } from './logger';

const logger = createLogger('httpClient');

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/** Server info returned from Tauri's get_server_info command */
export interface ServerInfo {
  url: string;
  /** snake_case on the wire — see the note in src-tauri/src/config.rs. */
  api_key: string;
}

/**
 * How the backing floatty-server resolved at startup (Tauri `get_server_status`).
 *
 * Un-conflates the two worlds that both used to surface as the single string
 * `"Server not running"`:
 *
 * - `{ remoteConfigured: true, reachable: false }` — `remote_server_url` IS set
 *   (FLO-762 thin-client mode) and the remote is simply down. The outline still
 *   exists on float-box; this app is **offline**, not broken. Recoverable by
 *   waiting; the only state in which booting from the local cache is legal.
 * - `{ remoteConfigured: false, reachable: false }` — no remote configured and
 *   the local subprocess failed to spawn. Genuinely broken.
 * - `{ remoteConfigured: true, reachable: true, authFailed: true }` — the
 *   remote answered but the local API key is missing or rejected.
 *   Misconfiguration, not an outage: never the cache-boot case.
 *
 * Phase 0 does not branch on this — it only makes the thrown error say something
 * true. Phase 2's offline mode is what it exists for.
 */
export interface ServerStatus {
  remoteConfigured: boolean;
  reachable: boolean;
  authFailed: boolean;
}

/** State hash response for sync health check */
export interface StateHashResponse {
  /** SHA256 hash of full Y.Doc state */
  hash: string;
  /** Number of blocks in document */
  blockCount: number;
  /** Server timestamp (ms since epoch) */
  timestamp: number;
  /** Doc epoch — increments on destructive restore. 0 on pre-epoch servers. */
  epoch: number;
}

/** Single update entry from incremental sync */
export interface UpdateEntry {
  /** Sequence number (monotonically increasing) */
  seq: number;
  /** Base64-encoded Y.Doc update bytes */
  data: string;
  /** Unix timestamp when update was persisted */
  createdAt: number;
}

/** Response for GET /api/v1/updates */
export interface UpdatesResponse {
  /** List of updates since the requested sequence */
  updates: UpdateEntry[];
  /** Highest sequence that was compacted (updates <= this are gone). Null if no compaction. */
  compactedThrough: number | null;
  /** Latest sequence number in database (for client to know if fully caught up) */
  latestSeq: number | null;
}

/** Error response when client requests updates that have been compacted (410 Gone) */
export interface UpdatesCompactedError {
  error: string;
  compactedThrough: number;
  requestedSince: number;
}

/** Result of getUpdatesSince - either updates or compaction error */
export type UpdatesSinceResult =
  | { ok: true; response: UpdatesResponse }
  | { ok: false; compactedThrough: number };

/** Full state response with sequence tracking info */
export interface FullStateResponse {
  /** Full Y.Doc state as Uint8Array */
  state: Uint8Array;
  /** Latest sequence number (for re-seeding seq tracking after full sync) */
  latestSeq: number | null;
  /** Doc epoch this snapshot belongs to. Null on pre-epoch servers. */
  epoch: number | null;
}

/** Response for POST /api/v1/state-diff — the state-vector PULL diff. */
export interface StateDiffResponse {
  /** Only the ops the client lacks. Empty (<= 2-byte header) when up to date. */
  update: Uint8Array;
  /**
   * Seq of the last update APPLIED to the doc this diff was encoded from —
   * paired with the encode under one server-side read guard, so seeding the
   * seq baseline from it can never skip an update the diff omits.
   */
  latestSeq: number | null;
  /** Doc epoch of the diffed snapshot. Null on pre-epoch servers. */
  epoch: number | null;
}

/** HTTP client interface for Y.Doc sync */
export interface FloattyHttpClient {
  /** Get full Y.Doc state from server with latest sequence number */
  getState(): Promise<FullStateResponse>;
  /** Get state vector for reconciliation (what updates server has) */
  getStateVector(): Promise<Uint8Array>;
  /**
   * Pull only the ops the server has that this client lacks.
   *
   * The symmetric partner of the state-vector PUSH (`Y.encodeStateAsUpdate(doc,
   * serverSV)` → `applyUpdate`). Diffs against actual doc state rather than the
   * seq log, so it survives compaction — unlike `getUpdatesSince`, which 410s
   * once the server compacts past the client's last seq and forces a full-state
   * refetch.
   *
   * @param stateVector - `Y.encodeStateVector(doc)` for the local doc
   */
  stateDiff(stateVector: Uint8Array): Promise<StateDiffResponse>;
  /** Send update delta to server. Optional txId for echo prevention. */
  applyUpdate(update: Uint8Array, txId?: string): Promise<void>;
  /** Health check */
  isHealthy(): Promise<boolean>;
  /** Get state hash for sync health check (lightweight) */
  getStateHash(): Promise<StateHashResponse>;
  /**
   * Get incremental updates since a sequence number.
   * Used for gap detection and incremental reconnect.
   *
   * @param since - Sequence number to start from (exclusive - returns updates AFTER this seq)
   * @param limit - Maximum updates to return (default: 100, max: 1000)
   * @returns Updates if available, or compactedThrough if client is too far behind
   */
  getUpdatesSince(since: number, limit?: number): Promise<UpdatesSinceResult>;
  /** Fetch a URL with the server auth header attached. */
  fetchWithAuth(url: string, init?: RequestInit): Promise<Response>;
}

// ═══════════════════════════════════════════════════════════════
// HTTP CLIENT IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

class HttpClient implements FloattyHttpClient {
  private url: string;
  private apiKey: string;

  constructor(serverInfo: ServerInfo) {
    this.url = serverInfo.url;
    this.apiKey = serverInfo.api_key;
  }

  fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
    // Build headers via Headers API — spreading a Headers instance into an object literal
    // produces {} (its data is internal), so we normalize first, then set auth to win.
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...init, headers });
  }

  /** API prefix: always /api/v1 */
  private api(path: string): string {
    return `${this.url}/api/v1${path}`;
  }

  private headers(): HeadersInit {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async getState(): Promise<FullStateResponse> {
    const response = await fetch(`${this.api('/state')}`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get state: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    // Server returns { state: "base64...", latestSeq: number | null }
    if (!data.state) {
      throw new Error('Invalid response: missing state field');
    }

    return {
      state: base64ToBytes(data.state),
      latestSeq: data.latestSeq ?? null,
      epoch: typeof data.epoch === 'number' ? data.epoch : null,
    };
  }

  async getStateVector(): Promise<Uint8Array> {
    const response = await fetch(`${this.api('/state-vector')}`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get state vector: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.state_vector) {
      throw new Error('Invalid response: missing state_vector field');
    }

    return base64ToBytes(data.state_vector);
  }

  async stateDiff(stateVector: Uint8Array): Promise<StateDiffResponse> {
    const response = await fetch(`${this.api('/state-diff')}`, {
      method: 'POST',
      headers: this.headers(),
      // camelCase on the wire — the server declares deny_unknown_fields, so
      // `state_vector` would be a 422, not a silent field-drop.
      body: JSON.stringify({ stateVector: bytesToBase64(stateVector) }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get state diff: ${response.status} ${text}`);
    }

    const data = await response.json();
    if (typeof data.update !== 'string') {
      throw new Error('Invalid response: missing update field');
    }

    return {
      update: base64ToBytes(data.update),
      latestSeq: data.latestSeq ?? null,
      epoch: typeof data.epoch === 'number' ? data.epoch : null,
    };
  }

  async applyUpdate(update: Uint8Array, txId?: string): Promise<void> {
    const updateB64 = bytesToBase64(update);

    const body: { update: string; tx_id?: string } = { update: updateB64 };
    if (txId) {
      body.tx_id = txId;
    }

    const response = await fetch(`${this.api('/update')}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to apply update: ${response.status} ${text}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/api/v1/health`, {
        method: 'GET',
      });
      if (!response.ok) {
        logger.warn(`Health check returned ${response.status} ${response.statusText}`);
      }
      return response.ok;
    } catch (err) {
      // Log specific error for debugging - helps distinguish between
      // "server not started yet" vs "server URL wrong" vs "network issue"
      logger.error('Health check failed', { err });
      return false;
    }
  }

  async getStateHash(): Promise<StateHashResponse> {
    const response = await fetch(`${this.api('/state/hash')}`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get state hash: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return {
      hash: data.hash,
      blockCount: data.blockCount,
      timestamp: data.timestamp,
      epoch: typeof data.epoch === 'number' ? data.epoch : 0,
    };
  }

  /**
   * Fetch the JSON export from the server (FLO-393).
   * Single source of truth — both ⌘⇧J and API consumers use this path.
   * Returns the raw JSON string (caller handles save dialog).
   */
  async exportJSON(): Promise<string> {
    const response = await fetch(`${this.api('/export/json')}`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to export JSON: ${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  async getUpdatesSince(since: number, limit: number = 100): Promise<UpdatesSinceResult> {
    const url = new URL(`${this.api('/updates')}`);
    url.searchParams.set('since', String(since));
    url.searchParams.set('limit', String(limit));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers(),
    });

    // 410 Gone - client requested updates that have been compacted
    if (response.status === 410) {
      const data: UpdatesCompactedError = await response.json();
      logger.warn(`Updates compacted: requested since ${data.requestedSince}, compacted through ${data.compactedThrough}`);
      return { ok: false, compactedThrough: data.compactedThrough };
    }

    if (!response.ok) {
      throw new Error(`Failed to get updates: ${response.status} ${response.statusText}`);
    }

    const data: UpdatesResponse = await response.json();
    return { ok: true, response: data };
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON CLIENT
// ═══════════════════════════════════════════════════════════════

let clientInstance: FloattyHttpClient | null = null;
let initPromise: Promise<FloattyHttpClient> | null = null;

/**
 * How the backing floatty-server resolved at startup.
 *
 * Never throws: a failure to read the status is itself reported as
 * "nothing configured, nothing reachable", which is the conservative reading.
 */
export async function getServerStatus(): Promise<ServerStatus> {
  try {
    return await invoke('get_server_status', {});
  } catch (err) {
    logger.warn(`Could not read server status: ${err}`);
    return { remoteConfigured: false, reachable: false, authFailed: false };
  }
}

/**
 * One cheap LIVE reachability probe (the reconnect loop's tick).
 *
 * `get_server_status` is a boot-time snapshot — it can never flip back to
 * reachable. This probe asks the server itself: get_server_info now returns
 * the config-derived URL even when the boot probe failed (unreachable-remote
 * still carries connection info), so a single short-timeout /health fetch
 * answers "is it back?" without initHttpClient's full retry ladder.
 */
export async function probeServerHealth(): Promise<boolean> {
  try {
    const serverInfo = await invoke('get_server_info', {});
    const response = await fetch(`${serverInfo.url}/api/v1/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Turn a failed connection into a message that distinguishes "float-box is down"
 * from "this app is broken". Both used to read as `Server not running`.
 */
async function describeConnectionFailure(cause: unknown): Promise<string> {
  const status = await getServerStatus();
  const detail = cause ? `: ${String(cause)}` : '';
  if (status.remoteConfigured && status.authFailed) {
    return `Remote floatty-server rejected this app's API key — local [server].api_key must match the remote's${detail}`;
  }
  if (status.remoteConfigured && !status.reachable) {
    return `Remote floatty-server (remote_server_url) is unreachable${detail}`;
  }
  return `Server connection failed after retries${detail}`;
}

/**
 * Initialize the HTTP client from Tauri's server info.
 * Call this once on app startup.
 */
export async function initHttpClient(): Promise<FloattyHttpClient> {
  // Return existing client if already initialized
  if (clientInstance) {
    return clientInstance;
  }

  // Wait for ongoing initialization
  if (initPromise) {
    return initPromise;
  }

  // Start initialization — retry the ENTIRE flow (IPC + health check) since
  // the sidecar server may still be starting when the webview mounts
  initPromise = (async () => {
    const delays = [500, 1000, 1500, 2000, 3000];
    let lastError: unknown;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        // Get server info from Tauri (contains URL and API key)
        // This IPC call returns Err("Server not running") if sidecar hasn't spawned yet
        const serverInfo = await invoke('get_server_info', {});
        const client = new HttpClient(serverInfo);

        // Store URL and API key globally for lightweight fire-and-forget calls
        window.__FLOATTY_SERVER_URL__ = serverInfo.url;
        window.__FLOATTY_API_KEY__ = serverInfo.api_key;

        // Verify server is actually responding
        const healthy = await client.isHealthy();
        if (!healthy) {
          throw new Error('Server health check failed');
        }

        // Only set instance after successful health check
        clientInstance = client;
        logger.info(`Connected to floatty-server at ${serverInfo.url}`);
        return clientInstance;
      } catch (err) {
        lastError = err;
        if (attempt < delays.length) {
          logger.info(`Server not ready, retrying in ${delays[attempt]}ms (attempt ${attempt + 1}/${delays.length}): ${err}`);
          await new Promise(r => setTimeout(r, delays[attempt]));
        }
      }
    }

    // Retries exhausted. Behavior is unchanged (we still throw — Phase 0 lands
    // invisible); the status only makes the message say something TRUE. "Server
    // not running" is a lie when float-box is merely unreachable: the outline
    // exists, this app is offline. Phase 2 branches here instead of throwing.
    throw new Error(await describeConnectionFailure(lastError));
  })().finally(() => {
    // Always clear promise so next caller retries fresh (prevents stuck rejected promise)
    initPromise = null;
  });

  return initPromise;
}

/**
 * Get the HTTP client. Throws if not initialized.
 */
export function getHttpClient(): FloattyHttpClient {
  if (!clientInstance) {
    throw new Error('HTTP client not initialized. Call initHttpClient() first.');
  }
  return clientInstance;
}

/**
 * Check if client is initialized
 */
export function isClientInitialized(): boolean {
  return clientInstance !== null;
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    logger.debug('HMR cleanup');
    clientInstance = null;
    initPromise = null;
  });
}
