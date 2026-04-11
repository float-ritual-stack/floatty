import { describe, it, expect } from 'vitest';
import { getPageTitle } from './useBacklinkNavigation';

describe('getPageTitle', () => {
  it('strips heading prefix from single-line content', () => {
    expect(getPageTitle('# My Page')).toBe('My Page');
    expect(getPageTitle('## Sub Page')).toBe('Sub Page');
    expect(getPageTitle('### Deep')).toBe('Deep');
  });

  it('returns first line only from multi-line content', () => {
    const content = '# Pebble Exchange Summary\n[board:: recon] [date:: 2026-02-24]';
    expect(getPageTitle(content)).toBe('Pebble Exchange Summary');
  });

  it('strips heading AND takes first line for multi-line with metadata', () => {
    const content = '# Summary: 2026-02-24 — Agent Tooling\n[board:: recon]\n[relates:: [[other]]]';
    expect(getPageTitle(content)).toBe('Summary: 2026-02-24 — Agent Tooling');
  });

  it('returns content as-is when no heading prefix', () => {
    expect(getPageTitle('No prefix here')).toBe('No prefix here');
  });

  it('returns empty string for empty input', () => {
    expect(getPageTitle('')).toBe('');
  });

  it('preserves wikilinks in heading', () => {
    expect(getPageTitle('# meeting:: [[nick <--> evan]]')).toBe('meeting:: [[nick <--> evan]]');
  });

  it('trims whitespace', () => {
    expect(getPageTitle('#   Spaced Out  ')).toBe('Spaced Out');
  });

  it('handles content with only newlines after first line', () => {
    expect(getPageTitle('# Title\n\n\n')).toBe('Title');
  });

  it('handles first line without heading but multi-line', () => {
    const content = 'plain title\nsome metadata';
    expect(getPageTitle(content)).toBe('plain title');
  });
});
