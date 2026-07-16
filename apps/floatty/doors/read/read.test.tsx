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
  enhanceReaderDoc,
  isGlobbable,
  parseReadPath,
  renderMarkdownDoc,
  renderReaderDoc,
  shellQuotePath,
  slugifyHeading,
  splitFrontmatter,
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

// ─── frontmatter strip (2026-07-12 live-test finding) ─────────────────
describe('splitFrontmatter', () => {
  it('lifts leading YAML frontmatter out of the body', () => {
    const raw = '---\ncreated: 2026-07-10 @ 09:20 PM\ntags: [a, b]\n---\n# Title\nbody\n';
    const { front, body } = splitFrontmatter(raw);
    expect(front).toEqual([['created', '2026-07-10 @ 09:20 PM'], ['tags', '[a, b]']]);
    expect(body).toBe('# Title\nbody\n');
  });

  it('returns the document untouched when there is no frontmatter', () => {
    const { front, body } = splitFrontmatter('# Just a doc\n');
    expect(front).toBeNull();
    expect(body).toBe('# Just a doc\n');
  });

  it('does not treat a mid-document --- (hr) as frontmatter', () => {
    const raw = 'intro\n\n---\n\nafter the rule\n';
    const { front, body } = splitFrontmatter(raw);
    expect(front).toBeNull();
    expect(body).toBe(raw);
  });

  it('renders frontmatter as a metadata strip, not body prose', () => {
    const raw = '---\nproject: rangle/rexall\n---\n# Doc\n';
    const props = { ...viewProps(raw) };
    const { container } = render(() => <ReadView {...props} />);
    expect(container.querySelector('.door-read-front')).not.toBeNull();
    expect(container.querySelector('.door-read-front')!.textContent).toContain('rangle/rexall');
    expect(container.querySelector('.door-read-doc')!.textContent).not.toContain('project:');
  });
});

// ─── Obsidian-style line breaks (2026-07-12 timelog screenshot) ────────
describe('single-newline line breaks', () => {
  it('renders line-per-entry content (refs lists) as separate lines, not a run-on paragraph', () => {
    // Timelog-shaped lines now route through the timelog extension; this
    // covers the general Obsidian-convention case (refs blocks, notes).
    const html = renderMarkdownDoc('first ref line\nsecond ref line\n');
    expect(html).toContain('<br');
  });
});

// ─── qmd:// sources (2026-07-12) ───────────────────────────────────────
import { isQmdSource, stripQmdPreamble } from './readDoc';

describe('qmd sources', () => {
  it('routes qmd:// URIs through qmd get, first token only (pasted hits carry trailing #docid)', () => {
    expect(buildReadCommand('qmd://sysops-log/2026-04-27-rfc.md:2 #1973c2'))
      .toBe("qmd get 'qmd://sysops-log/2026-04-27-rfc.md:2'");
  });

  it('routes bare #docids through qmd get', () => {
    expect(buildReadCommand('#1973c2')).toBe("qmd get '#1973c2'");
  });

  it('does not treat markdown-heading-ish args as docids', () => {
    expect(buildReadCommand('#notes')).toBe("cat -- '#notes'");
    expect(isQmdSource('/tmp/a.md')).toBe(false);
  });

  it('strips the qmd Folder Context preamble so frontmatter lands at position 0', () => {
    const raw = 'Folder Context: memory stuff\n\nOperational log: things\n---\n\n---\ntitle: RFC\n---\n# Body\n';
    const stripped = stripQmdPreamble(raw);
    expect(stripped.startsWith('---\ntitle: RFC')).toBe(true);
    const { front, body } = splitFrontmatter(stripped);
    expect(front).toEqual([['title', 'RFC']]);
    expect(body).toContain('# Body');
  });

  it('leaves non-qmd output untouched', () => {
    expect(stripQmdPreamble('# Regular doc\n')).toBe('# Regular doc\n');
  });
});

// ─── BlockDown primitives (RFC 2026-04-27, qmd dig 2026-07-12) ─────────
import { pillHue } from './readDoc';

