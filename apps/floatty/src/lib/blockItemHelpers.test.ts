import { describe, it, expect } from 'vitest';
import { isOutputBlock, hasCollapsibleOutput, resolveImgFilename } from './blockItemHelpers';
import type { Block } from './blockTypes';

/** Minimal block factory — only fields these helpers read */
function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'test',
    parentId: null,
    childIds: [],
    content: '',
    type: 'text',
    collapsed: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('isOutputBlock', () => {
  it('returns true for search-results', () => {
    expect(isOutputBlock(makeBlock({ outputType: 'search-results' }))).toBe(true);
  });

  it('returns true for search-error', () => {
    expect(isOutputBlock(makeBlock({ outputType: 'search-error' }))).toBe(true);
  });

  it('returns true for img-view', () => {
    expect(isOutputBlock(makeBlock({ outputType: 'img-view' }))).toBe(true);
  });

  it('returns true for door with empty content (adapter child)', () => {
    expect(isOutputBlock(makeBlock({ outputType: 'door', content: '' }))).toBe(true);
  });

  it('returns false for door with content (selfRender keeps contentEditable)', () => {
    expect(isOutputBlock(makeBlock({ outputType: 'door', content: 'render:: hello' }))).toBe(false);
  });

  it('returns false for eval-result (inline output, not replacement)', () => {
    expect(isOutputBlock(makeBlock({ outputType: 'eval-result' }))).toBe(false);
  });

  it('returns false for undefined block', () => {
    expect(isOutputBlock(undefined)).toBe(false);
  });

  it('returns false for block with no outputType', () => {
    expect(isOutputBlock(makeBlock())).toBe(false);
  });
});

describe('hasCollapsibleOutput', () => {
  it('returns true for eval-result with output', () => {
    expect(hasCollapsibleOutput(makeBlock({ outputType: 'eval-result', output: { result: 42 } }))).toBe(true);
  });

  it('returns true for door with content and output (selfRender inline)', () => {
    expect(hasCollapsibleOutput(makeBlock({
      outputType: 'door',
      content: 'render:: hello',
      output: { data: {} },
    }))).toBe(true);
  });

  it('returns false for door with empty content (adapter — handled by isOutputBlock)', () => {
    expect(hasCollapsibleOutput(makeBlock({ outputType: 'door', content: '', output: { data: {} } }))).toBe(false);
  });

  it('returns false when no output', () => {
    expect(hasCollapsibleOutput(makeBlock({ outputType: 'eval-result' }))).toBe(false);
  });

  it('returns false for search-results (not collapsible, it replaces)', () => {
    expect(hasCollapsibleOutput(makeBlock({ outputType: 'search-results', output: { hits: [] } }))).toBe(false);
  });

  it('returns false for undefined block', () => {
    expect(hasCollapsibleOutput(undefined)).toBe(false);
  });
});

describe('isOutputBlock / hasCollapsibleOutput contract', () => {
  it('door + empty content: isOutputBlock=true, hasCollapsibleOutput=false', () => {
    const block = makeBlock({ outputType: 'door', content: '', output: { data: {} } });
    expect(isOutputBlock(block)).toBe(true);
    expect(hasCollapsibleOutput(block)).toBe(false);
  });

  it('door + content + output: isOutputBlock=false, hasCollapsibleOutput=true', () => {
    const block = makeBlock({ outputType: 'door', content: 'render:: hello', output: { data: {} } });
    expect(isOutputBlock(block)).toBe(false);
    expect(hasCollapsibleOutput(block)).toBe(true);
  });

  it('mutual exclusivity: no block can be both output-replacing AND collapsible', () => {
    const outputTypes = ['search-results', 'search-error', 'img-view', 'eval-result', 'door', undefined];
    const contents = ['', 'render:: hello', 'sh:: echo hi'];
    const outputs = [undefined, { data: {} }, { hits: [] }];

    for (const outputType of outputTypes) {
      for (const content of contents) {
        for (const output of outputs) {
          const block = makeBlock({ outputType, content, output });
          const isOutput = isOutputBlock(block);
          const isCollapsible = hasCollapsibleOutput(block);

          if (isOutput && isCollapsible) {
            throw new Error(
              `Contract violation: block is both output-replacing AND collapsible. ` +
              `outputType=${outputType}, content="${content}", output=${JSON.stringify(output)}`
            );
          }
        }
      }
    }
  });
});

describe('resolveImgFilename', () => {
  it('extracts filename from simple img:: content', () => {
    expect(resolveImgFilename('img:: photo.jpg')).toBe('photo.jpg');
  });

  it('strips absolute path to basename', () => {
    expect(resolveImgFilename('img:: /Users/evan/.floatty/__attachments/photo.jpg')).toBe('photo.jpg');
  });

  it('strips Windows-style path', () => {
    expect(resolveImgFilename('img:: C:\\Users\\evan\\photo.png')).toBe('photo.png');
  });

  it('returns null for no recognized extension', () => {
    expect(resolveImgFilename('img:: test')).toBeNull();
  });

  it('returns null for empty content after prefix', () => {
    expect(resolveImgFilename('img::')).toBeNull();
  });

  it('returns null for non-img content', () => {
    expect(resolveImgFilename('sh:: echo hi')).toBeNull();
  });

  it('handles case-insensitive prefix', () => {
    expect(resolveImgFilename('IMG:: Photo.PNG')).toBe('Photo.PNG');
  });

  it('handles whitespace after prefix', () => {
    expect(resolveImgFilename('img::   photo.jpg')).toBe('photo.jpg');
  });

  it('recognizes all supported extensions', () => {
    const extensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'pdf', 'html', 'htm'];
    for (const ext of extensions) {
      expect(resolveImgFilename(`img:: test.${ext}`)).toBe(`test.${ext}`);
    }
  });
});
