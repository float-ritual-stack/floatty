/**
 * httpClient.ts - HTTP client for floatty-server communication
 *
 * Replaces Tauri IPC for Y.Doc sync operations.
 * Server is spawned by Tauri on app start; this client connects to it.
 */

import { invoke } from './tauriTypes';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/** Server info returned from Tauri's get_server_info command */
export interface ServerInfo {
  url: string;
  api_key: string;
}

/** HTTP client interface for Y.Doc sync */
export interface FloattyHttpClient {
  /** Get full Y.Doc state from server */
  getState(): Promise<Uint8Array>;
  /** Send update delta to server */
  applyUpdate(update: Uint8Array): Promise<void>;
  /** Health check */
  isHealthy(): Promise<boolean>;
}

// ═══════════════════════════════════════════════════════════════
// BASE64 UTILITIES
// ═══════════════════════════════════════════════════════════════

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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

  async applyUpdate(update: Uint8Array): Promise<void> {
    const updateB64 = bytesToBase64(update);

    const response = await fetch(`${this.url}/api/v1/update`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ update: updateB64 }),
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
      return response.ok;
    } catch {
      return false;
    }
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
    // Get server info from Tauri (contains URL and API key)
    const serverInfo = await invoke('get_server_info', {});
    clientInstance = new HttpClient(serverInfo);

    // Store URL globally for WebSocket connection
    (window as any).__FLOATTY_SERVER_URL__ = serverInfo.url;

    // Verify connection
    const healthy = await clientInstance.isHealthy();
    if (!healthy) {
      throw new Error('Server health check failed');
    }

    console.log(`[httpClient] Connected to floatty-server at ${serverInfo.url}`);
    return clientInstance;
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
