/**
 * read:: door styles — carried INSIDE the door bundle, not the app bundle.
 *
 * Doors are drop-in plugins loaded from {data_dir}/doors at runtime; a door
 * deployed onto an app build that predates it must still render correctly
 * (2026-07-12 live-test: the dev app was built from a different branch, the
 * app-side doors.css rules weren't there, and the reader rendered with raw
 * browser defaults). Every var() carries a fallback for the same reason.
 *
 * The reading target: at least as readable as the outline — measure-capped
 * column, quiet frontmatter strip, restrained heading scale.
 */
export const READ_DOOR_CSS = `
.door-read-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--color-border, rgba(128,128,128,0.35));
  margin-bottom: 12px;
}
.door-read-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl; /* keep the filename visible when the path is long */
  text-align: left;
  font-size: 11px;
  color: var(--door-muted, rgba(150,155,165,0.9));
}
.door-read-toggle {
  flex: none;
  background: none;
  border: 1px solid var(--color-border, rgba(128,128,128,0.25));
  border-radius: 3px;
  color: var(--door-muted, rgba(150,155,165,0.9));
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  padding: 1px 6px;
}
.door-read-toggle:hover {
  color: var(--door-fg, inherit);
  background: var(--color-bg-hover, rgba(128,128,128,0.12));
}
.door-read-toggle:focus-visible {
  outline: 2px solid var(--color-accent, #7aa2f7);
  outline-offset: 1px;
}
.door-read-front {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 16px;
  font-size: 11px;
  line-height: 1.6;
  padding: 7px 10px;
  margin-bottom: 14px;
  border: 1px dashed var(--color-border, rgba(128,128,128,0.35));
  border-radius: 2px;
  max-width: 76ch;
}
.door-read-front .fm-k {
  color: var(--door-muted, rgba(150,155,165,0.9));
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10px;
}
.door-read-front .fm-k::after { content: ': '; }
.door-read-front .fm-v {
  color: var(--door-fg, inherit);
  word-break: break-word;
}
.door-read-raw {
  margin: 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  color: var(--door-fg, inherit);
}
.door-read-doc {
  font-size: 13px;
  line-height: 1.65;
  color: var(--door-fg, inherit);
  max-width: 76ch; /* reading measure — the point of reader mode */
}
.door-read-doc > :first-child { margin-top: 0; }
.door-read-doc > :last-child { margin-bottom: 0; }
.door-read-doc h1,
.door-read-doc h2,
.door-read-doc h3,
.door-read-doc h4 {
  margin: 1.1em 0 0.45em;
  line-height: 1.3;
  font-weight: 700;
}
.door-read-doc h1 {
  font-size: 1.45em;
  padding-bottom: 0.25em;
  border-bottom: 1px dashed var(--color-border, rgba(128,128,128,0.3));
}
.door-read-doc h2 { font-size: 1.22em; }
.door-read-doc h3 { font-size: 1.08em; }
.door-read-doc p,
.door-read-doc ul,
.door-read-doc ol,
.door-read-doc blockquote {
  margin: 0.65em 0;
}
.door-read-doc strong {
  color: var(--color-ansi-yellow, #e0af68);
}
.door-read-doc ul,
.door-read-doc ol {
  padding-left: 1.4em;
}
.door-read-doc li { margin: 0.2em 0; }
.door-read-doc li::marker {
  color: var(--door-muted, rgba(150,155,165,0.8));
}
.door-read-doc blockquote {
  border-left: 2px solid var(--color-border, rgba(128,128,128,0.3));
  padding-left: 10px;
  color: var(--door-muted, rgba(170,175,185,0.95));
}
.door-read-doc code {
  background: var(--door-tag-bg, rgba(128,128,128,0.15));
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 0.9em;
}
.door-read-doc pre {
  background: var(--color-bg-secondary, rgba(0,0,0,0.25));
  border-radius: 4px;
  padding: 10px;
  overflow-x: auto; /* long code lines scroll, page body never does */
}
.door-read-doc pre code { background: none; padding: 0; }
.door-read-doc table {
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}
.door-read-doc th,
.door-read-doc td {
  border: 1px solid var(--color-border, rgba(128,128,128,0.25));
  padding: 4px 8px;
  text-align: left;
}
.door-read-doc img { max-width: 100%; }
.door-read-doc hr {
  border: none;
  border-top: 1px dashed var(--color-border, rgba(128,128,128,0.3));
  margin: 1.2em 0;
}
.door-read-doc .read-wikilink {
  color: var(--color-wikilink, var(--color-accent, #7aa2f7));
  cursor: pointer;
  text-decoration: none;
}
.door-read-doc .read-wikilink:hover { text-decoration: underline; }
.door-read-doc .read-pill {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 0.85em;
  background: hsla(var(--pill-h), 45%, 55%, 0.16);
  border: 1px solid hsla(var(--pill-h), 45%, 60%, 0.35);
  white-space: nowrap;
}
.door-read-doc .read-pill-k {
  color: hsl(var(--pill-h), 55%, 70%);
}
.door-read-doc .read-pill-v {
  color: var(--door-fg, inherit);
  opacity: 0.9;
}
.door-read-doc .read-pill-k:not(:only-child)::after { content: '::'; opacity: 0.6; }
`;
