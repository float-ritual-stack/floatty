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

/** HTTP client interface for Y.Doc sync */
export interface FloattyHttpClient {
  /** Get full Y.Doc state from server */
  getState(): Promise<Uint8Array>;
  /** Get state vector for reconciliation (what updates server has) */
  getStateVector(): Promise<Uint8Array>;
  /** Send update delta to server. Optional txId for echo prevention. */
  applyUpdate(update: Uint8Array, txId?: string): Promise<void>;
  /** Health check */
  isHealthy(): Promise<boolean>;
  /** Get state hash for sync health check (lightweight) */
  getStateHash(): Promise<StateHashResponse>;
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

  async getState(): Promise<Uint8Array> {
    const response = await fetch(`${this.url}/api/v1/state`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get state: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    // Server returns { state: "base64..." }
    if (!data.state) {
      throw new Error('Invalid response: missing state field');
    }

    return base64ToBytes(data.state);
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

  // Start initialization
  initPromise = (async () => {
    try {
      // Get server info from Tauri (contains URL and API key)
      const serverInfo = await invoke('get_server_info', {});
      const client = new HttpClient(serverInfo);

      // Store URL and API key globally for other modules (WebSocket, search handler)
      window.__FLOATTY_SERVER_URL__ = serverInfo.url;
      window.__FLOATTY_API_KEY__ = serverInfo.api_key;

      // Verify connection before committing to this client
      const healthy = await client.isHealthy();
      if (!healthy) {
        throw new Error('Server health check failed');
      }

      // Only set instance after successful health check
      clientInstance = client;
      console.log(`[httpClient] Connected to floatty-server at ${serverInfo.url}`);
      return clientInstance;
    } catch (err) {
      // Clear promise AFTER rejection propagates (prevents race with concurrent callers)
      initPromise = null;
      throw err;
    }
  })();

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
