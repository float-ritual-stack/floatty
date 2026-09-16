import { createSignal } from 'solid-js';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import { InlineContent, BlockDisplay, isWikilinkStub } from './BlockDisplay';

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

  // Pure-helper coverage (store-first testing): the same logic the component
  // consumes, exercised without mounting — CodeRabbit nitpick on PR #366.
  describe('isWikilinkStub (pure)', () => {
    const pages = new Set(['alpha']);
    const stubs = new Set<string>();

    it('path target keys on first segment', () => {
      expect(isWikilinkStub('Alpha > Deep > Deeper', pages, stubs)).toBe(false);
      expect(isWikilinkStub('Ghost > Deep', pages, stubs)).toBe(true);
    });

    it('block-id refs are never stubs', () => {
      expect(isWikilinkStub('d3599940', pages, stubs)).toBe(false);
    });

    it('existing-but-empty page is a stub', () => {
      expect(isWikilinkStub('Alpha', pages, new Set(['alpha']))).toBe(true);
    });

    it('no pageNameSet → never stub', () => {
      expect(isWikilinkStub('Anything > At All', undefined, undefined)).toBe(false);
    });
  });
});


describe('pretty InlineContent (overlay rendering remains inert by default)', () => {
  it.each([
    ['**bold** and *italic* and `code`', 'bold and italic and code'],
    ['_under_ and snake_case_name', 'under and snake_case_name'],
    ['*snake_case*', 'snake_case'],
    ['**[[DEMO-107|big item]] DONE** — tail', 'big item DONE — tail'],
    ['[[uglyLinks|are pretty]]', 'are pretty'],
    ['[[Demo|alias with [[Nested|inner]] link]]', 'alias with inner link'],
    ['## **Heading**', '## Heading'],
    ['`[[Demo|label]]`', 'label'],
  ])('renders the canonical tokens pretty: %s', (content, expected) => {
    const pretty = render(() => <InlineContent content={content} pretty />);
    expect(pretty.container.textContent).toBe(expected);
    expect(pretty.container.querySelector('.md-wikilink-punct')).toBeNull();
    const raw = render(() => <InlineContent content={content} />);
    expect(raw.container.textContent).toBe(content);
  });
  it('colours each heading LINE by level, leaves the body lines unwrapped, and keeps the text identical', () => {
    const content = '### Settled from the code\n- body **bold\nacross** lines\n\n### Links\n- Parent: [[DEMO-1]]';
    const { container } = render(() => <BlockDisplay content={content} />);
    expect(container.textContent).toBe(content);   // overlay alignment invariant
    const lines = Array.from(container.querySelectorAll('.md-heading-line'));
    expect(lines.map((l) => [l.getAttribute('data-level'), l.textContent])).toEqual([
      ['3', '### Settled from the code'],
      ['3', '### Links'],
    ]);
    // body text and the bold span that crosses a line boundary sit outside the heading lines
    expect(container.querySelector('.md-heading-line .md-bold')).toBeNull();
    expect(container.querySelectorAll('.md-bold').length).toBeGreaterThanOrEqual(1);
    const single = render(() => <BlockDisplay content="## only a heading" />);
    expect(single.container.querySelector('.md-heading-line')?.getAttribute('data-level')).toBe('2');
    expect(render(() => <BlockDisplay content="plain text" />).container.querySelector('.md-heading-line')).toBeNull();
  });

  it('heading lines come from parser markers: fenced ## stays plain, bordered │ ## is a heading, bold across a heading still marks it', () => {
    const fenced = render(() => <BlockDisplay content={'## real\n```\n## literal in a fence\n```'} />);
    expect(fenced.container.textContent).toBe('## real\n```\n## literal in a fence\n```');
    expect(Array.from(fenced.container.querySelectorAll('.md-heading-line')).map((l) => l.textContent)).toEqual(['## real']);
    expect(fenced.container.querySelector('.md-heading-line .md-fence, .md-heading-line .md-code-fence')).toBeNull();
    const boxed = render(() => <BlockDisplay content={'│ ## Day Shape     │\n│ body            │'} />);
    expect(Array.from(boxed.container.querySelectorAll('.md-heading-line')).map((l) => [l.getAttribute('data-level'), l.textContent])).toEqual([['2', '│ ## Day Shape     │']]);
    const bold = render(() => <BlockDisplay content={'**before\n## Heading\nstill**'} />);
    expect(bold.container.textContent).toBe('**before\n## Heading\nstill**');
    expect(Array.from(bold.container.querySelectorAll('.md-heading-line')).map((l) => [l.getAttribute('data-level'), l.textContent])).toEqual([['2', '## Heading']]);
  });

  it('retains classes, nested navigation, target identity and stub styling', () => {
    const navigate = vi.fn();
    const { container } = render(() => <InlineContent
      content="**bold** *italic* `code` [[Demo|alias [[Ghost|nested]]]]" pretty
      pageNameSet={new Set(['demo'])} onWikilinkClick={navigate} />);
    expect(container.querySelector('.md-bold')?.textContent).toBe('bold');
    expect(container.querySelector('.md-italic')?.textContent).toBe('italic');
    expect(container.querySelector('.md-code')?.textContent).toBe('code');
    const nested = container.querySelector('.md-wikilink[data-target="Ghost"]')!;
    expect(nested.classList.contains('md-wikilink-stub')).toBe(true);
    fireEvent.click(nested);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('Ghost', expect.any(MouseEvent));
  });
  it('reactively toggles marks and heading glyphs without changing tokens', () => {
    const [options, setOptions] = createSignal({ marks: false, headings: false });
    const { container } = render(() => <InlineContent content="## **Demo** [[Page|alias]]" pretty={options()} />);
    expect(container.textContent).toBe('Demo alias');
    setOptions({ marks: true, headings: true });
    expect(container.textContent).toBe('## **Demo** [[Page|alias]]');
    setOptions({ marks: false, headings: true });
    expect(container.textContent).toBe('## Demo alias');
  });
});
