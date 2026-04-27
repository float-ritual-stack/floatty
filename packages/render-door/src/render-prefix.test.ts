/**
 * Tests for stripJsonPrefix and bytesToHexPreview — defensive parsing for
 * the claude --output-format json wrapper. The failure mode these defend
 * against is environmental: Tauri's execute_shell sources user shell rc
 * files in a non-TTY context, leaking ANSI escapes to stdout. See
 * stripJsonPrefix doc-comment in render.tsx for full context.
 */

import { describe, it, expect } from 'vitest';
import { stripJsonPrefix, bytesToHexPreview } from './render';

const ESC = '';
const BOM = '﻿';
const ZWSP = '​';

describe('stripJsonPrefix', () => {
  it('returns clean when input starts with `{`', () => {
    const r = stripJsonPrefix('{"a":1}');
    expect(r.kind).toBe('clean');
    expect(r.cleaned).toBe('{"a":1}');
    expect(r.strippedLen).toBe(0);
    expect(r.strippedHex).toBeNull();
  });

  it('trims leading/trailing whitespace on clean input', () => {
    const r = stripJsonPrefix('  {"a":1}  \n');
    expect(r.kind).toBe('clean');
    expect(r.cleaned).toBe('{"a":1}');
  });

  it('strips an ANSI CSI escape sequence (the actual failure mode)', () => {
    // Cursor-hide CSI: ESC [ ? 2 5 l
    const ansi = `${ESC}[?25l`;
    const wrapper = '{"type":"result","is_error":false}';
    const r = stripJsonPrefix(ansi + wrapper);
    expect(r.kind).toBe('stripped');
    expect(r.cleaned).toBe(wrapper);
    expect(r.strippedLen).toBe(ansi.length);
    // ESC=1b, [=5b, ?=3f, 2=32, 5=35, l=6c
    expect(r.strippedHex).toBe('1b 5b 3f 32 35 6c');
  });

  it('strips a terminal-title sequence', () => {
    // OSC 0 ; title BEL
    const osc = `${ESC}]0;some title`;
    const wrapper = '{"type":"result"}';
    const r = stripJsonPrefix(osc + wrapper);
    expect(r.kind).toBe('stripped');
    expect(r.cleaned).toBe(wrapper);
    expect(r.strippedLen).toBe(osc.length);
  });

  it('handles UTF-8 BOM as harmless whitespace (no log noise)', () => {
    // BOM (U+FEFF) is in ECMA-262's WhiteSpace set, so trimStart() removes
    // it. Treat as 'clean' — no spurious "stripped 1 byte" log entries.
    const r = stripJsonPrefix(BOM + '{"a":1}');
    expect(r.kind).toBe('clean');
    expect(r.cleaned).toBe('{"a":1}');
  });

  it('strips ANSI escape after a leading BOM', () => {
    // BOM is whitespace, but ESC isn't — so the combo still triggers
    // 'stripped' and logs hex of the ESC sequence (BOM was already trimmed).
    const r = stripJsonPrefix(`${BOM}${ESC}[?25l{"a":1}`);
    expect(r.kind).toBe('stripped');
    expect(r.cleaned).toBe('{"a":1}');
    expect(r.strippedHex).toBe('1b 5b 3f 32 35 6c');
  });

  it('strips zero-width spaces', () => {
    const r = stripJsonPrefix(`${ZWSP}${ZWSP}{"a":1}`);
    expect(r.kind).toBe('stripped');
    expect(r.cleaned).toBe('{"a":1}');
  });

  it('strips garbage prose before the wrapper', () => {
    // Hypothetical: stderr leaked into stdout via shell trace
    const noise = 'Warning: starting in non-TTY mode\n';
    const r = stripJsonPrefix(noise + '{"a":1}');
    expect(r.kind).toBe('stripped');
    expect(r.cleaned).toBe('{"a":1}');
    expect(r.strippedLen).toBe(noise.length);
  });

  it('returns no-brace when input contains no `{` at all', () => {
    const r = stripJsonPrefix('garbage no json here');
    expect(r.kind).toBe('no-brace');
    expect(r.cleaned).toBe('');
  });

  it('returns no-brace on empty input', () => {
    const r = stripJsonPrefix('');
    expect(r.kind).toBe('no-brace');
  });

  it('cleaned output is JSON.parse-safe after a real ANSI prefix', () => {
    // End-to-end: simulate a real failing payload and confirm parse
    // succeeds after strip.
    const fakeWrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: { root: 'a', elements: { a: { type: 'Text', props: { content: 'hi' } } } },
    });
    const corrupted = `${ESC}[?25l${ESC}[2K` + fakeWrapper;
    const r = stripJsonPrefix(corrupted);
    expect(r.kind).toBe('stripped');
    const parsed = JSON.parse(r.cleaned) as { type: string; structured_output: { root: string } };
    expect(parsed.type).toBe('result');
    expect(parsed.structured_output.root).toBe('a');
  });
});

describe('bytesToHexPreview', () => {
  it('renders ASCII as hex pairs separated by spaces', () => {
    expect(bytesToHexPreview('abc', 64)).toBe('61 62 63');
  });

  it('renders ESC and other unprintables', () => {
    expect(bytesToHexPreview('[?', 64)).toBe('1b 5b 3f');
  });

  it('truncates to maxBytes', () => {
    expect(bytesToHexPreview('abcdef', 3)).toBe('61 62 63');
  });

  it('handles empty input', () => {
    expect(bytesToHexPreview('', 64)).toBe('');
  });
});
