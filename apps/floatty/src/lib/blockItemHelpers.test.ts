import { describe, it, expect } from 'vitest';
import { isOutputBlock, hasCollapsibleOutput, resolveImgFilename, deriveDoorTitle } from './blockItemHelpers';
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

describe('deriveDoorTitle (v0.14.4 — fix cohabitation overlap)', () => {
  // The contract: door blocks should always land in title-mode by default,
  // hiding contentEditable to prevent the multiline raw-content overlap with
  // the rendered door view. Title resolution covers both new (projection-
  // contract) and legacy (`render:: {full JSON}`) shapes.

  it('returns null for non-door blocks', () => {
    expect(deriveDoorTitle(makeBlock({ outputType: 'eval-result', content: 'sh:: echo hi' }))).toBeNull();
    expect(deriveDoorTitle(makeBlock({ outputType: 'search-results' }))).toBeNull();
    expect(deriveDoorTitle(makeBlock({ content: 'plain text' }))).toBeNull();
  });

  it('returns null for door blocks without output (still pre-execute)', () => {
    expect(deriveDoorTitle(makeBlock({ outputType: 'door', content: 'render:: foo' }))).toBeNull();
  });

  it('NEW path — uses content directly when content is the semantic title', () => {
    const block = makeBlock({
      outputType: 'door',
      content: 'Real Bugs Quartet — Test-First Territory',
      output: { data: { spec: { root: 'r', elements: {} } } },
    });
    expect(deriveDoorTitle(block)).toBe('Real Bugs Quartet — Test-First Territory');
  });

  it('NEW path — rejects content that looks like JSON (defensive)', () => {
    const block = makeBlock({
      outputType: 'door',
      content: '{"root":"r","elements":{}}',
      output: { data: { title: 'Fallback Title', spec: {} } },
    });
    // Content starts with `{` → reject → fall through to output.data.title
    expect(deriveDoorTitle(block)).toBe('Fallback Title');
  });

  it('LEGACY path — uses output.data.title for `render:: {json}` blocks', () => {
    const block = makeBlock({
      outputType: 'door',
      content: 'render:: {"root":"r","elements":{}}',
      output: { data: { title: 'LLM-Generated Title' } },
    });
    expect(deriveDoorTitle(block)).toBe('LLM-Generated Title');
  });

  it('LEGACY path — falls back to spec.title when async title-gen has not landed', () => {
    const block = makeBlock({
      outputType: 'door',
      content: 'render:: {"root":"r","title":"Spec Title","elements":{}}',
      output: { data: { spec: { title: 'Spec Title', root: 'r', elements: {} } } },
      // ↑ note: no top-level data.title (async title-gen race)
    });
    expect(deriveDoorTitle(block)).toBe('Spec Title');
  });

  it('LEGACY path — rejects long output titles (>120 chars)', () => {
    const longTitle = 'x'.repeat(150);
    const block = makeBlock({
      outputType: 'door',
      content: 'render:: {"root":"r","title":"Short Spec Title","elements":{}}',
      output: { data: { title: longTitle, spec: { title: 'Short Spec Title' } } },
    });
    // Long title rejected, falls through to spec.title
    expect(deriveDoorTitle(block)).toBe('Short Spec Title');
  });

  it('LEGACY path — rejects titles that look like JSON', () => {
    const block = makeBlock({
      outputType: 'door',
      content: 'render:: {"root":"r","title":"Real Title","elements":{}}',
      output: { data: { title: '{"oops":"json"}', spec: { title: 'Real Title' } } },
    });
    expect(deriveDoorTitle(block)).toBe('Real Title');
  });

  it('returns null when no resolution arm produces a clean title', () => {
    const block = makeBlock({
      outputType: 'door',
      content: 'render:: {"oops":"no spec title"}',
      output: { data: { spec: { root: 'r', elements: {} } } }, // no titles anywhere
    });
    // No clean title → caller falls back to contentEditable display
    expect(deriveDoorTitle(block)).toBeNull();
  });

  it('NEW path beats LEGACY arms — content wins when not render:: shape', () => {
    const block = makeBlock({
      outputType: 'door',
      content: 'New Path Title',
      output: { data: { title: 'Should be ignored', spec: { title: 'Also ignored' } } },
    });
    expect(deriveDoorTitle(block)).toBe('New Path Title');
  });

  it('returns null for undefined block', () => {
    expect(deriveDoorTitle(undefined)).toBeNull();
  });

  it('LEGACY path — leading whitespace on `render::` prefix routes to fallback arms (CodeRabbit fix)', () => {
    // CR-flagged: "  render:: {...}" content used to slip through the
    // !isLegacyRenderShape guard and return raw source as the "title".
    // trimStart() in deriveDoorTitle now normalizes before the prefix check,
    // so leading whitespace routes through output.data.title / spec.title.
    const block = makeBlock({
      outputType: 'door',
      content: '  render:: {"root":"r","title":"Whitespace Title","elements":{}}',
      output: { data: { title: 'LLM-Generated Title', spec: { title: 'Whitespace Title' } } },
    });
    expect(deriveDoorTitle(block)).toBe('LLM-Generated Title');
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
