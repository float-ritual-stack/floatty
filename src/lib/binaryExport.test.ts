/**
 * binaryExport.test.ts - Tests for binary Y.Doc export/restore
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { exportBinary, exportBinaryBase64, restoreBinary } from './binaryExport';

describe('exportBinary', () => {
  it('exports empty doc as small Uint8Array', () => {
    const doc = new Y.Doc();
    const state = exportBinary(doc);

    expect(state).toBeInstanceOf(Uint8Array);
    // Empty doc should be very small (typically 2 bytes for empty state)
    expect(state.length).toBeLessThan(10);
  });

  it('exports doc with data as larger Uint8Array', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('test');
    map.set('key', 'value');
    map.set('nested', { a: 1, b: 2 });

    const state = exportBinary(doc);

    expect(state).toBeInstanceOf(Uint8Array);
    expect(state.length).toBeGreaterThan(10);
  });

  it('export is deterministic for same doc state', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('test');
    map.set('key', 'value');

    const state1 = exportBinary(doc);
    const state2 = exportBinary(doc);

    expect(state1).toEqual(state2);
  });
});

describe('exportBinaryBase64', () => {
  it('exports as valid base64 string', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('test');
    map.set('key', 'value');

    const base64 = exportBinaryBase64(doc);

    expect(typeof base64).toBe('string');
    // Valid base64 should only contain these characters
    expect(base64).toMatch(/^[A-Za-z0-9+/]*=*$/);
  });

  it('base64 can be decoded back to binary', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('test');
    map.set('key', 'test-value');

    const base64 = exportBinaryBase64(doc);
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

    // Should be able to apply to new doc
    const restored = new Y.Doc();
    Y.applyUpdate(restored, binary);

    expect(restored.getMap('test').get('key')).toBe('test-value');
  });
});

describe('restoreBinary', () => {
  it('restores empty doc correctly', () => {
    const original = new Y.Doc();
    const state = exportBinary(original);

    const restored = new Y.Doc();
    restoreBinary(restored, state);

    // Both should have same encoded state
    expect(exportBinary(restored)).toEqual(state);
  });

  it('restores doc with map data', () => {
    const original = new Y.Doc();
    const map = original.getMap('blocks');
    map.set('block-1', { content: 'Hello', childIds: ['a', 'b'] });
    map.set('block-2', { content: 'World', childIds: [] });

    const state = exportBinary(original);

    const restored = new Y.Doc();
    restoreBinary(restored, state);

    const restoredMap = restored.getMap('blocks');
    expect(restoredMap.get('block-1')).toEqual({ content: 'Hello', childIds: ['a', 'b'] });
    expect(restoredMap.get('block-2')).toEqual({ content: 'World', childIds: [] });
  });

  it('restores doc with array data', () => {
    const original = new Y.Doc();
    const arr = original.getArray<string>('rootIds');
    arr.push(['root-1', 'root-2', 'root-3']);

    const state = exportBinary(original);

    const restored = new Y.Doc();
    restoreBinary(restored, state);

    const restoredArr = restored.getArray<string>('rootIds');
    expect(restoredArr.toArray()).toEqual(['root-1', 'root-2', 'root-3']);
  });

  it('merges into existing doc (CRDT behavior)', () => {
    // Original doc with block-1
    const doc1 = new Y.Doc();
    doc1.getMap('blocks').set('block-1', { content: 'From doc1' });

    // Another doc with block-2
    const doc2 = new Y.Doc();
    doc2.getMap('blocks').set('block-2', { content: 'From doc2' });

    // Export doc2 state
    const state2 = exportBinary(doc2);

    // Restore doc2's state into doc1 - should merge
    restoreBinary(doc1, state2);

    const mergedMap = doc1.getMap('blocks');
    expect(mergedMap.get('block-1')).toEqual({ content: 'From doc1' });
    expect(mergedMap.get('block-2')).toEqual({ content: 'From doc2' });
  });

  it('uses binary-restore origin', () => {
    // Need non-empty state to trigger update event
    const sourceDoc = new Y.Doc();
    sourceDoc.getMap('test').set('key', 'value');
    const state = exportBinary(sourceDoc);

    const targetDoc = new Y.Doc();
    const origins: (string | undefined)[] = [];

    targetDoc.on('update', (_update, origin) => {
      origins.push(origin);
    });

    restoreBinary(targetDoc, state);

    expect(origins).toContain('binary-restore');
  });
});

describe('round-trip', () => {
  it('full floatty-like structure survives round-trip', () => {
    const original = new Y.Doc();

    // Set up blocks map (like floatty)
    const blocks = original.getMap('blocks');
    blocks.set('root-1', {
      content: '## here be dragons',
      parentId: null,
      childIds: ['child-1', 'child-2'],
      type: 'text',
      collapsed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { markers: [] },
    });
    blocks.set('child-1', {
      content: 'First child',
      parentId: 'root-1',
      childIds: [],
      type: 'text',
      collapsed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    });
    blocks.set('child-2', {
      content: 'Second child',
      parentId: 'root-1',
      childIds: [],
      type: 'text',
      collapsed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    });

    // Set up rootIds array
    const rootIds = original.getArray<string>('rootIds');
    rootIds.push(['root-1']);

    // Export
    const state = exportBinary(original);

    // Restore to fresh doc
    const restored = new Y.Doc();
    restoreBinary(restored, state);

    // Verify structure
    const restoredBlocks = restored.getMap('blocks');
    const restoredRoots = restored.getArray<string>('rootIds');

    expect(restoredRoots.toArray()).toEqual(['root-1']);
    expect(restoredBlocks.size).toBe(3);

    const root = restoredBlocks.get('root-1') as Record<string, unknown>;
    expect(root.content).toBe('## here be dragons');
    expect(root.childIds).toEqual(['child-1', 'child-2']);
  });
});
