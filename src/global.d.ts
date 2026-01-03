/**
 * Global type declarations for floatty.
 */

declare global {
  interface Window {
    /** Server URL for WebSocket connection, set by httpClient */
    __FLOATTY_SERVER_URL__?: string;
  }
}

export {};