describe('BlockDown rendering', () => {
  it('renders [key::value] as a color-hashed pill, not bracket noise', () => {
    const html = renderMarkdownDoc('status update [project::floatty] [mode::synthesis]');
    expect(html).toContain('read-pill');
    expect(html).toContain('--pill-h:');
    expect(html).toContain('floatty');
    expect(html).not.toContain('[project::floatty]');
  });

  it('pill hue is deterministic per key+value', () => {
    expect(pillHue('project::floatty')).toBe(pillHue('project::floatty'));
    expect(pillHue('project::floatty')).not.toBe(pillHue('project::evna'));
  });

  it('does NOT treat indented lines as code blocks (2-space indent = child block)', () => {
    const html = renderMarkdownDoc('parent line\n\n    ~01:35pm indented timelog entry\n    ~01:45pm another\n');
    expect(html).not.toContain('<pre>');
    expect(html).toContain('~01:35pm');
  });

  it('fenced code still renders as code', () => {
    const html = renderMarkdownDoc('```\ntree art here\n```\n');
    expect(html).toContain('<pre>');
  });

  it('wikilinks and pills coexist on one line', () => {
    const html = renderMarkdownDoc('[project::floatty] see [[FLO-474]]');
    expect(html).toContain('read-pill');
    expect(html).toContain(`${WIKILINK_ATTR}="FLO-474"`);
  });
});

// ─── timelog idiom (2026-07-12 screenshot round 2) ─────────────────────
describe('timelog rendering', () => {
  it('renders consecutive timelog lines as hanging-indent entries with cyan time', () => {
    const html = renderMarkdownDoc('~01:35pm  rexall-catalyst  re-grounded off W27\n~01:45pm  rexall-catalyst  board reconciled\n');
    expect(html).toContain('read-tl-block');
    expect((html.match(/read-tl-time/g) || []).length).toBe(2);
    expect(html).toContain('read-tl-proj');
    expect(html).toContain('rexall-catalyst');
  });

  it('keeps wikilinks live inside timelog entries', () => {
    const html = renderMarkdownDoc('~02:46pm  rexall  sync processed → [[2026-07-06-sync]]\n');
    expect(html).toContain(`${WIKILINK_ATTR}="2026-07-06-sync"`);
  });

  it('does not hijack bare H:MM in prose (am/pm required at line start)', () => {
    const html = renderMarkdownDoc('the meeting at 14:30 went long\n');
    expect(html).not.toContain('read-tl');
  });

  it('handles single-space separator by keeping body whole (no false project peel)', () => {
    const html = renderMarkdownDoc('~02:00pm spike relit for demo\n');
    expect(html).toContain('read-tl-time');
    expect(html).not.toContain('read-tl-proj');
    expect(html).toContain('spike relit');
  });
});

// ─── globs (2026-07-13 live: sh:: cat globbed, read:: errored) ─────────
describe('glob paths', () => {
  it('passes a glob UNQUOTED so the shell expands it', () => {
    expect(buildReadCommand('/opt/float/bbs/**/2026-W28-rexall-weekly.md'))
      .toBe('cat -- /opt/float/bbs/**/2026-W28-rexall-weekly.md');
    expect(buildReadCommand('~/notes/2026-07-*.md')).toBe('cat -- ~/notes/2026-07-*.md');
  });

  it('still QUOTES a plain path (no glob chars, nothing to expand)', () => {
    expect(buildReadCommand('/tmp/my notes.md')).toBe("cat -- '/tmp/my notes.md'");
  });

  it('refuses to unquote when a shell metacharacter rides along with the glob', () => {
    // The dangerous case: a glob char makes it LOOK globbable while a
    // metacharacter smuggles in execution. Metacharacter check wins → quoted.
    expect(isGlobbable('/tmp/*.md; rm -rf ~')).toBe(false);
    expect(buildReadCommand('/tmp/*.md; rm -rf ~')).toBe("cat -- '/tmp/*.md; rm -rf ~'");

    expect(isGlobbable('/tmp/$(whoami)*.md')).toBe(false);
    expect(buildReadCommand('/tmp/$(whoami)*.md')).toBe("cat -- '/tmp/$(whoami)*.md'");

    expect(isGlobbable('/tmp/`id`*.md')).toBe(false);
    expect(isGlobbable('/tmp/*.md | tee /tmp/x')).toBe(false);
    expect(isGlobbable('/tmp/*.md > /tmp/x')).toBe(false);
    expect(isGlobbable("/tmp/*'.md")).toBe(false);
  });

  it('refuses zsh EXTENDED_GLOB negation and =command expansion', () => {
    // ^pat with EXTENDED_GLOB reads every file EXCEPT the named set
    expect(isGlobbable('/logs/^secret*.md')).toBe(false);
    expect(buildReadCommand('/logs/^secret*.md')).toBe("cat -- '/logs/^secret*.md'");

    // leading = triggers zsh =command path expansion
    expect(isGlobbable('=ls*')).toBe(false);
    expect(buildReadCommand('=ls*')).toBe("cat -- '=ls*'");
    expect(isGlobbable('/tmp/a=b*.md')).toBe(false);

    // ~ stays allowed — denying it would kill the primary use case
    expect(isGlobbable('~/notes/2026-07-*.md')).toBe(true);
  });

  it('refuses whitespace — the shell word-splits before globbing', () => {
    // one "path" would become two cat arguments
    expect(isGlobbable('*.md /etc/passwd')).toBe(false);
    expect(buildReadCommand('*.md /etc/passwd')).toBe("cat -- '*.md /etc/passwd'");

    // space + glob can't work unquoted anyway — quoted is the only sane branch
    expect(isGlobbable('/tmp/my notes/*.md')).toBe(false);
    expect(isGlobbable('/tmp/tab\there*.md')).toBe(false);
  });

  it('a plain path with metacharacters is quoted as before (unchanged)', () => {
    expect(buildReadCommand('/tmp/a.md; rm -rf ~')).toBe("cat -- '/tmp/a.md; rm -rf ~'");
  });

  it('recognizes the glob forms actually used: ** * ? [] ', () => {
    expect(isGlobbable('/a/**/b.md')).toBe(true);
    expect(isGlobbable('/a/*.md')).toBe(true);
    expect(isGlobbable('/a/note-?.md')).toBe(true);
    expect(isGlobbable('/a/note-[12].md')).toBe(true);
    expect(isGlobbable('/a/plain.md')).toBe(false);
  });
});

