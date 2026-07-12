/**
 * read:: door tests — pure logic + view contract.
 *
 * Covers what can be proven without a running app: argument→command
 * construction, the markdown→HTML transform (incl. wikilinks + sanitization),
 * the rendered⇄raw toggle, and the navigate verb the view proposes to the host.
 *
 * NOT covered here (live-test): the actual execute_shell_command round trip
 * and the host's handleChirpNavigate landing a zoom in the linked pane.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import {
  buildReadCommand,
  parseReadPath,
  renderMarkdownDoc,
  shellQuotePath,
  wikilinkTargetFromEvent,
  WIKILINK_ATTR,
} from './readDoc';
import { ReadView } from './read';

// ─── Argument parsing ────────────────────────────────────────────

describe('parseReadPath', () => {
  it('extracts the path after the prefix', () => {
    expect(parseReadPath('read:: ~/notes/a.md')).toBe('~/notes/a.md');
  });

  it('is case-insensitive and tolerates missing space', () => {
    expect(parseReadPath('READ::/tmp/a.md')).toBe('/tmp/a.md');
  });

  it('only reads the first line (block content may be multiline)', () => {
    expect(parseReadPath('read:: /tmp/a.md\ntrailing junk')).toBe('/tmp/a.md');
  });

  it('strips a user-typed quoted path', () => {
    expect(parseReadPath('read:: "~/my notes/a.md"')).toBe('~/my notes/a.md');
  });

  it('returns empty string when no argument is given', () => {
    expect(parseReadPath('read::')).toBe('');
    expect(parseReadPath('read::   ')).toBe('');
  });
});

// ─── Shell command construction ──────────────────────────────────

describe('shellQuotePath / buildReadCommand', () => {
  it('keeps ~ bare so the shell expands it, quoting only the remainder', () => {
    expect(shellQuotePath('~/notes/a.md')).toBe("~/'notes/a.md'");
  });

  it('quotes paths with spaces', () => {
    expect(buildReadCommand('/tmp/my notes.md')).toBe("cat -- '/tmp/my notes.md'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuotePath("/tmp/evan's.md")).toBe("'/tmp/evan'\\''s.md'");
  });

  it('neutralizes command substitution and chaining', () => {
    expect(buildReadCommand('/tmp/a.md; rm -rf ~')).toBe("cat -- '/tmp/a.md; rm -rf ~'");
    expect(buildReadCommand('$(whoami).md')).toBe("cat -- '$(whoami).md'");
  });

  it('uses -- so a leading-dash path is not read as a flag', () => {
    expect(buildReadCommand('-rf')).toBe("cat -- '-rf'");
  });
});

// ─── Markdown rendering ──────────────────────────────────────────

describe('renderMarkdownDoc', () => {
  it('renders document structure (headings, lists, code fences)', () => {
    const html = renderMarkdownDoc('# Title\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n');
    expect(html).toContain('<h1');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<code');
  });

  it('renders [[wikilinks]] as anchors carrying the navigation target', () => {
    const html = renderMarkdownDoc('see [[FLO-474]] for context');
    expect(html).toContain(`${WIKILINK_ATTR}="FLO-474"`);
    expect(html).toContain('>FLO-474</a>');
  });

  it('uses the alias as link text but the target for navigation', () => {
    const html = renderMarkdownDoc('[[2026-07-12|today]]');
    expect(html).toContain(`${WIKILINK_ATTR}="2026-07-12"`);
    expect(html).toContain('>today</a>');
  });

  it('handles nested wikilinks via the canonical bracket-counting parser', () => {
    const html = renderMarkdownDoc('[[outer [[inner]]]]');
    expect(html).toContain(`${WIKILINK_ATTR}="outer [[inner]]"`);
  });

  it('renders wikilinks inside list items and headings', () => {
    const html = renderMarkdownDoc('## [[FLO-1]]\n\n- see [[FLO-2]]\n');
    expect(html).toContain(`${WIKILINK_ATTR}="FLO-1"`);
    expect(html).toContain(`${WIKILINK_ATTR}="FLO-2"`);
  });

  it('leaves an unbalanced [[ as literal text', () => {
    const html = renderMarkdownDoc('a [[unclosed link');
    expect(html).not.toContain(WIKILINK_ATTR);
    expect(html).toContain('[[unclosed link');
  });

  it('sanitizes script tags and event handlers from the file', () => {
    const html = renderMarkdownDoc('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });

  it('does not emit an href on wikilinks — the host owns resolution', () => {
    const html = renderMarkdownDoc('[[FLO-474]]');
    expect(html).not.toContain('href');
  });
});

// ─── Click → navigate target ─────────────────────────────────────

describe('wikilinkTargetFromEvent', () => {
  it('resolves a click on a nested element inside the anchor', () => {
    const anchor = document.createElement('a');
    anchor.setAttribute(WIKILINK_ATTR, 'FLO-474');
    const inner = document.createElement('em');
    anchor.appendChild(inner);
    expect(wikilinkTargetFromEvent(inner)).toBe('FLO-474');
  });

  it('returns null for clicks outside a wikilink', () => {
    expect(wikilinkTargetFromEvent(document.createElement('p'))).toBeNull();
    expect(wikilinkTargetFromEvent(null)).toBeNull();
  });
});

// ─── View contract ───────────────────────────────────────────────

const viewProps = (raw: string, onNavigate?: (t: string) => void) => ({
  data: { path: '~/notes/a.md', raw },
  settings: {},
  server: { url: '', wsUrl: '', fetch: vi.fn() },
  onNavigate,
});

describe('ReadView', () => {
  it('renders the document, not the raw source, by default', () => {
    const { container } = render(() => <ReadView {...viewProps('# Hello\n')} />);
    expect(container.querySelector('.door-read-doc h1')?.textContent).toBe('Hello');
    expect(container.querySelector('.door-read-raw')).toBeNull();
  });

  it('toggles rendered ⇄ raw source and back', () => {
    const { container, getByLabelText } = render(() => <ReadView {...viewProps('# Hello\n')} />);

    fireEvent.click(getByLabelText('Show raw source'));
    expect(container.querySelector('.door-read-raw')?.textContent).toBe('# Hello\n');
    expect(container.querySelector('.door-read-doc')).toBeNull();

    fireEvent.click(getByLabelText('Show rendered document'));
    expect(container.querySelector('.door-read-doc h1')?.textContent).toBe('Hello');
    expect(container.querySelector('.door-read-raw')).toBeNull();
  });

  it('proposes navigate with the wikilink target when a link is clicked', () => {
    const onNavigate = vi.fn();
    const { container } = render(() => (
      <ReadView {...viewProps('see [[FLO-474]]', onNavigate)} />
    ));

    const link = container.querySelector(`[${WIKILINK_ATTR}]`) as HTMLElement;
    fireEvent.click(link);

    expect(onNavigate).toHaveBeenCalledTimes(1);
    // No type/opts: the host resolves block-id prefix vs page name itself.
    expect(onNavigate).toHaveBeenCalledWith('FLO-474');
  });

  it('navigates with the target, not the alias', () => {
    const onNavigate = vi.fn();
    const { container } = render(() => (
      <ReadView {...viewProps('[[2026-07-12|today]]', onNavigate)} />
    ));

    fireEvent.click(container.querySelector(`[${WIKILINK_ATTR}]`) as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('2026-07-12');
  });

  it('ignores clicks on non-wikilink content', () => {
    const onNavigate = vi.fn();
    const { container } = render(() => (
      <ReadView {...viewProps('plain paragraph', onNavigate)} />
    ));

    fireEvent.click(container.querySelector('.door-read-doc p') as HTMLElement);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

// ─── stale-output guard (2026-07-12 live-test finding) ────────────────
// A block executed by a prior door (the retired `reader` prototype) carries
// output.data of a foreign shape — or null. The view must render, not crash.
describe('stale/null output data', () => {
  it('renders without crashing when data is null', () => {
    const props = { ...viewProps(''), data: null as never };
    const { container } = render(() => <ReadView {...props} />);
    expect(container.querySelector('.door-read')).not.toBeNull();
    expect(container.textContent).toContain('re-run to load');
  });

  it('renders without crashing when data has a foreign shape', () => {
    const props = { ...viewProps(''), data: { someOldField: 1 } as never };
    const { container } = render(() => <ReadView {...props} />);
    expect(container.querySelector('.door-read-doc')).not.toBeNull();
  });
});
