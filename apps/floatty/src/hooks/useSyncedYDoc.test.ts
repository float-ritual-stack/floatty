/**
 * useSyncedYDoc tests
 *
 * Tests pure functions and singleton behavior.
 * The hook itself requires Tauri IPC, tested via integration.
 */

import { describe, it, expect } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  getSharedDoc,
  resolveReconnectBufferAction,
  shouldStartOverflowRecovery,
} from './useSyncedYDoc';

describe('base64 utilities', () => {
  it('round-trips binary data', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const encoded = bytesToBase64(original);
    const decoded = base64ToBytes(encoded);

    expect(decoded).toEqual(original);
  });

  it('handles empty array', () => {
    const empty = new Uint8Array([]);
    const encoded = bytesToBase64(empty);
    const decoded = base64ToBytes(encoded);

    expect(decoded).toEqual(empty);
  });

  it('handles UTF-8 text as bytes', () => {
    const text = 'Hello, World!';
    const bytes = new TextEncoder().encode(text);
    const encoded = bytesToBase64(bytes);
    const decoded = base64ToBytes(encoded);

    expect(new TextDecoder().decode(decoded)).toBe(text);
  });
});

describe('Y.Doc singleton', () => {
  it('returns the same instance on multiple calls', () => {
    const doc1 = getSharedDoc();
    const doc2 = getSharedDoc();

    expect(doc1).toBe(doc2);
  });

  it('persists data across calls', () => {
    const doc = getSharedDoc();
    const map = doc.getMap('test-singleton-persist');

    // Ensure clean state
    map.clear();

    // Write some data
    map.set('key', 'value');

    // Get doc again and verify data persists
    const doc2 = getSharedDoc();
    const map2 = doc2.getMap('test-singleton-persist');

    expect(map2.get('key')).toBe('value');
  });
});

describe('reconnect buffer overflow guards', () => {
  it('buffers while under capacity', () => {
    expect(resolveReconnectBufferAction(10, 100, false)).toBe('buffer');
  });

  it('latches overflow on first capacity breach', () => {
    expect(resolveReconnectBufferAction(100, 100, false)).toBe('overflow-first');
  });

  it('continues dropping while overflow is latched', () => {
    expect(resolveReconnectBufferAction(0, 100, true)).toBe('overflow-repeat');
    expect(resolveReconnectBufferAction(100, 100, true)).toBe('overflow-repeat');
  });

  it('starts overflow recovery only when latched and not already running', () => {
    expect(shouldStartOverflowRecovery(true, false)).toBe(true);
    expect(shouldStartOverflowRecovery(true, true)).toBe(false);
    expect(shouldStartOverflowRecovery(false, false)).toBe(false);
  });
});

describe('buildWsUrl (FLO-762 WS auth)', () => {
  it('converts http to ws and appends /ws', async () => {
    const { buildWsUrl } = await import('./useSyncedYDoc');
    expect(buildWsUrl('http://127.0.0.1:8765', undefined)).toBe('ws://127.0.0.1:8765/ws');
  });

  it('converts https to wss (tailscale serve case)', async () => {
    const { buildWsUrl } = await import('./useSyncedYDoc');
    expect(buildWsUrl('https://float-box.tailnet.ts.net', undefined)).toBe(
      'wss://float-box.tailnet.ts.net/ws'
    );
  });

  it('appends the API key as an encoded query token', async () => {
    const { buildWsUrl } = await import('./useSyncedYDoc');
    expect(buildWsUrl('http://float-box:8765', 'floatty-abc123')).toBe(
      'ws://float-box:8765/ws?token=floatty-abc123'
    );
    // Characters needing encoding stay unambiguous in the query string
    expect(buildWsUrl('http://float-box:8765', 'k&y=v')).toBe(
      'ws://float-box:8765/ws?token=k%26y%3Dv'
    );
  });
});