// ─── Reader structure: ToC + collapsible sections (FLO-815) ──────
describe('slugifyHeading', () => {
  it('lowercases, strips punctuation, hyphenates spaces', () => {
    expect(slugifyHeading('The Shape of the Day')).toBe('the-shape-of-the-day');
    // Stripped punctuation (#, em-dash, !) leaves gaps that collapse to one hyphen.
    expect(slugifyHeading('## S4 Forms — wave!')).toBe('s4-forms-wave');
  });
  it('falls back to "section" for empty/punctuation-only text', () => {
    expect(slugifyHeading('   ')).toBe('section');
    expect(slugifyHeading('!!!')).toBe('section');
  });
});

describe('enhanceReaderDoc', () => {
  const build = (html: string) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  };

  it('wraps each heading + its content into a collapsible section, nested by level', () => {
    const el = build('<h2>Alpha</h2><p>a1</p><h3>Beta</h3><p>b1</p><h2>Gamma</h2><p>g1</p>');
    const headings = enhanceReaderDoc(el);

    // Two top-level sections (the h2s); Beta nests inside Alpha.
    const top = el.querySelectorAll(':scope > details.read-section');
    expect(top.length).toBe(2);
    const alpha = top[0];
    expect(alpha.querySelector('summary')?.textContent).toBe('Alpha');
    // Alpha owns its paragraph AND a nested details for Beta.
    expect(alpha.querySelector(':scope > p')?.textContent).toBe('a1');
    const beta = alpha.querySelector(':scope > details.read-section');
    expect(beta?.querySelector('summary')?.textContent).toBe('Beta');
    expect(beta?.querySelector('p')?.textContent).toBe('b1');

    // Returned model is document-order with levels + slugs matching heading ids.
    expect(headings).toEqual([
      { level: 2, text: 'Alpha', slug: 'alpha' },
      { level: 3, text: 'Beta', slug: 'beta' },
      { level: 2, text: 'Gamma', slug: 'gamma' },
    ]);
    expect(el.querySelector('#alpha')?.tagName).toBe('H2');
    expect(el.querySelector('#beta')?.tagName).toBe('H3');
  });

  it('keeps pre-heading content above the first section', () => {
    const el = build('<p>lead</p><h2>First</h2><p>body</p>');
    enhanceReaderDoc(el);
    // The lead paragraph is a direct child, before the section.
    expect(el.firstElementChild?.tagName).toBe('P');
    expect(el.firstElementChild?.textContent).toBe('lead');
    expect(el.querySelector(':scope > details.read-section summary')?.textContent).toBe('First');
  });

  it('dedups repeated heading slugs in document order', () => {
    const el = build('<h2>Notes</h2><p>x</p><h2>Notes</h2><p>y</p>');
    const headings = enhanceReaderDoc(el);
    expect(headings.map((h) => h.slug)).toEqual(['notes', 'notes-2']);
    expect(el.querySelector('#notes')).not.toBeNull();
    expect(el.querySelector('#notes-2')).not.toBeNull();
  });

  it('avoids final-slug collision when a literal "-2" heading follows a dup', () => {
    // Notes, Notes, Notes-2 must all get distinct ids (final-slug tracking).
    const el = build('<h2>Notes</h2><p>a</p><h2>Notes</h2><p>b</p><h2>Notes-2</h2><p>c</p>');
    const headings = enhanceReaderDoc(el);
    const slugs = headings.map((h) => h.slug);
    expect(new Set(slugs).size).toBe(3); // no collisions
    expect(slugs).toEqual(['notes', 'notes-2', 'notes-2-2']);
  });

  it('enhances a doc that authored a literal .read-section (own marker guards idempotency)', () => {
    // A source file's own <details class="read-section"> must NOT be mistaken
    // for already-enhanced — only our data-reader-enhanced marker skips.
    const el = build('<details class="read-section"><summary>authored</summary>x</details><h2>Real</h2><p>y</p>');
    const headings = enhanceReaderDoc(el);
    expect(headings.map((h) => h.slug)).toEqual(['real']);
    expect(el.querySelector('#real')?.tagName).toBe('H2');
    // our wrapper carries the marker; the authored one does not
    expect(el.querySelector('details.read-section[data-reader-enhanced]')).not.toBeNull();
  });

  it('is idempotent — a second run does not re-wrap', () => {
    const el = build('<h2>Alpha</h2><p>a1</p>');
    enhanceReaderDoc(el);
    const afterFirst = el.innerHTML;
    const headings = enhanceReaderDoc(el);
    expect(el.innerHTML).toBe(afterFirst);
    expect(headings.map((h) => h.slug)).toEqual(['alpha']);
  });

  it('no headings → no sections, empty model', () => {
    const el = build('<p>just prose</p><ul><li>x</li></ul>');
    expect(enhanceReaderDoc(el)).toEqual([]);
    expect(el.querySelector('details.read-section')).toBeNull();
  });
});

