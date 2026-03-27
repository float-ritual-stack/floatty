/**
 * Shared door type definitions.
 * Doors compile to standalone bundles — this file is the shared contract
 * between DoorHost (src/) and door implementations (doors/).
 */

export interface DoorViewProps<T = unknown> {
  data: T;
  settings: Record<string, unknown>;
  server: {
    url: string;
    wsUrl: string;
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  onNavigateOut?: (direction: 'up' | 'down') => void;
  onNavigate?: (target: string, opts?: { type?: 'page' | 'block'; splitDirection?: 'horizontal' | 'vertical' }) => void;
  onChirp?: (message: string, data?: unknown) => void;
}

export interface DoorContext {
  server: { fetch(path: string, init?: RequestInit): Promise<Response> };
  settings: Record<string, unknown>;
  log: (...args: unknown[]) => void;
}

export interface DoorResult<T> {
  data: T;
  error?: string;
}
