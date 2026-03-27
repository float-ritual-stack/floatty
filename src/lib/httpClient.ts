/**
 * httpClient.ts - HTTP client for floatty-server communication
 *
 * Replaces Tauri IPC for Y.Doc sync operations.
 * Server is spawned by Tauri on app start; this client connects to it.
 */

import { invoke } from './tauriTypes';
import { base64ToBytes, bytesToBase64 } from './encoding';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/** Server info returned from Tauri's get_server_info command */
export interface ServerInfo {
  url: string;
  api_key: string;
}

/** State hash response for sync health check */
export interface StateHashResponse {
  /** SHA256 hash of full Y.Doc state */
  hash: string;
  /** Number of blocks in document */
  blockCount: number;
  /** Server timestamp (ms since epoch) */
  timestamp: number;
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
}

/** HTTP client interface for Y.Doc sync */
export interface FloattyHttpClient {
  /** Get full Y.Doc state from server with latest sequence number */
  getState(): Promise<FullStateResponse>;
  /** Get state vector for reconciliation (what updates server has) */
  getStateVector(): Promise<Uint8Array>;
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

  private headers(): HeadersInit {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async getState(): Promise<FullStateResponse> {
    const response = await fetch(`${this.url}/api/v1/state`, {
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
    };
  }

  async getStateVector(): Promise<Uint8Array> {
    const response = await fetch(`${this.url}/api/v1/state-vector`, {
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

  async applyUpdate(update: Uint8Array, txId?: string): Promise<void> {
    const updateB64 = bytesToBase64(update);

    const body: { update: string; tx_id?: string } = { update: updateB64 };
    if (txId) {
      body.tx_id = txId;
    }

    const response = await fetch(`${this.url}/api/v1/update`, {
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
        console.warn(`[httpClient] Health check returned ${response.status} ${response.statusText}`);
      }
      return response.ok;
    } catch (err) {
      // Log specific error for debugging - helps distinguish between
      // "server not started yet" vs "server URL wrong" vs "network issue"
      console.error('[httpClient] Health check failed:', err);
      return false;
    }
  }

  async getStateHash(): Promise<StateHashResponse> {
    const response = await fetch(`${this.url}/api/v1/state/hash`, {
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
    };
  }

  /**
   * Fetch the JSON export from the server (FLO-393).
   * Single source of truth — both ⌘⇧J and API consumers use this path.
   * Returns the raw JSON string (caller handles save dialog).
   */
  async exportJSON(): Promise<string> {
    const response = await fetch(`${this.url}/api/v1/export/json`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to export JSON: ${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  async getUpdatesSince(since: number, limit: number = 100): Promise<UpdatesSinceResult> {
    const url = new URL(`${this.url}/api/v1/updates`);
    url.searchParams.set('since', String(since));
    url.searchParams.set('limit', String(limit));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers(),
    });

    // 410 Gone - client requested updates that have been compacted
    if (response.status === 410) {
      const data: UpdatesCompactedError = await response.json();
      console.warn(
        `[httpClient] Updates compacted: requested since ${data.requestedSince}, compacted through ${data.compactedThrough}`
      );
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
        console.log(`[httpClient] Connected to floatty-server at ${serverInfo.url}`);
        return clientInstance;
      } catch (err) {
        lastError = err;
        if (attempt < delays.length) {
          console.log(`[httpClient] Server not ready, retrying in ${delays[attempt]}ms (attempt ${attempt + 1}/${delays.length}): ${err}`);
          await new Promise(r => setTimeout(r, delays[attempt]));
        }
      }
    }

    throw lastError ?? new Error('Server connection failed after retries');
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
    console.log('[httpClient] HMR cleanup');
    clientInstance = null;
    initPromise = null;
  });
}