describe('ReadView — table of contents', () => {
  const viewProps = (raw: string) => ({
    data: { path: '~/notes/a.md', raw },
    settings: {},
    server: { url: '', wsUrl: '', fetch: vi.fn() },
  });

  it('renders a ToC with a link per heading when there are 2+', () => {
    const { container } = render(() => (
      <ReadView {...viewProps('# Top\n\ntext\n\n## Middle\n\nmore\n\n## End\n')} />
    ));
    const toc = container.querySelector('.door-read-toc');
    expect(toc).not.toBeNull();
    const links = container.querySelectorAll('.door-read-toc-link');
    expect(links.length).toBe(3);
    expect(Array.from(links).map((l) => l.textContent)).toEqual(['Top', 'Middle', 'End']);
  });

  it('omits the ToC when the document has one heading or fewer', () => {
    const { container } = render(() => <ReadView {...viewProps('# Only\n\nbody\n')} />);
    expect(container.querySelector('.door-read-toc')).toBeNull();
  });

  it('renders collapsible sections straight from the HTML (no post-mount pass)', () => {
    const { container } = render(() => (
      <ReadView {...viewProps('## One\n\na\n\n## Two\n\nb\n')} />
    ));
    const sections = container.querySelectorAll('.door-read-doc > details.read-section');
    expect(sections.length).toBe(2);
    expect(sections[0].querySelector('summary')?.textContent).toBe('One');
  });
});

describe('renderReaderDoc', () => {
  it('returns sanitized HTML with baked-in <details> sections + a heading model', () => {
    const { html, headings } = renderReaderDoc('# A\n\ntext\n\n## B\n\nmore\n');
    // Collapsible sections are in the STRING (survive DOMPurify), ids present.
    expect(html).toContain('<details');
    expect(html).toContain('class="read-section"');
    expect(html).toContain('id="a"');
    expect(html).toContain('id="b"');
    expect(headings).toEqual([
      { level: 1, text: 'A', slug: 'a' },
      { level: 2, text: 'B', slug: 'b' },
    ]);
  });

  it('still strips scripts/handlers through the sanitize pass', () => {
    const { html } = renderReaderDoc('## Title\n\n<script>alert(1)</script>\n\n<img src=x onerror="e()">');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });
});
