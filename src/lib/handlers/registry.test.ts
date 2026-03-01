import { describe, it, expect, beforeEach } from 'vitest';
import { HandlerRegistry } from './registry';
import type { BlockHandler } from './types';

function stubHandler(prefixes: string[]): BlockHandler {
  return {
    prefixes,
    execute: async () => {},
  };
}

describe('HandlerRegistry', () => {
  let reg: HandlerRegistry;

  beforeEach(() => {
    reg = new HandlerRegistry();
  });

  it('finds handler by lowercase prefix', () => {
    reg.register(stubHandler(['sh::']));
    expect(reg.findHandler('sh:: ls')).not.toBeNull();
  });

  it('matches case-insensitively on content', () => {
    reg.register(stubHandler(['daily::']));
    expect(reg.findHandler('Daily:: today')).not.toBeNull();
    expect(reg.findHandler('DAILY::')).not.toBeNull();
  });

  it('matches mixed-case prefixes against lowercase content', () => {
    reg.register(stubHandler(['extractTo::']));
    expect(reg.findHandler('extractto:: [[Page]]')).not.toBeNull();
    expect(reg.findHandler('extractTo:: [[Page]]')).not.toBeNull();
    expect(reg.findHandler('EXTRACTTO:: [[Page]]')).not.toBeNull();
  });

  it('returns null for non-matching content', () => {
    reg.register(stubHandler(['sh::']));
    expect(reg.findHandler('plain text')).toBeNull();
  });

  it('isExecutableBlock delegates to findHandler', () => {
    reg.register(stubHandler(['ai::']));
    expect(reg.isExecutableBlock('ai:: prompt')).toBe(true);
    expect(reg.isExecutableBlock('not a command')).toBe(false);
  });

  it('getRegisteredPrefixes returns all prefixes', () => {
    reg.register(stubHandler(['sh::']));
    reg.register(stubHandler(['extractto::', 'extract::']));
    expect(reg.getRegisteredPrefixes()).toEqual(['sh::', 'extractto::', 'extract::']);
  });

  it('clear removes all handlers', () => {
    reg.register(stubHandler(['sh::']));
    reg.clear();
    expect(reg.findHandler('sh:: ls')).toBeNull();
    expect(reg.getRegisteredPrefixes()).toEqual([]);
  });
});
