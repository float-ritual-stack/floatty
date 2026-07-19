import { describe, it, expect } from 'vitest';
import { render } from '@solidjs/testing-library';
import { BlockDisplay } from './BlockDisplay';

describe('BlockDisplay', () => {
  it('falls back to plain text when parse hint is true but parser yields no tokens', () => {
    const content = 'text ## nope';
    const { container } = render(() => <BlockDisplay content={content} />);

    const overlay = container.querySelector('.block-display');
    expect(overlay).toBeInTheDocument();
    expect(overlay?.textContent).toBe(content);
  });

  it('never renders empty overlay text for :: content while typing', () => {
    const content = '[sc::';
    const { container } = render(() => <BlockDisplay content={content} />);

    const overlay = container.querySelector('.block-display');
    expect(overlay).toBeInTheDocument();
    expect(overlay?.textContent).toBe(content);
    expect(overlay?.textContent).not.toBe('');
  });

  // ADR-008 D4 stub styling: a path link ([[page > section > block]]) is a
  // stub only when its FIRST segment (the page) is missing — trailing segments
  // are descendant selectors, not page names. Regression for the live-QA
  // finding where [[test test > Friday, July 10 — Rexall / Catalyst]] rendered
  // stub-styled even though its page resolved.
  describe('path-link stub styling keys on the first segment', () => {
    const pageNameSet = new Set(['alpha']); // only "alpha" exists

    it('does NOT style a path link stub when its first-segment page exists', () => {
      const { container } = render(() => (
        <BlockDisplay content={'[[Alpha > Section B > Block]]'} pageNameSet={pageNameSet} />
      ));
      expect(container.querySelector('.md-wikilink')).toBeInTheDocument();
      expect(container.querySelector('.md-wikilink-stub')).toBeNull();
    });

    it('DOES style a path link stub when its first-segment page is missing', () => {
      const { container } = render(() => (
        <BlockDisplay content={'[[Ghost > Section B > Block]]'} pageNameSet={pageNameSet} />
      ));
      expect(container.querySelector('.md-wikilink-stub')).toBeInTheDocument();
    });

    it('leaves single-segment stub detection unchanged', () => {
      const existing = render(() => (
        <BlockDisplay content={'[[Alpha]]'} pageNameSet={pageNameSet} />
      ));
      expect(existing.container.querySelector('.md-wikilink-stub')).toBeNull();

      const missing = render(() => (
        <BlockDisplay content={'[[Ghost]]'} pageNameSet={pageNameSet} />
      ));
      expect(missing.container.querySelector('.md-wikilink-stub')).toBeInTheDocument();
    });
  });
});
