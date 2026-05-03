/**
 * render:: door components — SolidJS implementations of the catalog
 *
 * Dark BBS aesthetic: Space Mono nav, Crimson Pro body,
 * magenta/cyan/coral/amber accents on black.
 *
 * All innerHTML paths sanitized via DOMPurify.
 * Wikilink navigation via chirp CustomEvent bubbling to BlockItem.
 */

import { Show, For, createSignal, createMemo, onMount, createEffect, onCleanup, on } from 'solid-js';
import { useBoundProp } from '@json-render/solid';
import type { BaseComponentProps } from '@json-render/solid';
import DOMPurify from 'dompurify';
// NOTE: Do NOT import from httpClient.ts — the door bundle is a separate compiled
// module. The singleton clientInstance is never initialized in the bundle context.
// Use window.__FLOATTY_SERVER_URL__ / __FLOATTY_API_KEY__ globals instead.

// The floatty shell sets these via Tauri's initialization script; render-reference's
// standalone build runs without them, so both fields are optional. Declared inline
// here so any consumer of components.tsx (including the render-reference harness)
// sees the types without needing to reach for a separate .d.ts.
declare global {
  interface Window {
    __FLOATTY_SERVER_URL__?: string;
    __FLOATTY_API_KEY__?: string;
  }
}

const sanitize = (html: string) => DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });

function emitChirpNavigate(el: HTMLElement, target: string, sourceEvent: MouseEvent): void {
  el.dispatchEvent(new CustomEvent('chirp', {
    bubbles: true,
    composed: true,
    detail: { message: 'navigate', target, sourceEvent },
  }));
}

/** Emit a generic chirp (write verbs, etc). Data shape depends on message type. */
function emitChirp(el: HTMLElement, message: string, data?: Record<string, unknown>): void {
  el.dispatchEvent(new CustomEvent('chirp', {
    bubbles: true,
    composed: true,
    detail: { message, data },
  }));
}

/** Delegate click on .bbs-wikilink elements to chirp navigation. */
function handleWikilinkClick(e: MouseEvent): void {
  let el = e.target as HTMLElement | null;
  while (el && !el.dataset?.wikilink) {
    if (el === e.currentTarget) break;
    el = el.parentElement;
  }
  if (el?.dataset?.wikilink) {
    emitChirpNavigate(el, el.dataset.wikilink, e);
  }
}

// ═══════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ═══════════════════════════════════════════════════════════════

const V = {
  bg: '#000',
  s1: '#0d0d0d',
  s2: '#161616',
  mag: '#e040a0',
  magD: '#a02070',
  cor: '#ff4444',
  cy: '#00e5ff',
  amb: '#ffb300',
  t: '#e0e0e0',
  td: '#888',
  tf: '#555',
  b: '#222',
  b2: '#333',
  green: '#98c379',
  mono: "'Space Mono', 'JetBrains Mono', monospace",
  serif: "'Crimson Pro', Georgia, serif",
} as const;

function accentColor(accent?: string): string {
  switch (accent) {
    case 'magenta': return V.mag;
    case 'cyan': return V.cy;
    case 'coral': return V.cor;
    case 'amber': return V.amb;
    default: return V.td;
  }
}

function typeAccent(type?: string): string {
  switch (type) {
    case 'synthesis': return V.mag;
    case 'archaeology': return V.cy;
    case 'bbs-source': return V.cor;
    default: return V.td;
  }
}

// ═══════════════════════════════════════════════════════════════
// MARKDOWN
// ═══════════════════════════════════════════════════════════════

function inlineFormat(s: string): string {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, target) => {
    const escaped = target.replace(/"/g, '&quot;');
    return `<span class="bbs-wikilink" data-wikilink="${escaped}">${target}</span>`;
  });
  s = s.replace(/\[issue::(\d+)\]/g, '<span class="bbs-marker">#$1</span>');
  return s;
}

function renderMarkdown(text: string): string {
  let s = text;

  // Code fences — protect from inline formatting
  const fences: string[] = [];
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    const c = m.slice(3, -3).trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    fences.push('<pre><code>' + c + '</code></pre>');
    return `\x00FENCE${fences.length - 1}\x00`;
  });

  // Tables
  const tables: string[] = [];
  s = s.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return tableBlock;

    const sepIdx = rows.findIndex(r => /^\|[\s\-:|]+\|$/.test(r));

    let html = '<table>';
    rows.forEach((row, i) => {
      if (i === sepIdx) return;
      const cells = row.split('|').slice(1, -1).map(c => inlineFormat(c.trim()));
      const isHeader = sepIdx >= 0 && i < sepIdx;
      const tag = isHeader ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    });
    html += '</table>';
    tables.push(html);
    return `\x00TABLE${tables.length - 1}\x00`;
  });

  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/^---$/gm, '<hr>');
  s = s.replace(/^- (.+)$/gm, '<li>$1</li>');
  s = s.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  s = inlineFormat(s);

  fences.forEach((html, i) => { s = s.replace(`\x00FENCE${i}\x00`, html); });
  tables.forEach((html, i) => { s = s.replace(`\x00TABLE${i}\x00`, html); });

  // Split on double newlines, only wrap non-block-level segments in <p>
  const blockRe = /^<(h[1-6]|ul|ol|li|blockquote|hr|table|pre|div)/;
  s = s.split('\n\n').map(seg => {
    const trimmed = seg.trim();
    if (!trimmed) return '';
    return blockRe.test(trimmed) ? trimmed : `<p>${trimmed}</p>`;
  }).join('\n');
  return s;
}

// ═══════════════════════════════════════════════════════════════
// LAYOUT
// ═══════════════════════════════════════════════════════════════

export function DocLayout(props: BaseComponentProps<Record<string, never>>) {
  return (
    <div style={{
      display: 'flex',
      'min-height': '400px',
      height: '100%',
      background: V.bg,
      color: V.t,
      'font-family': V.mono,
      'line-height': '1.5',
    }}>
      {props.children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════════════════════════

export function NavBrand(props: BaseComponentProps<{ title: string; subtitle?: string }>) {
  return (
    <div style={{
      padding: '16px',
      'border-bottom': `1px solid ${V.b}`,
    }}>
      <div style={{
        'font-size': '13px',
        'font-weight': '700',
        color: V.mag,
        'letter-spacing': '2px',
        'font-family': V.mono,
      }}>
        {props.props.title}
      </div>
      <Show when={props.props.subtitle}>
        <div style={{
          'font-size': '10px',
          color: V.tf,
          'margin-top': '2px',
          'font-family': V.mono,
        }}>
          {props.props.subtitle}
        </div>
      </Show>
    </div>
  );
}

export function NavSection(props: BaseComponentProps<{ label: string; accent?: string }>) {
  return (
    <div>
      <div style={{
        padding: '12px 0 4px 16px',
        'font-size': '9px',
        'letter-spacing': '3px',
        'text-transform': 'uppercase',
        color: accentColor(props.props.accent),
        'font-family': V.mono,
      }}>
        {props.props.label}
      </div>
      {props.children}
    </div>
  );
}

export function NavItem(props: BaseComponentProps<{ id: string; label: string; active?: boolean }>) {
  const isActive = () => props.props.active || false;
  return (
    <div
      data-nav-id={props.props.id}
      style={{
        display: 'block',
        padding: '6px 16px',
        'font-size': '12px',
        color: isActive() ? '#fff' : V.td,
        cursor: 'pointer',
        'border-left': `3px solid ${isActive() ? V.mag : 'transparent'}`,
        background: isActive() ? V.s2 : 'transparent',
        transition: 'all 0.1s',
        'font-family': V.mono,
      }}
      onClick={() => props.emit('press')}
    >
      <span style={{
        display: 'inline-block',
        width: '6px',
        height: '6px',
        'border-radius': '50%',
        'margin-right': '8px',
        'vertical-align': 'middle',
        background: isActive() ? V.mag : 'transparent',
        'box-shadow': isActive() ? `0 0 6px ${V.mag}` : 'none',
      }} />
      {props.props.label}
    </div>
  );
}

export function NavFooter(props: BaseComponentProps<{ content: string }>) {
  return (
    <div
      style={{
        padding: '12px 16px',
        'border-top': `1px solid ${V.b}`,
        'font-size': '9px',
        color: V.tf,
        'line-height': '1.8',
        'margin-top': 'auto',
        'font-family': V.mono,
      }}
      innerHTML={sanitize(props.props.content)}
    />
  );
}

// ═══════════════════════════════════════════════════════════════
// ENTRY DISPLAY
// ═══════════════════════════════════════════════════════════════

export function EntryHeader(props: BaseComponentProps<{
  type: string;
  board?: string;
  title: string;
  date: string;
  author?: string;
}>) {
  return (
    <div>
      <div style={{
        'font-size': '10px',
        'letter-spacing': '3px',
        'text-transform': 'uppercase',
        'margin-bottom': '6px',
        color: typeAccent(props.props.type),
        'font-family': V.mono,
      }}>
        {props.props.type.replace('-', ' ')}
        {props.props.board ? ` \u00b7 ${props.props.board}` : ''}
      </div>
      <div style={{
        'font-family': V.serif,
        'font-size': 'clamp(26px, 5vw, 38px)',
        'font-weight': '700',
        'line-height': '1.15',
        'margin-bottom': '10px',
        color: '#fff',
      }}>
        {props.props.title}
      </div>
      <div style={{
        'font-size': '10px',
        color: V.tf,
        'margin-bottom': '12px',
        'letter-spacing': '1px',
        'font-family': V.mono,
      }}>
        {props.props.date} &middot; {props.props.author || 'mixed'}
      </div>
    </div>
  );
}

export function EntryBody(props: BaseComponentProps<{ markdown: string }>) {
  return (
    <div
      class="bbs-entry-body"
      innerHTML={sanitize(renderMarkdown(props.props.markdown))}
      onClick={handleWikilinkClick}
    />
  );
}

export function Ellipsis(_props: BaseComponentProps<Record<string, never>>) {
  return (
    <div style={{
      'text-align': 'center',
      padding: '20px',
      'font-size': '14px',
      color: V.tf,
      'letter-spacing': '6px',
    }}>
      &middot; &middot; &middot;
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAGS
// ═══════════════════════════════════════════════════════════════

export function TagBar(props: BaseComponentProps<{ gap?: number }>) {
  return (
    <div style={{
      display: 'flex',
      'flex-wrap': 'wrap',
      gap: `${props.props.gap || 6}px`,
      'margin-bottom': '28px',
    }}>
      {props.children}
    </div>
  );
}

export function TagChip(props: BaseComponentProps<{ name: string; active?: boolean }>) {
  const isActive = () => props.props.active || false;
  return (
    <span
      style={{
        'font-size': '10px',
        'letter-spacing': '1px',
        'text-transform': 'uppercase',
        padding: '3px 10px',
        cursor: 'pointer',
        border: `1px solid ${isActive() ? V.mag : V.b2}`,
        color: isActive() ? V.mag : V.td,
        background: isActive() ? 'rgba(224,64,160,.12)' : 'transparent',
        transition: 'all 0.12s',
        'font-family': V.mono,
      }}
      onClick={() => props.emit('press')}
    >
      {props.props.name}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════
// REFERENCES
// ═══════════════════════════════════════════════════════════════

export function RefSection(props: BaseComponentProps<{ label?: string }>) {
  return (
    <div style={{
      'margin-top': '12px',
      'padding-top': '12px',
      'border-top': `1px solid ${V.b}`,
    }}>
      <div style={{
        'font-size': '10px',
        'letter-spacing': '3px',
        'text-transform': 'uppercase',
        color: V.magD,
        'margin-bottom': '12px',
        'font-family': V.mono,
      }}>
        {props.props.label || 'CONNECTED'} &rarr;
      </div>
      {props.children}
    </div>
  );
}

export function RefCard(props: BaseComponentProps<{ id: string; type: string; title: string }>) {
  return (
    <div
      style={{
        display: 'block',
        padding: '10px 14px',
        'margin-bottom': '6px',
        border: `1px solid ${V.b}`,
        cursor: 'pointer',
        transition: 'all 0.12s',
        background: 'transparent',
      }}
      onClick={() => props.emit('press')}
    >
      <div style={{
        'font-size': '9px',
        'letter-spacing': '2px',
        'text-transform': 'uppercase',
        color: V.tf,
        'font-family': V.mono,
      }}>
        {props.props.type.replace('-', ' ')}
      </div>
      <div style={{
        'font-size': '13px',
        color: V.t,
        'margin-top': '2px',
        'font-family': V.mono,
      }}>
        {props.props.title}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════

export function Breadcrumb(props: BaseComponentProps<{ label: string }>) {
  return (
    <div
      style={{
        'font-size': '11px',
        color: V.cy,
        cursor: 'pointer',
        'margin-bottom': '20px',
        opacity: '0.7',
        transition: 'opacity 0.15s',
        'font-family': V.mono,
      }}
      onClick={() => props.emit('press')}
    >
      &larr; {props.props.label}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// BASE COMPONENTS
// ═══════════════════════════════════════════════════════════════

export function Stack(props: BaseComponentProps<{
  gap?: number;
  direction?: string;
  sectionId?: string;
  width?: string;
  minWidth?: string;
  maxWidth?: string;
  flex?: string;
  overflow?: string;
  borderRight?: string;
  padding?: string;
}>) {
  const dir = () => props.props.direction || 'vertical';
  const gap = () => {
    const g = props.props.gap;
    return typeof g === 'string' ? (parseInt(g as string) || 8) : (g ?? 8);
  };
  return (
    <div
      data-section-id={props.props.sectionId || undefined}
      style={{
      display: 'flex',
      'flex-direction': dir() === 'horizontal' ? 'row' : 'column',
      gap: `${gap()}px`,
      ...(props.props.width ? { width: props.props.width } : {}),
      ...(props.props.minWidth ? { 'min-width': props.props.minWidth } : {}),
      ...(props.props.maxWidth ? { 'max-width': props.props.maxWidth } : {}),
      ...(props.props.flex ? { flex: props.props.flex } : {}),
      ...(props.props.overflow ? { overflow: props.props.overflow } : {}),
      ...(props.props.borderRight ? { 'border-right': props.props.borderRight } : {}),
      ...(props.props.padding ? { padding: props.props.padding } : {}),
    }}>
      {props.children}
    </div>
  );
}

export function Text(props: BaseComponentProps<{
  content: string;
  size?: string;
  weight?: string;
  color?: string;
  mono?: boolean;
}>) {
  const fontSize = () => {
    switch (props.props.size) {
      case 'sm': return '12px';
      case 'lg': return '16px';
      case 'xl': return '20px';
      default: return '13px';
    }
  };
  return (
    <span style={{
      'font-size': fontSize(),
      'font-weight': props.props.weight === 'bold' ? '700' : props.props.weight === 'medium' ? '500' : '400',
      color: props.props.color || `var(--color-text-primary, ${V.t})`,
      'font-family': props.props.mono ? V.mono : 'inherit',
    }}>
      {props.props.content}
    </span>
  );
}

export function Divider(_props: BaseComponentProps<Record<string, never>>) {
  return <hr style={{ border: 'none', 'border-top': `1px solid ${V.b}`, margin: '8px 0' }} />;
}

export function Card(props: BaseComponentProps<{ title?: string; subtitle?: string }>) {
  return (
    <div style={{
      background: V.s1,
      'border-radius': '8px',
      border: `1px solid ${V.b2}`,
      padding: '16px',
    }}>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '14px',
          'font-weight': '600',
          color: V.t,
          'margin-bottom': props.props.subtitle ? '2px' : '12px',
        }}>
          {props.props.title}
        </div>
      </Show>
      <Show when={props.props.subtitle}>
        <div style={{ 'font-size': '12px', color: V.td, 'margin-bottom': '12px' }}>
          {props.props.subtitle}
        </div>
      </Show>
      {props.children}
    </div>
  );
}

export function Metric(props: BaseComponentProps<{ label: string; value: string }>) {
  return (
    <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', padding: '4px 0' }}>
      <span style={{ 'font-size': '12px', color: V.td }}>{props.props.label}</span>
      <span style={{ 'font-size': '14px', 'font-weight': '600', color: V.cy, 'font-family': V.mono }}>{props.props.value}</span>
    </div>
  );
}

export function Button(props: BaseComponentProps<{ label: string; variant?: string }>) {
  const bg = () => {
    switch (props.props.variant) {
      case 'primary': return V.cy;
      case 'danger': return V.cor;
      default: return V.s2;
    }
  };
  return (
    <button
      onClick={() => props.emit('press')}
      style={{
        background: bg(),
        color: props.props.variant === 'secondary' ? V.t : '#fff',
        border: props.props.variant === 'secondary' ? `1px solid ${V.b2}` : 'none',
        'border-radius': '6px',
        padding: '6px 12px',
        'font-size': '12px',
        'font-family': V.mono,
        cursor: 'pointer',
      }}
    >
      {props.props.label}
    </button>
  );
}

export function TextInput(props: BaseComponentProps<{ label?: string; placeholder?: string; value?: unknown }>) {
  const [valueRaw, setValue] = useBoundProp(props.props.value, props.bindings?.value);
  // useBoundProp returns raw value OR signal depending on binding — normalize to callable
  const localValue = typeof valueRaw === 'function' ? (valueRaw as () => unknown) : () => valueRaw;
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
      <Show when={props.props.label}>
        <label style={{ 'font-size': '11px', color: V.td, 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>
          {props.props.label}
        </label>
      </Show>
      <input
        type="text"
        value={String(localValue() ?? '')}
        placeholder={props.props.placeholder ?? ''}
        onInput={(e) => setValue(e.currentTarget.value)}
        style={{
          background: V.s1,
          color: V.t,
          border: `1px solid ${V.b2}`,
          'border-radius': '6px',
          padding: '8px 12px',
          'font-size': '13px',
          'font-family': V.mono,
          outline: 'none',
        }}
        onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = V.cy; }}
        onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = V.b2; }}
      />
    </div>
  );
}

export function TextArea(props: BaseComponentProps<{ label?: string; placeholder?: string; rows?: number; value?: unknown }>) {
  const [valueRaw, setValue] = useBoundProp(props.props.value, props.bindings?.value);
  // useBoundProp returns raw value OR signal depending on binding — normalize to callable
  const localValue = typeof valueRaw === 'function' ? (valueRaw as () => unknown) : () => valueRaw;
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
      <Show when={props.props.label}>
        <label style={{ 'font-size': '11px', color: V.td, 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>
          {props.props.label}
        </label>
      </Show>
      <textarea
        value={String(localValue() ?? '')}
        placeholder={props.props.placeholder ?? ''}
        rows={props.props.rows ?? 3}
        onInput={(e) => setValue(e.currentTarget.value)}
        style={{
          background: V.s1,
          color: V.t,
          border: `1px solid ${V.b2}`,
          'border-radius': '6px',
          padding: '8px 12px',
          'font-size': '13px',
          'font-family': V.mono,
          outline: 'none',
          resize: 'vertical',
        }}
        onFocus={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = V.cy; }}
        onBlur={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = V.b2; }}
      />
    </div>
  );
}

export function CodeBlock(props: BaseComponentProps<{ content: string; language?: string }>) {
  return (
    <pre style={{
      background: V.s1,
      'border-radius': '6px',
      padding: '12px',
      'font-size': '12px',
      'font-family': V.mono,
      color: V.t,
      overflow: 'auto',
      margin: '0',
      'white-space': 'pre-wrap',
    }}>
      {props.props.content}
    </pre>
  );
}

// ═══════════════════════════════════════════════════════════════
// TUI COMPONENTS
// ═══════════════════════════════════════════════════════════════

export function TuiPanel(props: BaseComponentProps<{ title?: string; titleColor?: string }>) {
  return (
    <div style={{
      border: `1px solid ${V.b2}`,
      background: V.s1,
      padding: '16px',
      position: 'relative',
    }}>
      <Show when={props.props.title}>
        <span style={{
          position: 'absolute',
          top: '-0.55em',
          left: '12px',
          padding: '0 6px',
          background: V.s1,
          'font-size': '10px',
          'letter-spacing': '2px',
          'text-transform': 'uppercase',
          color: props.props.titleColor || V.cy,
          'font-family': V.mono,
        }}>
          {props.props.title}
        </span>
      </Show>
      {props.children}
    </div>
  );
}

export function TuiStat(props: BaseComponentProps<{ label: string; value: string; color?: string }>) {
  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      'align-items': 'center',
      padding: '10px 16px',
      border: `1px solid ${V.b}`,
      background: V.s1,
      'min-width': '80px',
    }}>
      <span style={{
        'font-size': '10px',
        color: V.td,
        'letter-spacing': '1px',
        'text-transform': 'uppercase',
        'font-family': V.mono,
        'margin-bottom': '4px',
      }}>
        {props.props.label}
      </span>
      <span style={{
        'font-size': '20px',
        'font-weight': '700',
        color: props.props.color || V.cy,
        'font-family': V.mono,
      }}>
        {props.props.value}
      </span>
    </div>
  );
}

export function BarChart(props: BaseComponentProps<{ title?: string; maxHeight?: number; max?: number }>) {
  let barsRef: HTMLDivElement | undefined;

  // Compute max from children's data-value attrs, set CSS var, then resize bars.
  // SolidJS onMount fires children-first, then parent — so BarItem.onMount runs
  // before BarChart.onMount. We use rAF to defer past all synchronous onMount
  // calls, then compute max and explicitly set bar heights (BarItem.onMount may
  // have already run with stale/missing max, so we recompute from parent).
  const computeMaxAndResizeBars = () => {
    if (!barsRef) return;
    let max: number;
    if (props.props.max != null && props.props.max > 0) {
      max = props.props.max;
    } else {
      const values = Array.from(barsRef.querySelectorAll('[data-bar-value]'))
        .map(el => parseFloat((el as HTMLElement).dataset.barValue ?? '0'))
        .filter(v => !isNaN(v));
      max = values.length > 0 ? Math.max(...values) : 1;
    }
    barsRef.style.setProperty('--bar-chart-max', String(max));
    // Resize all child bars now that max is known
    barsRef.querySelectorAll<HTMLElement>('[data-bar-ref]').forEach(bar => {
      const value = parseFloat(bar.dataset.barRef ?? '0');
      if (!isNaN(value)) {
        const pct = Math.min(100, (value / max) * 100);
        bar.style.height = `${pct}%`;
      }
    });
  };

  onMount(() => requestAnimationFrame(computeMaxAndResizeBars));

  return (
    <div>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '10px',
          'letter-spacing': '2px',
          'text-transform': 'uppercase',
          color: V.td,
          'margin-bottom': '8px',
          'font-family': V.mono,
        }}>
          {props.props.title}
        </div>
      </Show>
      <div ref={barsRef} style={{
        display: 'flex',
        'align-items': 'flex-end',
        gap: '4px',
        height: `${props.props.maxHeight || 120}px`,
      }}>
        {props.children}
      </div>
    </div>
  );
}

export function BarItemComponent(props: BaseComponentProps<{ label: string; value: number; max?: number; color?: string }>) {
  let containerRef: HTMLDivElement | undefined;
  let barRef: HTMLDivElement | undefined;
  const numValue = () => {
    const v = props.props.value;
    if (typeof v === 'number') return v;
    const parsed = parseFloat(String(v));
    return isNaN(parsed) ? 0 : parsed;
  };
  const computeHeight = () => {
    if (!containerRef || !barRef) return;
    const rawMax = props.props.max != null ? parseFloat(String(props.props.max)) : 0;
    let max = rawMax > 0 ? rawMax : null;
    if (!max) {
      const parentMax = containerRef.parentElement?.style.getPropertyValue('--bar-chart-max');
      if (parentMax) {
        const parsed = parseFloat(parentMax);
        if (parsed > 0) max = parsed;
      }
    }
    if (!max) max = Math.max(numValue(), 1);
    const pct = Math.min(100, (numValue() / max) * 100);
    barRef.style.height = `${pct}%`;
  };
  // Compute after parent BarChart sets --bar-chart-max via onMount
  onMount(computeHeight);
  return (
    <div ref={containerRef} data-bar-value={numValue()} style={{
      display: 'flex',
      'flex-direction': 'column',
      'align-items': 'center',
      'justify-content': 'flex-end',
      flex: '1',
      height: '100%',
      'min-width': '28px',
    }}>
      <Show when={numValue() > 0}>
        <span style={{
          'font-size': '9px',
          color: props.props.color || V.cy,
          'font-family': V.mono,
          'margin-bottom': '2px',
        }}>
          {numValue() % 1 === 0 ? numValue() : numValue().toFixed(1)}
        </span>
      </Show>
      <div ref={barRef} data-bar-ref={numValue()} style={{
        width: '100%',
        background: props.props.color || V.cy,
        height: '0%',
        'min-height': numValue() > 0 ? '4px' : '0',
        opacity: numValue() > 0 ? '0.7' : '0.15',
        transition: 'height 0.3s ease',
      }} />
      <span style={{
        'font-size': '9px',
        color: V.tf,
        'margin-top': '4px',
        'font-family': V.mono,
        'white-space': 'nowrap',
      }}>
        {props.props.label}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CONTENT BLOCKS
// ═══════════════════════════════════════════════════════════════

export function DataBlock(props: BaseComponentProps<{ label?: string; content: string }>) {
  return (
    <div style={{
      position: 'relative',
      border: `1px solid ${V.b}`,
      background: V.s1,
      margin: '12px 0',
    }}>
      <Show when={props.props.label}>
        <span style={{
          position: 'absolute',
          top: '-0.55em',
          left: '10px',
          padding: '0 6px',
          background: V.s1,
          'font-size': '9px',
          'letter-spacing': '1px',
          color: V.tf,
          'font-family': V.mono,
        }}>
          {props.props.label}
        </span>
      </Show>
      <pre style={{
        padding: '12px 14px',
        'font-size': '11px',
        'line-height': '1.5',
        color: V.t,
        'font-family': V.mono,
        margin: '0',
        'white-space': 'pre-wrap',
        overflow: 'auto',
      }}>
        {props.props.content}
      </pre>
    </div>
  );
}

export function Image(props: BaseComponentProps<{ src: string; alt?: string; maxWidth?: number; maxHeight?: number; borderRadius?: number; caption?: string }>) {
  const [blobUrl, setBlobUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);

  let currentBlobUrl: string | null = null;

  createEffect(() => {
    const src = props.props.src;

    // Abort any in-flight fetch when src changes or component unmounts
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 5000);
    onCleanup(() => {
      clearTimeout(timeoutId);
      controller.abort();
    });

    if (!src) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // Revoke previous blob URL to avoid leaking memory
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }

    // Filename with no slashes → attachment (needs auth); otherwise treat as public URL
    const isAttachment = !src.includes('/') && !src.startsWith('http');
    const fetchUrl = isAttachment
      ? `${window.__FLOATTY_SERVER_URL__}/api/v1/attachments/${encodeURIComponent(src)}`
      : src;

    const doFetch = isAttachment
      ? fetch(fetchUrl, {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${window.__FLOATTY_API_KEY__ ?? ''}` },
        })
      : fetch(fetchUrl, { signal: controller.signal });

    doFetch
      .then(async (res) => {
        clearTimeout(timeoutId);
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}`);
        }
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        currentBlobUrl = url;
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError' && !timedOut) return;
        clearTimeout(timeoutId);
        setError(timedOut ? 'Request timed out' : err.message);
        // Fallback: try direct src as-is for public URLs
        if (!isAttachment) {
          setBlobUrl(src);
        }
        setLoading(false);
      });
  });

  onCleanup(() => {
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
  });

  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      gap: '8px',
      margin: '12px 0',
    }}>
      <Show when={loading()}>
        <div style={{
          'font-size': '12px',
          color: V.td,
          'font-family': V.mono,
          padding: '12px',
          border: `1px solid ${V.b}`,
          background: V.s1,
        }}>
          ⋯ {props.props.src}
        </div>
      </Show>
      <Show when={error() && !blobUrl()}>
        <div style={{
          'font-size': '12px',
          color: V.cor,
          'font-family': V.mono,
          padding: '12px',
          border: `1px solid ${V.cor}`,
          background: V.s1,
        }}>
          ⚠ {props.props.src}: {error()}
        </div>
      </Show>
      <Show when={blobUrl()}>
        <img
          src={blobUrl()!}
          alt={props.props.alt || props.props.src}
          style={{
            'max-width': props.props.maxWidth ? `${props.props.maxWidth}px` : '100%',
            'max-height': props.props.maxHeight ? `${props.props.maxHeight}px` : 'auto',
            'border-radius': props.props.borderRadius ? `${props.props.borderRadius}px` : '0px',
            border: `1px solid ${V.b}`,
            display: 'block',
          }}
        />
      </Show>
      <Show when={props.props.caption}>
        <div style={{
          'font-size': '11px',
          color: V.td,
          'font-family': V.mono,
          'text-align': 'center',
          'padding-top': '4px',
        }}>
          {props.props.caption}
        </div>
      </Show>
    </div>
  );
}

export function ShippedItem(props: BaseComponentProps<{ content: string }>) {
  return (
    <div style={{
      display: 'flex',
      gap: '8px',
      'font-size': '12px',
      'line-height': '1.5',
      'font-family': V.mono,
      padding: '2px 0',
    }}>
      <span style={{ color: V.green, 'flex-shrink': '0' }}>*</span>
      <span style={{ color: V.t }} innerHTML={sanitize(inlineFormat(props.props.content))} onClick={handleWikilinkClick} />
    </div>
  );
}

export function WikilinkChip(props: BaseComponentProps<{ target: string; label?: string }>) {
  return (
    <span
      ref={(el) => {
        el.addEventListener('click', (e: MouseEvent) => {
          emitChirpNavigate(el, props.props.target, e);
        });
      }}
      class="bbs-wikilink"
      data-wikilink={props.props.target}
      style={{ cursor: 'pointer' }}
    >
      [[{props.props.label || props.props.target}]]
    </span>
  );
}

export function BacklinksFooter(props: BaseComponentProps<{ inbound: string[]; outbound: string[] }>) {
  const wireLink = (el: HTMLSpanElement, target: string) => {
    el.addEventListener('click', (e: MouseEvent) => {
      emitChirpNavigate(el, target, e);
    });
  };
  return (
    <div style={{
      'border-top': `1px dashed ${V.b}`,
      'margin-top': '12px',
      'padding-top': '8px',
      'font-size': '11px',
      'font-family': V.mono,
      color: V.tf,
      display: 'flex',
      'flex-wrap': 'wrap',
      gap: '4px 12px',
    }}>
      <Show when={props.props.inbound.length > 0}>
        <span style={{ color: V.tf }}>referenced by </span>
        <For each={props.props.inbound}>
          {(link) => (
            <span ref={(el) => wireLink(el, link)}
              class="bbs-wikilink" data-wikilink={link} style={{ cursor: 'pointer' }}>
              [[{link}]]
            </span>
          )}
        </For>
      </Show>
      <Show when={props.props.outbound.length > 0}>
        <span style={{ color: V.tf }}>links to </span>
        <For each={props.props.outbound}>
          {(link) => (
            <span ref={(el) => wireLink(el, link)}
              class="bbs-wikilink" data-wikilink={link} style={{ cursor: 'pointer' }}>
              [[{link}]]
            </span>
          )}
        </For>
      </Show>
    </div>
  );
}

export function PatternCard(props: BaseComponentProps<{
  label: string;
  description: string;
  confidence?: 'high' | 'medium' | 'low';
}>) {
  const [expanded, setExpanded] = createSignal(true);

  const confidenceColor = () => {
    switch (props.props.confidence) {
      case 'high': return V.green;
      case 'medium': return V.amb;
      case 'low': return V.tf;
      default: return V.td;
    }
  };

  return (
    <div style={{
      border: `1px solid ${V.b}`,
      background: V.s1,
      margin: '8px 0',
    }}>
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '10px 14px',
          cursor: 'pointer',
          'border-bottom': expanded() ? `1px solid ${V.b}` : 'none',
        }}
        onClick={() => setExpanded(v => !v)}
      >
        <span style={{ color: V.tf, 'font-size': '12px', 'font-family': V.mono }}>
          {expanded() ? '\u25BC' : '\u25B6'}
        </span>
        <span style={{
          'font-size': '13px',
          'font-weight': '600',
          color: V.t,
          flex: '1',
          'font-family': V.mono,
        }}>
          {props.props.label}
        </span>
        <Show when={props.props.confidence}>
          <span style={{
            'font-size': '10px',
            color: confidenceColor(),
            'font-family': V.mono,
            'text-transform': 'uppercase',
            'letter-spacing': '1px',
          }}>
            {props.props.confidence}
          </span>
        </Show>
      </div>

      <Show when={expanded()}>
        <div style={{ padding: '12px 14px' }}>
          <div class="bbs-entry-body" innerHTML={sanitize(renderMarkdown(props.props.description))} onClick={handleWikilinkClick} />
          {props.children}
        </div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// BODY STYLES
// ═══════════════════════════════════════════════════════════════

export const BODY_STYLES = `
.bbs-entry-body {
  font-family: ${V.serif};
  font-size: 16px;
  color: ${V.td};
  line-height: 1.65;
}
/* FLO-625: Prose elements self-constrain to a reading column so bare
   EntryBody / PatternCard content reads well at any pane width. Tables,
   pre blocks, and hr stay at container width so data/code can sprawl. */
.bbs-entry-body > p,
.bbs-entry-body > ul,
.bbs-entry-body > ol,
.bbs-entry-body > blockquote,
.bbs-entry-body > h1,
.bbs-entry-body > h2,
.bbs-entry-body > h3 {
  max-width: var(--content-max-width, 720px);
}
.bbs-entry-body h1 {
  font-family: ${V.mono};
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  margin: 32px 0 12px;
  letter-spacing: 1px;
}
.bbs-entry-body h2 {
  font-family: ${V.mono};
  font-size: 15px;
  font-weight: 700;
  color: ${V.mag};
  margin: 28px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid ${V.b};
}
.bbs-entry-body h3 {
  font-family: ${V.mono};
  font-size: 13px;
  color: ${V.cy};
  margin: 24px 0 8px;
  letter-spacing: 1px;
}
.bbs-entry-body p { margin-bottom: 14px; }
.bbs-entry-body strong { color: #fff; font-weight: 600; }
.bbs-entry-body em { color: ${V.mag}; font-style: normal; }
.bbs-entry-body pre {
  background: ${V.s1};
  padding: 14px 16px;
  margin: 16px 0;
  overflow-x: auto;
  font-family: ${V.mono};
  font-size: 11px;
  line-height: 1.6;
  color: ${V.cy};
  border-left: 3px solid ${V.magD};
}
.bbs-entry-body code {
  font-family: ${V.mono};
  font-size: 12px;
  background: ${V.s2};
  padding: 1px 6px;
  color: ${V.cy};
}
.bbs-entry-body pre code { background: none; padding: 0; }
.bbs-entry-body blockquote {
  border-left: 3px solid ${V.mag};
  padding: 10px 16px;
  margin: 16px 0;
  background: rgba(224,64,160,.05);
  color: ${V.t};
  font-style: italic;
}
.bbs-entry-body ul, .bbs-entry-body ol {
  margin: 12px 0;
  padding-left: 20px;
}
.bbs-entry-body li { margin-bottom: 6px; }
.bbs-entry-body hr {
  border: none;
  height: 1px;
  background: ${V.b};
  margin: 28px 0;
}
.bbs-entry-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
  font-family: ${V.mono};
  font-size: 12px;
  line-height: 1.4;
}
.bbs-entry-body th {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 2px solid ${V.b2};
  color: ${V.cy};
  font-weight: 700;
  letter-spacing: 0.5px;
  white-space: nowrap;
  vertical-align: bottom;
}
.bbs-entry-body td {
  padding: 6px 12px;
  border-bottom: 1px solid ${V.b};
  color: ${V.td};
  vertical-align: top;
  white-space: nowrap;
}
.bbs-entry-body td:last-child {
  white-space: normal;
}
.bbs-entry-body tr:hover td {
  background: ${V.s2};
}
.bbs-marker {
  color: ${V.tf};
  font-size: 11px;
}
.bbs-wikilink {
  color: ${V.cy};
  cursor: pointer;
  border-bottom: 1px dotted ${V.cy}40;
  transition: border-color 0.1s;
}
.bbs-wikilink:hover {
  border-bottom-color: ${V.cy};
}
`;

// ═══════════════════════════════════════════════════════════════
// ARC TIMELINE — timelog visualization (ported from daddy's mockup)
// ═══════════════════════════════════════════════════════════════

interface ArcEntry { time: string; label: string; project: string; }
interface Arc { name: string; start: string; end: string; project: string; entries?: number; }

const ARC_PROJECT_COLORS: Record<string, { fg: string; dim: string; med: string }> = {
  floatty: { fg: V.cy, dim: 'rgba(0,229,255,0.12)', med: 'rgba(0,229,255,0.3)' },
  'float-hub': { fg: V.green, dim: 'rgba(152,195,121,0.12)', med: 'rgba(152,195,121,0.3)' },
  'json-render': { fg: V.mag, dim: 'rgba(224,64,160,0.12)', med: 'rgba(224,64,160,0.3)' },
  rangle: { fg: V.amb, dim: 'rgba(255,179,0,0.12)', med: 'rgba(255,179,0,0.3)' },
};

function entryMatchesArc(e: ArcEntry, arc: Arc): boolean {
  const aStart = arcTimeToMinutes(arc.start);
  const aEnd = arcTimeToMinutes(arc.end);
  const eTime = arcTimeToMinutes(e.time);
  return eTime >= aStart && eTime <= aEnd && (e.project === arc.project || e.project === 'float-hub');
}

function arcTimeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function arcColor(project: string): { fg: string; dim: string; med: string } {
  return ARC_PROJECT_COLORS[project] ?? { fg: '#888', dim: 'rgba(136,136,136,0.12)', med: 'rgba(136,136,136,0.3)' };
}

export function ArcTimeline(props: BaseComponentProps<{
  entries: ArcEntry[];
  arcs: Arc[];
  title?: string;
}>) {
  const [expandedArc, setExpandedArc] = createSignal<number | null>(null);

  const entries = () => props.props.entries ?? [];
  const arcs = () => props.props.arcs ?? [];

  const orphans = () => entries().filter((e) =>
    !arcs().some((a) => entryMatchesArc(e, a))
  );

  return (
    <div style={{ padding: '0 0 16px 0' }}>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '11px', color: '#666', 'margin-bottom': '12px',
          'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.1em',
        }}>
          {props.props.title}
        </div>
      </Show>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
        <For each={arcs()}>
          {(arc, i) => {
            const colors = arcColor(arc.project);
            const isExpanded = () => expandedArc() === i();
            const startMin = arcTimeToMinutes(arc.start);
            const endMin = arcTimeToMinutes(arc.end);
            const arcEntries = createMemo(() => entries().filter((e) => entryMatchesArc(e, arc)));
            const durationH = () => ((endMin - startMin) / 60).toFixed(1);
            const doneCount = () => arcEntries().filter(e => e.label.includes('DONE')).length;

            return (
              <div>
                <div
                  onClick={() => setExpandedArc(isExpanded() ? null : i())}
                  style={{
                    display: 'flex', 'align-items': 'center', gap: '12px',
                    padding: '10px 14px', cursor: 'pointer',
                    background: isExpanded() ? colors.dim : 'rgba(255,255,255,0.02)',
                    'border-left': `3px solid ${colors.fg}`,
                    'border-radius': '0 4px 4px 0',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <span style={{
                    'font-family': V.mono, 'font-size': '10px', color: '#666',
                    width: '90px', 'flex-shrink': '0',
                  }}>
                    {arc.start} → {arc.end}
                  </span>
                  <span style={{
                    'font-family': V.serif, 'font-size': '13px', color: colors.fg,
                    'font-weight': '600', flex: '1', 'min-width': '0',
                    'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis',
                  }}>
                    {arc.name}
                  </span>
                  <div style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'flex-shrink': '0' }}>
                    <Show when={doneCount() > 0}>
                      <span style={{
                        'font-family': V.mono, 'font-size': '9px', color: '#98c379',
                        padding: '2px 6px', background: 'rgba(152,195,121,0.1)', 'border-radius': '3px',
                      }}>
                        {doneCount()} DONE
                      </span>
                    </Show>
                    <span style={{ 'font-family': V.mono, 'font-size': '10px', color: '#666' }}>
                      {durationH()}h · {arcEntries().length} entries
                    </span>
                    <span style={{
                      'font-family': V.mono, 'font-size': '12px', color: '#555',
                      transform: isExpanded() ? 'rotate(90deg)' : 'rotate(0)',
                      transition: 'transform 0.2s ease', display: 'inline-block',
                    }}>
                      ▸
                    </span>
                  </div>
                </div>
                <Show when={isExpanded()}>
                  <div style={{
                    'border-left': `1px solid ${colors.dim}`,
                    'margin-left': '14px', 'padding-left': '16px',
                    'padding-top': '4px', 'padding-bottom': '8px',
                  }}>
                    <For each={arcEntries()}>
                      {(entry) => {
                        const isDone = entry.label.includes('DONE');
                        const isDigest = entry.label.includes('digest') || entry.label.includes('sync');
                        const entryColors = arcColor(entry.project);
                        return (
                          <div style={{
                            display: 'flex', gap: '10px', 'align-items': 'flex-start',
                            padding: '4px 0', 'font-family': V.mono, 'font-size': '11px',
                            opacity: isDigest ? '0.5' : '1',
                          }}>
                            <span style={{ color: '#555', width: '42px', 'flex-shrink': '0' }}>
                              {entry.time}
                            </span>
                            <span style={{
                              width: '6px', height: '6px',
                              'border-radius': isDone ? '1px' : '3px',
                              background: isDone ? '#98c379' : entryColors.med,
                              border: `1px solid ${isDone ? '#98c379' : entryColors.fg}`,
                              'flex-shrink': '0', 'margin-top': '4px',
                            }} />
                            <span style={{
                              color: isDone ? '#98c379' : '#aaa',
                              'font-weight': isDone ? '600' : '400',
                            }}>
                              {entry.label}
                            </span>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={orphans().length > 0}>
          <div style={{ 'margin-top': '8px' }}>
            <div style={{
              padding: '8px 14px',
              'border-left': '3px solid #555',
              'border-radius': '0 4px 4px 0',
              background: 'rgba(255,255,255,0.02)',
            }}>
              <span style={{ 'font-family': V.mono, 'font-size': '11px', color: '#666' }}>
                {orphans().length} entries outside arcs
              </span>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MEETING DIFF — before/after process change visualization
// ═══════════════════════════════════════════════════════════════

interface DiffStep { step: string; status: 'unchanged' | 'removed' | 'added'; }
interface DiffAction { who: string; what: string; status: string; blocker?: string; }

export function MeetingDiff(props: BaseComponentProps<{
  title: string;
  meeting: string;
  before: DiffStep[];
  after: DiffStep[];
  newDecisions?: string[];
  actions?: DiffAction[];
}>) {
  const before = () => props.props.before ?? [];
  const after = () => props.props.after ?? [];
  const decisions = () => props.props.newDecisions ?? [];
  const actions = () => props.props.actions ?? [];

  const statusColor = (s: string) =>
    s === 'blocked' ? V.amb : s === 'todo' ? V.cy : s === 'done' ? V.green : '#555';

  return (
    <div>
      <div style={{
        'font-size': '9px', color: '#555', 'letter-spacing': '0.12em',
        'margin-bottom': '6px', 'font-family': V.mono,
      }}>
        MEETING DIFF · {props.props.meeting}
      </div>
      <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '16px', 'margin-bottom': '20px' }}>
        <div>
          <div style={{
            'font-size': '11px', 'font-family': V.mono, color: V.cor,
            'font-weight': '700', 'margin-bottom': '10px', padding: '4px 8px',
            background: 'rgba(255,107,107,0.08)', 'border-radius': '4px',
          }}>BEFORE</div>
          <For each={before()}>
            {(s, i) => (
              <div style={{
                display: 'flex', 'align-items': 'flex-start', gap: '8px', padding: '6px 0',
                'border-left': `2px solid ${s.status === 'removed' ? 'rgba(255,107,107,0.4)' : 'rgba(255,255,255,0.08)'}`,
                'padding-left': '10px', 'margin-bottom': '2px',
                opacity: s.status === 'removed' ? '0.5' : '1',
                'text-decoration': s.status === 'removed' ? 'line-through' : 'none',
              }}>
                <span style={{ 'font-family': V.mono, 'font-size': '11px', color: s.status === 'removed' ? V.cor : '#888' }}>
                  {i() + 1}.
                </span>
                <span style={{ 'font-family': V.mono, 'font-size': '11px', color: s.status === 'removed' ? V.cor : '#aaa' }}>
                  {s.step}
                </span>
              </div>
            )}
          </For>
        </div>
        <div>
          <div style={{
            'font-size': '11px', 'font-family': V.mono, color: V.green,
            'font-weight': '700', 'margin-bottom': '10px', padding: '4px 8px',
            background: 'rgba(152,195,121,0.08)', 'border-radius': '4px',
          }}>AFTER</div>
          <For each={after()}>
            {(s, i) => (
              <div style={{
                display: 'flex', 'align-items': 'flex-start', gap: '8px', padding: '6px 0',
                'border-left': `2px solid ${s.status === 'added' ? 'rgba(152,195,121,0.4)' : 'rgba(255,255,255,0.08)'}`,
                'padding-left': '10px', 'margin-bottom': '2px',
              }}>
                <span style={{ 'font-family': V.mono, 'font-size': '11px', color: s.status === 'added' ? V.green : '#888' }}>
                  {i() + 1}.
                </span>
                <span style={{ 'font-family': V.mono, 'font-size': '11px', color: s.status === 'added' ? V.green : '#aaa' }}>
                  {s.step}
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
      <Show when={decisions().length > 0}>
        <div style={{ 'border-top': '1px solid rgba(255,255,255,0.06)', 'padding-top': '12px', 'margin-bottom': '16px' }}>
          <div style={{ 'font-size': '10px', 'font-family': V.mono, color: '#555', 'margin-bottom': '8px', 'letter-spacing': '0.08em' }}>
            NEW DECISIONS
          </div>
          <For each={decisions()}>
            {(d) => (
              <div style={{ display: 'flex', gap: '8px', padding: '3px 0', 'font-family': V.mono, 'font-size': '11px', color: V.t }}>
                <span style={{ color: V.green }}>+</span> {d}
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={actions().length > 0}>
        <div style={{ 'border-top': '1px solid rgba(255,255,255,0.06)', 'padding-top': '12px' }}>
          <div style={{ 'font-size': '10px', 'font-family': V.mono, color: '#555', 'margin-bottom': '8px', 'letter-spacing': '0.08em' }}>
            ACTION ITEMS
          </div>
          <For each={actions()}>
            {(a) => (
              <div style={{ display: 'flex', gap: '10px', padding: '5px 0', 'font-family': V.mono, 'font-size': '11px', 'align-items': 'center' }}>
                <span style={{
                  padding: '1px 6px', 'border-radius': '3px', 'font-size': '9px', 'font-weight': '600',
                  background: `${statusColor(a.status)}22`, color: statusColor(a.status),
                }}>{a.status}</span>
                <span style={{ color: '#888', width: '80px' }}>{a.who}</span>
                <span style={{ color: V.t }}>{a.what}</span>
                <Show when={a.blocker}>
                  <span style={{ color: V.cor, 'font-size': '10px' }}>blocked by {a.blocker}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DECISION LOG — filterable decision list with status
// ═══════════════════════════════════════════════════════════════

interface Decision { date: string; meeting: string; text: string; status: string; source?: string; project?: string; }

export function DecisionLog(props: BaseComponentProps<{
  decisions: Decision[];
  title?: string;
}>) {
  const [filter, setFilter] = createSignal('all');
  const decisions = () => props.props.decisions ?? [];
  const filtered = createMemo(() =>
    filter() === 'all' ? decisions() : decisions().filter(d => d.status === filter())
  );
  const statuses = createMemo(() => [...new Set(decisions().map(d => d.status))]);

  return (
    <div>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '11px', color: '#666', 'margin-bottom': '12px',
          'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.1em',
        }}>{props.props.title}</div>
      </Show>
      <div style={{ display: 'flex', gap: '8px', 'margin-bottom': '16px' }}>
        <button onClick={() => setFilter('all')} style={{
          padding: '4px 10px', border: 'none', 'border-radius': '3px', cursor: 'pointer',
          'font-family': V.mono, 'font-size': '10px',
          background: filter() === 'all' ? 'rgba(255,255,255,0.1)' : 'transparent',
          color: filter() === 'all' ? '#e6edf3' : '#555',
        }}>all ({decisions().length})</button>
        <For each={statuses()}>
          {(s) => (
            <button onClick={() => setFilter(s)} style={{
              padding: '4px 10px', border: 'none', 'border-radius': '3px', cursor: 'pointer',
              'font-family': V.mono, 'font-size': '10px',
              background: filter() === s ? 'rgba(255,255,255,0.1)' : 'transparent',
              color: filter() === s ? '#e6edf3' : '#555',
            }}>{s} ({decisions().filter(d => d.status === s).length})</button>
          )}
        </For>
      </div>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
        <For each={filtered()}>
          {(d) => (
            <div style={{
              display: 'flex', gap: '12px', padding: '8px 12px', 'align-items': 'flex-start',
              'border-left': `3px solid ${d.status === 'superseded' ? '#555' : V.cy}`,
              background: d.status === 'superseded' ? 'transparent' : 'rgba(255,255,255,0.02)',
              opacity: d.status === 'superseded' ? '0.5' : '1',
              'border-radius': '0 3px 3px 0',
            }}>
              <div style={{ width: '70px', 'flex-shrink': '0' }}>
                <div style={{ 'font-family': V.mono, 'font-size': '10px', color: '#666' }}>{d.date.slice(5)}</div>
                <div style={{ 'font-family': V.mono, 'font-size': '9px', color: '#444' }}>{d.meeting}</div>
              </div>
              <div style={{ flex: '1', 'min-width': '0' }}>
                <div style={{
                  'font-family': V.serif, 'font-size': '12px',
                  color: d.status === 'superseded' ? '#666' : V.t,
                  'text-decoration': d.status === 'superseded' ? 'line-through' : 'none',
                  'line-height': '1.4',
                }}>{d.text}</div>
              </div>
              <div style={{
                'flex-shrink': '0', 'font-family': V.mono, 'font-size': '9px',
                padding: '2px 6px', 'border-radius': '3px',
                background: d.status === 'active' ? 'rgba(152,195,121,0.1)' : 'rgba(255,255,255,0.05)',
                color: d.status === 'active' ? V.green : '#555',
              }}>{d.status}</div>
            </div>
          )}
        </For>
      </div>
      <div style={{ 'margin-top': '12px', 'font-family': V.mono, 'font-size': '10px', color: '#444' }}>
        {filtered().length} decisions across {new Set(filtered().map(d => d.meeting)).size} meetings
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DEPENDENCY CHAIN — horizontal linked issue cards
// ═══════════════════════════════════════════════════════════════

interface DepNode { id: string; title: string; assignee: string; status: string; deps: string[]; }

export function DependencyChain(props: BaseComponentProps<{
  nodes: DepNode[];
  blocker?: string;
}>) {
  const nodes = () => props.props.nodes ?? [];
  const statusColor = (s: string) =>
    s === 'todo' ? V.cy : s === 'blocked' ? V.amb : s === 'done' ? V.green : '#555';

  return (
    <div>
      <div style={{ display: 'flex', gap: '0', 'align-items': 'stretch' }}>
        <For each={nodes()}>
          {(dep, i) => {
            const sc = statusColor(dep.status);
            return (
              <div style={{ display: 'flex', 'align-items': 'center', flex: '1' }}>
                <div style={{
                  flex: '1', padding: '14px 16px',
                  background: `${sc}0F`,
                  border: `1px solid ${sc}33`,
                  'border-radius': i() === 0 ? '6px 0 0 6px' : i() === nodes().length - 1 ? '0 6px 6px 0' : '0',
                }}>
                  <div style={{ 'font-family': V.mono, 'font-size': '12px', 'font-weight': '700', color: sc, 'margin-bottom': '4px' }}>
                    {dep.id}
                  </div>
                  <div style={{ 'font-family': V.mono, 'font-size': '11px', color: '#aaa', 'margin-bottom': '6px' }}>
                    {dep.title}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                    <span style={{ 'font-family': V.mono, 'font-size': '10px', color: '#666' }}>{dep.assignee}</span>
                    <span style={{
                      padding: '1px 5px', 'border-radius': '2px', 'font-size': '9px', 'font-weight': '600',
                      'font-family': V.mono, background: `${sc}22`, color: sc,
                    }}>{dep.status}</span>
                  </div>
                </div>
                <Show when={i() < nodes().length - 1}>
                  <div style={{
                    width: '32px', display: 'flex', 'align-items': 'center', 'justify-content': 'center',
                    color: '#444', 'font-size': '16px', 'font-family': V.mono,
                  }}>→</div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={props.props.blocker}>
        <div style={{
          'margin-top': '12px', padding: '8px 12px', 'border-radius': '4px',
          background: 'rgba(255,179,0,0.06)', border: '1px solid rgba(255,179,0,0.15)',
          'font-family': V.mono, 'font-size': '11px', color: V.amb,
        }}>
          ⚠ {props.props.blocker}
        </div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT STREAM — filterable ctx:: capture timeline
// ═══════════════════════════════════════════════════════════════

const STREAM_PROJECT_COLORS: Record<string, string> = {
  floatty: V.cy, 'floatty/doors-v2': V.cy, 'json-render': V.mag,
  'rangle/pharmacy': V.amb, 'rangle/skills-for-change': V.green, 'float-hub': V.green,
};
const STREAM_MODE_COLORS: Record<string, string> = {
  debugging: V.cor, 'session-archaeology': '#c678dd', digest: V.green,
  'float-loop': V.cy, 'incoming-requirements': V.amb, onboarding: V.green,
  meeting: V.mag, 'post-meeting': V.mag,
};

interface CtxCapture { time: string; project: string; mode: string; text: string; }

export function ContextStream(props: BaseComponentProps<{
  captures: CtxCapture[];
  title?: string;
}>) {
  const [expandedIdx, setExpandedIdx] = createSignal<number | null>(null);
  const [projectFilter, setProjectFilter] = createSignal<string | null>(null);

  const captures = () => props.props.captures ?? [];
  const projects = createMemo(() => [...new Set(captures().map(c => c.project))]);
  const filtered = createMemo(() =>
    projectFilter() ? captures().filter(c => c.project === projectFilter()) : captures()
  );
  const transitions = createMemo(() => {
    const t: number[] = [];
    const f = filtered();
    for (let i = 1; i < f.length; i++) {
      if (f[i].project !== f[i - 1].project) t.push(i);
    }
    return t;
  });

  return (
    <div>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '11px', color: '#666', 'margin-bottom': '12px',
          'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.1em',
        }}>{props.props.title}</div>
      </Show>
      <div style={{ display: 'flex', gap: '6px', 'margin-bottom': '14px', 'flex-wrap': 'wrap' }}>
        <button onClick={() => setProjectFilter(null)} style={{
          padding: '3px 8px', border: 'none', 'border-radius': '3px', cursor: 'pointer',
          'font-family': V.mono, 'font-size': '10px',
          background: !projectFilter() ? 'rgba(255,255,255,0.1)' : 'transparent',
          color: !projectFilter() ? '#e6edf3' : '#555',
        }}>all</button>
        <For each={projects()}>
          {(p) => {
            const pc = STREAM_PROJECT_COLORS[p] ?? '#888';
            return (
              <button onClick={() => setProjectFilter(projectFilter() === p ? null : p)} style={{
                padding: '3px 8px', border: 'none', 'border-radius': '3px', cursor: 'pointer',
                'font-family': V.mono, 'font-size': '10px',
                background: projectFilter() === p ? `${pc}22` : 'transparent',
                color: projectFilter() === p ? pc : '#555',
              }}>{p.split('/').pop()}</button>
            );
          }}
        </For>
      </div>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '0' }}>
        <For each={filtered()}>
          {(ctx, i) => {
            const isTransition = () => transitions().includes(i());
            const isExpanded = () => expandedIdx() === i();
            const projColor = STREAM_PROJECT_COLORS[ctx.project] ?? '#888';
            const modeColor = STREAM_MODE_COLORS[ctx.mode] ?? '#888';
            return (
              <div>
                <Show when={isTransition()}>
                  <div style={{
                    padding: '4px 0', margin: '4px 0',
                    'border-top': '1px dashed rgba(255,255,255,0.06)',
                    'font-family': V.mono, 'font-size': '9px', color: '#444',
                    'padding-left': '52px',
                  }}>
                    context switch → {ctx.project}
                  </div>
                </Show>
                <div
                  onClick={() => setExpandedIdx(isExpanded() ? null : i())}
                  style={{
                    display: 'flex', gap: '8px', padding: '5px 8px', cursor: 'pointer',
                    'border-left': `2px solid ${projColor}`,
                    background: isExpanded() ? 'rgba(255,255,255,0.03)' : 'transparent',
                    'border-radius': '0 2px 2px 0',
                    transition: 'background 0.15s ease',
                  }}
                >
                  <span style={{ 'font-family': V.mono, 'font-size': '10px', color: '#555', width: '58px', 'flex-shrink': '0' }}>
                    {ctx.time}
                  </span>
                  <span style={{
                    'font-family': V.mono, 'font-size': '9px', padding: '1px 4px', 'border-radius': '2px',
                    background: `${modeColor}15`, color: modeColor, 'flex-shrink': '0',
                    width: '80px', 'text-align': 'center', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap',
                  }}>{ctx.mode}</span>
                  <span style={{
                    'font-family': V.mono, 'font-size': '11px', color: '#aaa',
                    flex: '1', 'min-width': '0',
                    'white-space': isExpanded() ? 'normal' : 'nowrap',
                    overflow: isExpanded() ? 'visible' : 'hidden',
                    'text-overflow': 'ellipsis',
                  }}>{ctx.text}</span>
                </div>
              </div>
            );
          }}
        </For>
      </div>
      <div style={{ 'margin-top': '12px', 'font-family': V.mono, 'font-size': '10px', color: '#444' }}>
        {filtered().length} captures · {new Set(filtered().map(c => c.project)).size} projects · {new Set(filtered().map(c => c.mode)).size} modes
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// COMPOSITES
// ═══════════════════════════════════════════════════════════════

const MODE_COLORS: Record<string, string> = {
  work: V.cy, float: V.mag, life: V.green, pebble: V.amb, rent: V.cor, spike: V.cor,
};

export function ModeTag(props: BaseComponentProps<{
  mode: string;
  count?: number;
  size?: 'sm' | 'md';
}>) {
  const sm = () => (props.props.size ?? 'sm') === 'sm';
  const color = () => MODE_COLORS[props.props.mode] ?? V.td;
  return (
    <span style={{
      display: 'inline-block',
      padding: sm() ? '2px 6px' : '3px 8px',
      'font-size': sm() ? '9px' : '10px',
      'font-family': V.mono,
      'text-transform': 'uppercase',
      'letter-spacing': '0.06em',
      color: color(),
      background: `${color()}18`,
      'border-radius': '3px',
    }}>
      {props.props.mode}
      <Show when={props.props.count != null}>
        <span style={{ opacity: 0.7 }}>{` (${props.props.count})`}</span>
      </Show>
    </span>
  );
}

export function QuoteBlock(props: BaseComponentProps<{
  text: string;
  attribution?: string;
  type?: 'quote' | 'insight' | 'note';
}>) {
  const borderColor = () => {
    const t = props.props.type ?? 'quote';
    return t === 'insight' ? V.cy : t === 'note' ? V.amb : V.td;
  };
  return (
    <div style={{
      'border-left': `3px solid ${borderColor()}`,
      'padding-left': '14px',
      margin: '8px 0',
    }}>
      <div
        style={{ 'font-family': V.serif, 'font-size': '12px', color: V.t, 'font-style': 'italic', 'line-height': '1.6' }}
        innerHTML={sanitize(inlineFormat(props.props.text))}
      />
      <Show when={props.props.attribution}>
        <div style={{ 'font-family': V.mono, 'font-size': '9px', color: V.tf, 'margin-top': '6px' }}>
          — {props.props.attribution}
        </div>
      </Show>
    </div>
  );
}

export function TimeEntry(props: BaseComponentProps<{
  time: string;
  title: string;
  body?: string;
  tags?: string[];
  color?: string;
}>) {
  const dotColor = () => props.props.color ?? V.cy;
  const tags = () => props.props.tags ?? [];
  return (
    <div style={{ display: 'flex', gap: '10px', padding: '4px 0', 'align-items': 'flex-start' }}>
      <div style={{ 'min-width': '42px', 'font-family': V.mono, 'font-size': '10px', color: V.td, 'padding-top': '2px' }}>
        {props.props.time}
      </div>
      <div style={{
        width: '6px', height: '6px', 'border-radius': '50%', background: dotColor(),
        'flex-shrink': 0, 'margin-top': '5px',
      }} />
      <div style={{ flex: 1 }}>
        <div style={{ 'font-size': '12px', color: V.t }}>{props.props.title}</div>
        <Show when={props.props.body}>
          <div
            style={{ 'font-family': V.serif, 'font-size': '11px', color: V.td, 'margin-top': '3px', 'line-height': '1.5' }}
            innerHTML={sanitize(inlineFormat(props.props.body!))}
          />
        </Show>
        <Show when={tags().length > 0}>
          <div style={{ display: 'flex', gap: '4px', 'margin-top': '4px', 'flex-wrap': 'wrap' }}>
            <For each={tags()}>
              {(tag) => (
                <span style={{
                  'font-size': '9px', 'font-family': V.mono, 'text-transform': 'uppercase',
                  color: V.tf, 'letter-spacing': '0.04em',
                }}>{tag}</span>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

export function StatsBar(props: BaseComponentProps<{
  stats: Array<{ label: string; value: string; color?: string }>;
  layout?: 'row' | 'grid';
}>) {
  const stats = () => props.props.stats ?? [];
  const isGrid = () => props.props.layout === 'grid';
  return (
    <div style={{
      display: isGrid() ? 'grid' : 'flex',
      ...(isGrid()
        ? { 'grid-template-columns': 'repeat(auto-fit, minmax(80px, 1fr))', gap: '12px' }
        : { gap: '20px', 'flex-wrap': 'wrap' }),
    }}>
      <For each={stats()}>
        {(stat) => (
          <div style={{ 'text-align': isGrid() ? 'center' : 'left' }}>
            <div style={{ 'font-size': '9px', 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.08em', color: V.td }}>
              {stat.label}
            </div>
            <div style={{ 'font-size': '14px', 'font-weight': 'bold', color: stat.color ?? V.cy, 'font-family': V.mono }}>
              {stat.value}
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

export function MetadataHeader(props: BaseComponentProps<{
  title: string;
  subtitle?: string;
  date?: string;
  stats?: Array<{ label: string; value: string }>;
}>) {
  const stats = () => props.props.stats ?? [];
  return (
    <div style={{ 'margin-bottom': '12px' }}>
      <div style={{ 'font-size': '16px', 'font-weight': 'bold', color: V.t, 'font-family': V.serif }}>{props.props.title}</div>
      <Show when={props.props.subtitle}>
        <div style={{ 'font-size': '11px', color: V.td, 'margin-top': '2px' }}>{props.props.subtitle}</div>
      </Show>
      <div style={{ display: 'flex', gap: '12px', 'margin-top': '6px', 'align-items': 'center', 'flex-wrap': 'wrap' }}>
        <Show when={props.props.date}>
          <span style={{ 'font-size': '10px', 'font-family': V.mono, color: V.tf }}>{props.props.date}</span>
        </Show>
        <Show when={stats().length > 0}>
          <span style={{ 'font-size': '10px', 'font-family': V.mono, color: V.td }}>
            {stats().map(s => `${s.label}: ${s.value}`).join(' · ')}
          </span>
        </Show>
      </div>
    </div>
  );
}

export function CollapsibleSection(props: BaseComponentProps<{
  title: string;
  expanded?: boolean;
  color?: string;
  count?: number;
}>) {
  const [expanded, setExpanded] = createSignal(props.props.expanded !== false);
  const color = () => props.props.color ?? V.cy;
  return (
    <div style={{ 'border-left': `2px solid ${expanded() ? color() : V.b}`, 'margin-bottom': '4px', transition: 'border-color 0.2s ease' }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', 'align-items': 'center', gap: '6px', padding: '6px 10px',
          cursor: 'pointer', 'user-select': 'none',
        }}
      >
        <span style={{ 'font-size': '9px', color: color(), transition: 'transform 0.15s ease', transform: expanded() ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        <span style={{ 'font-size': '11px', 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.08em', color: expanded() ? V.t : V.td }}>
          {props.props.title}
        </span>
        <Show when={props.props.count != null}>
          <span style={{ 'font-size': '9px', 'font-family': V.mono, color: V.tf }}>({props.props.count})</span>
        </Show>
      </div>
      <Show when={expanded()}>
        <div style={{ 'padding-left': '22px', 'padding-bottom': '6px' }}>
          {props.children}
        </div>
      </Show>
    </div>
  );
}

export function FilterButtons(props: BaseComponentProps<{
  filters: Array<{ id: string; label: string; count?: number }>;
  // Matches the catalog union: string literal OR a $bindState/$computed ref object.
  // useBoundProp resolves to a string at runtime; the widened type keeps the
  // registry inference happy without forcing DynamicString through the
  // ComponentFn contract (json-render's inferrer flattens unknown unions to
  // an index signature which drops the key entirely).
  active: string | Record<string, unknown>;
}>) {
  const [activeRaw, setActive] = useBoundProp(props.props.active, props.bindings?.active);
  const active = typeof activeRaw === 'function' ? activeRaw as () => unknown : () => activeRaw;
  const filters = () => props.props.filters ?? [];
  return (
    <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
      <For each={filters()}>
        {(filter) => {
          const isActive = () => active() === filter.id;
          return (
            <button
              onClick={(e) => {
                setActive(filter.id);
                const el = e.currentTarget as HTMLElement;
                emitChirp(el, 'press', { id: filter.id });
              }}
              style={{
                padding: '4px 10px', 'border-radius': '3px', border: 'none',
                'font-size': '10px', 'font-family': V.mono, cursor: 'pointer',
                background: isActive() ? 'rgba(255,255,255,0.1)' : 'transparent',
                color: isActive() ? '#e6edf3' : V.tf,
                transition: 'all 0.15s ease',
              }}
            >
              {filter.label}
              <Show when={filter.count != null}>
                <span style={{ opacity: 0.6 }}>{` (${filter.count})`}</span>
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}

export function TabNav(props: BaseComponentProps<{
  tabs: Array<{ id: string; label: string }>;
  active: unknown;
  variant?: 'horizontal' | 'pills';
}>) {
  const [activeRaw, setActive] = useBoundProp(props.props.active, props.bindings?.active);
  // useBoundProp returns raw value OR signal depending on version — normalize to callable
  const active = typeof activeRaw === 'function' ? activeRaw as () => unknown : () => activeRaw;
  const tabs = () => props.props.tabs ?? [];
  const isPills = () => props.props.variant === 'pills';
  return (
    <div style={{
      display: 'flex', gap: '4px', padding: '4px 0',
      'border-bottom': isPills() ? 'none' : `1px solid ${V.b}`,
    }}>
      <For each={tabs()}>
        {(tab) => {
          const isActive = () => active() === tab.id;
          return (
            <button
              onClick={(e) => {
                setActive(tab.id);
                const el = e.currentTarget as HTMLElement;
                emitChirp(el, 'press', { id: tab.id });
              }}
              style={{
                padding: '5px 12px',
                border: `1px solid ${isActive() ? V.cy : V.b}`,
                'border-radius': '4px',
                background: isActive() ? V.cy + '18' : V.s2,
                'font-size': '11px', 'font-family': V.mono, cursor: 'pointer',
                color: isActive() ? V.cy : V.td,
                transition: 'all 0.15s ease',
                'user-select': 'none',
              }}
            >
              {tab.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TREE VIEW
// ═══════════════════════════════════════════════════════════════

interface TreeNode {
  id: string;
  label: string;
  status?: 'done' | 'active' | 'pending' | 'deferred';
  detail?: string;
  children?: TreeNode[];
}

function treeStatusColor(status?: string): string {
  switch (status) {
    case 'done': return V.green;
    case 'active': return V.cy;
    case 'deferred': return V.amb;
    case 'pending': return V.tf;
    default: return V.td;
  }
}

function treeStatusIcon(status?: string, hasChildren?: boolean): string {
  if (hasChildren) return '';
  switch (status) {
    case 'done': return '✓';
    case 'active': return '▸';
    case 'deferred': return '◇';
    case 'pending': return '·';
    default: return '·';
  }
}

function TreeNodeRow(nodeProps: { node: TreeNode; depth: number; isLast: boolean; defaultExpanded: boolean }) {
  const node = nodeProps.node;
  const hasKids = () => (node.children?.length ?? 0) > 0;
  const [expanded, setExpanded] = createSignal(nodeProps.defaultExpanded);
  const color = () => treeStatusColor(node.status);
  const icon = () => treeStatusIcon(node.status, hasKids());
  const children = () => node.children ?? [];

  return (
    <div style={{ 'margin-left': nodeProps.depth > 0 ? '16px' : '0' }}>
      <div
        onClick={() => hasKids() && setExpanded(e => !e)}
        style={{
          display: 'flex',
          'align-items': 'flex-start',
          gap: '6px',
          padding: '5px 0',
          cursor: hasKids() ? 'pointer' : 'default',
          'user-select': 'none',
        }}
      >
        {/* branch glyph */}
        <span style={{
          'font-size': '10px',
          color: V.tf,
          'min-width': '10px',
          'font-family': V.mono,
          'line-height': '18px',
        }}>
          {nodeProps.depth > 0 ? (nodeProps.isLast ? '└' : '├') : ''}
        </span>

        {/* expand/collapse or status icon */}
        <span style={{
          'font-size': hasKids() ? '8px' : '10px',
          color: color(),
          'min-width': '12px',
          'text-align': 'center',
          'line-height': '18px',
          transition: 'transform 0.15s ease',
          transform: hasKids() ? (expanded() ? 'rotate(90deg)' : 'rotate(0deg)') : 'none',
        }}>
          {hasKids() ? '▶' : icon()}
        </span>

        {/* label + detail */}
        <div style={{ flex: '1', 'min-width': '0', 'max-width': '680px' }}>
          {(() => {
            const headingMatch = node.label.match(/^(#{1,6})\s+(.*)$/);
            const isHeading = !!headingMatch;
            const headingLevel = headingMatch ? headingMatch[1].length : 0;
            const labelText = headingMatch ? headingMatch[2] : node.label;
            const isLongProse = !isHeading && node.label.length > 80;
            const hSize: Record<number, string> = { 1: '16px', 2: '14px', 3: '12px', 4: '11px', 5: '10px', 6: '10px' };
            const hColor: Record<number, string> = { 1: V.t, 2: V.t, 3: V.cy, 4: V.td, 5: V.tf, 6: V.tf };
            return (
              <span style={{
                'font-size': isHeading ? (hSize[headingLevel] ?? '11px') : (isLongProse ? '12px' : '11px'),
                'font-family': (isHeading && headingLevel <= 3) || isLongProse ? V.serif : V.mono,
                'font-weight': isHeading ? (headingLevel <= 2 ? 'bold' : '600') : 'normal',
                'letter-spacing': isHeading && headingLevel >= 4 ? '0.06em' : (isHeading && headingLevel <= 2 ? 'normal' : 'normal'),
                color: isHeading ? (hColor[headingLevel] ?? V.t) : (node.status === 'deferred' ? V.amb : node.status === 'pending' ? V.td : V.t),
                'line-height': isLongProse ? '1.8' : '1.5',
                'word-break': 'break-word',
                display: 'inline',
              }}
                innerHTML={sanitize(inlineFormat(labelText))}
                onClick={handleWikilinkClick}
              />
            );
          })()}
          <Show when={node.detail}>
            <span style={{
              'font-size': '10px',
              'font-family': V.mono,
              color: V.tf,
              'margin-left': '8px',
            }}>
              {node.detail}
            </span>
          </Show>
        </div>

        {/* status badge */}
        <Show when={node.status}>
          <span style={{
            'font-size': '8px',
            'font-family': V.mono,
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
            color: color(),
            'background': `${color()}18`,
            padding: '1px 5px',
            'border-radius': '3px',
            'white-space': 'nowrap',
            'line-height': '16px',
          }}>
            {node.status}
          </span>
        </Show>
      </div>

      {/* children */}
      <Show when={hasKids() && expanded()}>
        <div style={{
          'border-left': `1px solid ${color()}30`,
          'margin-left': '15px',
        }}>
          <For each={children()}>
            {(child, i) => (
              <TreeNodeRow
                node={child}
                depth={nodeProps.depth + 1}
                isLast={i() === children().length - 1}
                defaultExpanded={nodeProps.defaultExpanded}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function TreeView(props: BaseComponentProps<{
  title?: string;
  nodes: TreeNode[];
  defaultExpanded?: boolean;
  connectsTo?: string[];
}>) {
  const nodes = () => props.props.nodes ?? [];
  const connectsTo = () => props.props.connectsTo ?? [];
  const defaultExpanded = () => props.props.defaultExpanded !== false;

  return (
    <div style={{ padding: '0' }}>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '11px',
          color: V.td,
          'margin-bottom': '8px',
          'font-family': V.mono,
          'text-transform': 'uppercase',
          'letter-spacing': '0.1em',
        }}>
          {props.props.title}
        </div>
      </Show>

      <For each={nodes()}>
        {(node, i) => (
          <TreeNodeRow
            node={node}
            depth={0}
            isLast={i() === nodes().length - 1}
            defaultExpanded={defaultExpanded()}
          />
        )}
      </For>

      <Show when={connectsTo().length > 0}>
        <div onClick={handleWikilinkClick} style={{
          'margin-top': '10px',
          'padding-top': '8px',
          'border-top': `1px solid ${V.b}`,
          display: 'flex',
          gap: '6px',
          'flex-wrap': 'wrap',
          'align-items': 'center',
        }}>
          <span style={{ 'font-size': '9px', color: V.tf, 'font-family': V.mono }}>→</span>
          <For each={connectsTo()}>
            {(link) => (
              <span
                class="bbs-wikilink"
                data-wikilink={link}
                style={{
                  'font-size': '10px',
                  'font-family': V.mono,
                  color: V.cy,
                  cursor: 'pointer',
                  padding: '1px 4px',
                  'border-radius': '3px',
                  background: 'rgba(0,229,255,0.08)',
                }}
              >
                [[{link}]]
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPLORER PORTS — LinkGraph, ActivityHeatmap, ProvenanceChain,
//                  RiskMatrix, TimelineDiff
// ═══════════════════════════════════════════════════════════════

export function LinkGraph(props: BaseComponentProps<{
  nodes: Array<{ id: string; label: string; color?: string; weight?: number; center?: boolean; ring?: number; type?: string }>;
  edges: Array<[string, string]>;
  title?: string;
}>) {
  const nodes = () => props.props.nodes ?? [];
  const edges = () => props.props.edges ?? [];
  const w = 420, h = 260;

  const positioned = createMemo(() => {
    const pos: Record<string, { x: number; y: number; color: string; label: string; weight?: number; type?: string; center?: boolean }> = {};
    const all = nodes();
    const centerNode = all.find(n => n.center);
    const others = all.filter(n => !n.center);
    if (centerNode) pos[centerNode.id] = { ...centerNode, x: w / 2, y: h / 2, color: centerNode.color ?? V.cy };
    others.forEach((n, i) => {
      const angle = (i / others.length) * Math.PI * 2 - Math.PI / 2;
      const r = 90 + (n.ring || 1) * 30;
      pos[n.id] = { ...n, x: w / 2 + Math.cos(angle) * r, y: h / 2 + Math.sin(angle) * r, color: n.color ?? V.td };
    });
    return pos;
  });

  return (
    <div style={{ padding: '0' }}>
      <Show when={props.props.title}>
        <div style={{ 'font-size': '11px', color: V.td, 'margin-bottom': '8px', 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.1em' }}>
          {props.props.title}
        </div>
      </Show>
      <div style={{ border: `1px solid ${V.b}`, 'border-radius': '4px', overflow: 'hidden' }}>
        <svg width={w} height={h} style={{ display: 'block' }}>
          <For each={edges()}>
            {(edge) => {
              const pos = positioned();
              const a = pos[edge[0]], b = pos[edge[1]];
              if (!a || !b) return null;
              return (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={V.b} stroke-width="0.5"
                  stroke-dasharray={a.type === 'stub' || b.type === 'stub' ? '3,3' : 'none'}
                />
              );
            }}
          </For>
          <For each={Object.values(positioned())}>
            {(n) => {
              const r = n.center ? 18 : n.type === 'stub' ? 5 : 8 + Math.min(n.weight || 0, 6);
              return (
                <g>
                  <circle cx={n.x} cy={n.y} r={r}
                    fill={n.color + '30'} stroke={n.color}
                    stroke-width={n.center ? 2 : 1}
                  />
                  {(n.center || r > 8) && (
                    <text x={n.x} y={n.y + r + 12} text-anchor="middle"
                      fill={V.td} font-size="8" font-family={V.mono}
                    >{n.label.length > 18 ? n.label.slice(0, 16) + '\u2026' : n.label}</text>
                  )}
                  {(n.weight ?? 0) > 3 && !n.center && (
                    <text x={n.x} y={n.y + 3} text-anchor="middle"
                      fill={V.bg} font-size="7" font-family={V.mono} font-weight="bold"
                    >{n.weight}</text>
                  )}
                </g>
              );
            }}
          </For>
        </svg>
      </div>
    </div>
  );
}

export function ActivityHeatmap(props: BaseComponentProps<{
  data: Array<{ label: string; value: number }>;
  color?: string;
  title?: string;
}>) {
  const data = () => props.props.data ?? [];
  const c = () => props.props.color ?? V.cy;
  const maxVal = createMemo(() => Math.max(...data().map(d => d.value), 1));

  return (
    <div style={{ padding: '0' }}>
      <Show when={props.props.title}>
        <div style={{ 'font-size': '11px', color: V.td, 'margin-bottom': '8px', 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.1em' }}>
          {props.props.title}
        </div>
      </Show>
      <div style={{ border: `1px solid ${V.b}`, 'border-radius': '4px', padding: '8px' }}>
        <div style={{ display: 'flex', gap: '2px', 'flex-wrap': 'wrap', padding: '4px' }}>
          <For each={data()}>
            {(d) => {
              const intensity = d.value / maxVal();
              const bg = intensity === 0 ? V.s2
                : intensity < 0.25 ? c() + '15'
                : intensity < 0.5 ? c() + '30'
                : intensity < 0.75 ? c() + '50'
                : c() + '80';
              return (
                <div title={`${d.label}: ${d.value}`} style={{
                  width: '14px', height: '14px', 'border-radius': '2px', 'background-color': bg,
                  border: `1px solid ${intensity > 0.5 ? c() + '30' : V.b}`,
                }} />
              );
            }}
          </For>
        </div>
        {/* gap + min-width: 0 + overflow ellipsis on spans prevents long
            first/last labels from butting against the peak text. Mirrors
            outline-explorer's gap-2 + truncate min-w-0 fix from v0.13.0. */}
        <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px', padding: '0 4px', 'margin-top': '2px' }}>
          <span style={{ color: V.tf, 'font-size': '8px', 'font-family': V.mono, 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{data()[0]?.label}</span>
          <span style={{ color: V.tf, 'font-size': '8px', 'font-family': V.mono, 'flex-shrink': '0' }}>peak: {maxVal()}</span>
          <span style={{ color: V.tf, 'font-size': '8px', 'font-family': V.mono, 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{data()[data().length - 1]?.label}</span>
        </div>
      </div>
    </div>
  );
}

export function ProvenanceChain(props: BaseComponentProps<{
  steps: Array<{ source: string; content: string; docId?: string; confidence?: number; lines?: string }>;
  title?: string;
}>) {
  const steps = () => props.props.steps ?? [];
  const sourceColors: Record<string, string> = {
    qmd: V.cy, conversation: V.mag, bbs: '#b388ff',
    outline: V.green, loki: V.amb, autorag: V.cy,
  };

  return (
    <div style={{ padding: '0' }}>
      <Show when={props.props.title}>
        <div style={{ 'font-size': '11px', color: V.td, 'margin-bottom': '8px', 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.1em' }}>
          {props.props.title}
        </div>
      </Show>
      <div style={{ border: `1px solid ${V.b}`, 'border-radius': '4px', padding: '10px' }}>
        <For each={steps()}>
          {(step, i) => {
            const sc = sourceColors[step.source] ?? V.td;
            const isLast = () => i() === steps().length - 1;
            return (
              <div style={{ display: 'flex', gap: '10px', 'margin-bottom': isLast() ? '0' : '4px' }}>
                <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': 'center', 'flex-shrink': '0', width: '16px' }}>
                  <div style={{ 'flex-shrink': '0', 'margin-top': '4px', 'border-radius': '50%', width: '10px', height: '10px', 'background-color': sc + '30', border: `2px solid ${sc}` }} />
                  <Show when={!isLast()}>
                    <div style={{ flex: '1', 'margin-top': '2px', width: '2px', 'background-color': V.b }} />
                  </Show>
                </div>
                <div style={{ flex: '1', 'padding-bottom': isLast() ? '0' : '8px' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'margin-bottom': '2px' }}>
                    <span style={{ 'font-size': '8px', 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.05em', padding: '1px 6px', 'border-radius': '3px', color: sc, 'background-color': sc + '12' }}>
                      {step.source}
                    </span>
                    <Show when={step.docId}>
                      <span style={{ color: V.tf, 'font-size': '9px', 'font-family': V.mono }}>#{step.docId}</span>
                    </Show>
                    <Show when={Number.isFinite(step.confidence)}>
                      {(() => {
                        // Schema documents 0–1 fractions (renderer multiplies
                        // by 100). Auto-detect agents that emit 0–100 ints by
                        // mistake — if the value is > 1 (and at most 100, the
                        // only sensible upper bound), treat it as already-percent.
                        // Mirrors outline-explorer's visualizations.tsx fix.
                        // Number.isFinite gate also rejects NaN (which slipped
                        // past the prior `!= null` check — NaN != null is true).
                        const raw = step.confidence!;
                        const pct = raw > 1 && raw <= 100 ? raw : raw * 100;
                        return (
                          <span style={{ 'font-size': '9px', 'font-family': V.mono, 'margin-left': 'auto', color: pct > 80 ? V.green : pct > 50 ? V.amb : V.cor }}>
                            {Math.round(pct)}%
                          </span>
                        );
                      })()}
                    </Show>
                  </div>
                  <div style={{ color: V.t, 'font-size': '11px', 'font-family': V.mono, 'line-height': '1.4' }}>{step.content}</div>
                  <Show when={step.lines}>
                    <span style={{ color: V.tf, 'font-size': '9px', 'font-family': V.mono }}>lines {step.lines}</span>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

export function RiskMatrix(props: BaseComponentProps<{
  items: Array<{ label: string; severity: string; impact: string }>;
  title?: string;
}>) {
  const items = () => props.props.items ?? [];
  const rows = ['high', 'medium', 'low'];
  const cols = ['structural', 'content', 'cosmetic'];
  const colColors: Record<string, string> = { structural: V.cor, content: V.amb, cosmetic: V.td };

  return (
    <div style={{ padding: '0' }}>
      <Show when={props.props.title}>
        <div style={{ 'font-size': '11px', color: V.td, 'margin-bottom': '8px', 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.1em' }}>
          {props.props.title}
        </div>
      </Show>
      <div style={{ border: `1px solid ${V.b}`, 'border-radius': '4px', overflow: 'hidden' }}>
        {/* header */}
        <div style={{ display: 'grid', 'grid-template-columns': '60px 1fr 1fr 1fr', 'border-bottom': `1px solid ${V.b}` }}>
          <div style={{ padding: '6px' }} />
          <For each={cols}>
            {(col) => (
              <div style={{ padding: '6px', 'text-align': 'center', 'font-size': '9px', 'font-family': V.mono, 'text-transform': 'uppercase', color: colColors[col], 'border-left': `1px solid ${V.b}` }}>
                {col}
              </div>
            )}
          </For>
        </div>
        {/* rows */}
        <For each={rows}>
          {(row) => (
            <div style={{ display: 'grid', 'grid-template-columns': '60px 1fr 1fr 1fr', 'border-bottom': `1px solid ${V.b}20` }}>
              <div style={{ padding: '6px', 'font-size': '9px', 'font-family': V.mono, 'text-transform': 'uppercase', color: row === 'high' ? V.cor : row === 'medium' ? V.amb : V.td }}>
                {row}
              </div>
              <For each={cols}>
                {(col) => {
                  const cellItems = () => items().filter(it => it.severity === row && it.impact === col);
                  const cc = colColors[col];
                  return (
                    <div style={{ padding: '4px', display: 'flex', 'flex-direction': 'column', gap: '2px', 'border-left': `1px solid ${V.b}`, 'min-height': '40px' }}>
                      <For each={cellItems()}>
                        {(item) => (
                          <div style={{ padding: '2px 6px', 'border-radius': '3px', 'font-size': '9px', 'font-family': V.mono, color: V.t, 'line-height': '1.4', 'background-color': cc + '10', 'border-left': `2px solid ${cc}40` }}>
                            {item.label}
                          </div>
                        )}
                      </For>
                    </div>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

export function TimelineDiff(props: BaseComponentProps<{
  before: { date: string; items: Array<{ text: string; removed?: boolean }> };
  after: { date: string; items: Array<{ text: string; added?: boolean }> };
  title?: string;
}>) {
  const before = () => props.props.before ?? { date: '', items: [] };
  const after = () => props.props.after ?? { date: '', items: [] };

  return (
    <div style={{ padding: '0' }}>
      <Show when={props.props.title}>
        <div style={{ 'font-size': '11px', color: V.td, 'margin-bottom': '8px', 'font-family': V.mono, 'text-transform': 'uppercase', 'letter-spacing': '0.1em' }}>
          {props.props.title}
        </div>
      </Show>
      <div style={{ display: 'grid', 'grid-template-columns': '1fr 20px 1fr', border: `1px solid ${V.b}`, 'border-radius': '4px', overflow: 'hidden' }}>
        {/* headers */}
        <div style={{ padding: '6px', 'border-bottom': `1px solid ${V.b}`, 'background-color': V.cor + '08' }}>
          <span style={{ 'font-size': '9px', 'font-family': V.mono, 'text-transform': 'uppercase', color: V.cor }}>before</span>
          <span style={{ color: V.tf, 'font-size': '9px', 'font-family': V.mono, 'margin-left': '6px' }}>{before().date}</span>
        </div>
        <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'border-bottom': `1px solid ${V.b}` }}>
          <span style={{ color: V.tf, 'font-size': '10px' }}>→</span>
        </div>
        <div style={{ padding: '6px', 'border-bottom': `1px solid ${V.b}`, 'background-color': V.green + '08' }}>
          <span style={{ 'font-size': '9px', 'font-family': V.mono, 'text-transform': 'uppercase', color: V.green }}>after</span>
          <span style={{ color: V.tf, 'font-size': '9px', 'font-family': V.mono, 'margin-left': '6px' }}>{after().date}</span>
        </div>
        {/* items */}
        <div style={{ padding: '6px' }}>
          <For each={before().items}>
            {(item) => (
              <div style={{ padding: '2px 6px', 'font-size': '10px', 'font-family': V.mono, 'margin-bottom': '2px', color: V.td, 'background-color': item.removed ? V.cor + '10' : 'transparent', 'text-decoration': item.removed ? 'line-through' : 'none', 'border-left': item.removed ? `2px solid ${V.cor}40` : '2px solid transparent' }}>
                {item.text}
              </div>
            )}
          </For>
        </div>
        <div />
        <div style={{ padding: '6px' }}>
          <For each={after().items}>
            {(item) => (
              <div style={{ padding: '2px 6px', 'font-size': '10px', 'font-family': V.mono, 'margin-bottom': '2px', color: item.added ? V.green : V.td, 'background-color': item.added ? V.green + '08' : 'transparent', 'border-left': item.added ? `2px solid ${V.green}40` : '2px solid transparent' }}>
                {item.text}
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// LAYOUT SECTIONS
// ═══════════════════════════════════════════════════════════════

export function Section(props: BaseComponentProps<{
  title?: string;
  variant?: 'default' | 'highlight' | 'warning';
}>) {
  const variantColor = () => {
    switch (props.props.variant) {
      case 'highlight': return V.cy;
      case 'warning': return V.amb;
      default: return V.td;
    }
  };
  return (
    <div style={{ padding: '0' }}>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '10px',
          'font-family': V.mono,
          'text-transform': 'uppercase',
          'letter-spacing': '0.12em',
          color: variantColor(),
          'padding-bottom': '6px',
          'border-bottom': `1px solid ${variantColor()}30`,
          'margin-bottom': '10px',
        }}>
          {props.props.title}
        </div>
      </Show>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        {props.children}
      </div>
    </div>
  );
}

export function TimelineEvent(props: BaseComponentProps<{
  time: string;
  label: string;
  color?: string;
}>) {
  const dotColor = () => props.props.color ?? V.cy;
  return (
    <div style={{ display: 'flex', gap: '10px', 'align-items': 'flex-start', padding: '2px 0' }}>
      <div style={{
        'min-width': '58px',
        'font-family': V.mono,
        'font-size': '9px',
        color: V.td,
        'padding-top': '3px',
        'text-align': 'right',
        'flex-shrink': 0,
      }}>
        {props.props.time}
      </div>
      <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': 'center', 'flex-shrink': 0 }}>
        <div style={{
          width: '6px',
          height: '6px',
          'border-radius': '50%',
          background: dotColor(),
          'margin-top': '3px',
          'box-shadow': `0 0 4px ${dotColor()}80`,
        }} />
        <div style={{ width: '1px', 'min-height': '8px', background: dotColor() + '25', flex: 1 }} />
      </div>
      <div style={{
        'font-size': '11px',
        color: V.t,
        'font-family': V.mono,
        flex: 1,
        'padding-top': '1px',
        'line-height': '1.4',
      }}>
        {props.props.label}
      </div>
    </div>
  );
}

export function StatPill(props: BaseComponentProps<{
  label: string;
  value: string;
  color?: string;
}>) {
  const col = () => props.props.color ?? V.cy;
  return (
    <div style={{
      display: 'inline-flex',
      'align-items': 'center',
      background: V.s1,
      border: `1px solid ${col()}40`,
      'border-radius': '12px',
      overflow: 'hidden',
    }}>
      <span style={{
        'font-size': '9px',
        'font-family': V.mono,
        'text-transform': 'uppercase',
        'letter-spacing': '0.08em',
        color: V.td,
        padding: '3px 8px',
        background: V.s2,
      }}>
        {props.props.label}
      </span>
      <span style={{
        'font-size': '11px',
        'font-weight': '700',
        color: col(),
        'font-family': V.mono,
        padding: '3px 10px',
      }}>
        {props.props.value}
      </span>
    </div>
  );
}

export function GapItem(props: BaseComponentProps<{
  description: string;
  severity?: 'critical' | 'warning' | 'info';
  gapType?: string;
  target?: string;
}>) {
  const severityColor = () => {
    switch (props.props.severity) {
      case 'critical': return V.cor;
      case 'warning': return V.amb;
      default: return V.cy;
    }
  };
  const icon = () => {
    switch (props.props.severity) {
      case 'critical': return '⏺';
      case 'warning': return '◆';
      default: return '◇';
    }
  };
  return (
    <div style={{
      display: 'flex',
      gap: '8px',
      'align-items': 'flex-start',
      padding: '5px 8px',
      'border-left': `2px solid ${severityColor()}`,
      background: severityColor() + '0a',
    }}>
      <span style={{ color: severityColor(), 'font-size': '10px', 'flex-shrink': 0, 'padding-top': '2px' }}>{icon()}</span>
      <div style={{ flex: 1 }}>
        <div style={{ 'font-size': '11px', color: V.t, 'font-family': V.mono, 'line-height': '1.4' }}>
          {props.props.description}
        </div>
        <Show when={props.props.target}>
          <div style={{ 'font-size': '9px', color: V.tf, 'font-family': V.mono, 'margin-top': '2px', 'text-transform': 'uppercase', 'letter-spacing': '0.06em' }}>
            → {props.props.target}
          </div>
        </Show>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// KANBAN (FLO-587) — spec-verb-aligned refactor per
// .claude/skills/floatty-interactive-view/SKILL.md
// ═══════════════════════════════════════════════════════════════

const KANBAN_LOG = '[kanban]';

/**
 * KanbanCard — card projection of a block inside a kanban column.
 *
 * Verbs emitted (as chirps that host routes through chirpWriteHandler):
 *   - `move-block` on drop — { blockId, targetParentId, targetIndex }
 *   - `update-block` on edit commit — { blockId, content }
 *     (path: useBoundProp.setter → StateProvider.onStateChange →
 *      handleRenderStateChange in render.tsx → chirp)
 *
 * Drag uses pointer events per useBlockDrag.ts:377-420 (the working
 * outline drag — pointer events are the safe default in Tauri's webview,
 * verified in-repo, NOT assumed from docs per FM-4).
 * - setPointerCapture on pointerdown
 * - preventDefault on pointerdown AND pointermove (kills text-selection)
 * - document.body.classList.add('kanban-dragging') while active (CSS
 *   user-select: none scoped to the class, not ambient)
 *
 * Edit uses a native `<input>`, NOT a contentEditable div — per
 * TableView's cell editor at BlockDisplay.tsx:702. Nested
 * contenteditable is unreliable in WKWebView (FM-5 history — 5b
 * wrapped the door in contenteditable=false to defend against an
 * inherited CE that title mode already hides; non-problem). The input
 * is unaffected by any surrounding CE state.
 */
export function KanbanCard(
  props: BaseComponentProps<{
    content?: string;
    color?: string;
    blockId?: string;
    parentId?: string | null;
    index?: number;
  }>,
) {
  // KanbanCard is read-only at the renderer layer — content edits flow back
  // through chirp events handled by the parent block, not via useBoundProp's
  // setter. Setter intentionally discarded.
  const [valueRaw, _setValue] = useBoundProp(props.props.content, props.bindings?.content);
  const localValue = typeof valueRaw === 'function' ? (valueRaw as () => unknown) : () => valueRaw;
  const [editing, setEditing] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  let ref: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  // preventDefault on pointerup doesn't cancel the follow-up click (MDN).
  // Flag the click-after-drag so we don't enter edit mode on drop.
  let justDragged = false;

  const DRAG_THRESHOLD_PX = 5;

  // --- DRAG: pointer events (mirrors useBlockDrag.ts) ----------------

  const onPointerDown = (e: PointerEvent) => {
    if (editing()) return;
    if (e.button !== 0) return;
    if (!props.props.blockId || !ref) return;
    // Kill the browser's native text-selection that would otherwise
    // win on mousedown over text content.
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const sourceId = props.props.blockId;
    const captureTarget = ref;
    const capturePointerId = e.pointerId;
    try { captureTarget.setPointerCapture(capturePointerId); } catch { /* detached */ }
    console.log(KANBAN_LOG, 'pointerdown', { sourceId, startX, startY });

    let started = false;
    // Drop target types: card-relative (above/below specific card) OR column
    // (append to end of column, empty-space drop).
    let dropCard: HTMLElement | null = null;
    let dropPos: 'above' | 'below' | null = null;
    let dropCol: HTMLElement | null = null;

    const clearHighlights = () => {
      const root = ref?.closest('[data-section-id="kanban-board"]') ?? ref?.closest('.kanban-board') ?? document.body;
      for (const el of root.querySelectorAll<HTMLElement>('[data-kanban-card-id]')) {
        el.style.removeProperty('box-shadow');
      }
      for (const el of root.querySelectorAll<HTMLElement>('[data-kanban-column-id]')) {
        el.style.removeProperty('outline');
        el.style.removeProperty('outline-offset');
      }
    };

    const setCardHighlight = (card: HTMLElement, pos: 'above' | 'below') => {
      clearHighlights();
      card.style.boxShadow = pos === 'above'
        ? `inset 0 2px 0 0 ${V.cy}`
        : `inset 0 -2px 0 0 ${V.cy}`;
    };

    const setColHighlight = (col: HTMLElement) => {
      clearHighlights();
      col.style.outline = `2px dashed ${V.cy}`;
      col.style.outlineOffset = '-2px';
    };

    const onMove = (ev: PointerEvent) => {
      ev.preventDefault();
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        started = true;
        document.body.classList.add('kanban-dragging');
        // Fade source so user sees which card is being dragged.
        ref!.style.opacity = '0.4';
        console.log(KANBAN_LOG, 'drag started');
      }
      // Temporarily disable pointer-events on the source to find target under cursor.
      const prevPE = ref!.style.pointerEvents;
      ref!.style.pointerEvents = 'none';
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      ref!.style.pointerEvents = prevPE;

      const card = under?.closest<HTMLElement>('[data-kanban-card-id]');
      if (card && card !== ref) {
        const rect = card.getBoundingClientRect();
        const pos = ev.clientY > rect.top + rect.height / 2 ? 'below' : 'above';
        if (card !== dropCard || pos !== dropPos) {
          dropCard = card;
          dropPos = pos;
          dropCol = null;
          setCardHighlight(card, pos);
        }
        return;
      }

      // No card under cursor — check for column (empty-space drop).
      const col = under?.closest<HTMLElement>('[data-kanban-column-id]');
      if (col) {
        if (col !== dropCol) {
          dropCol = col;
          dropCard = null;
          dropPos = null;
          setColHighlight(col);
        }
        return;
      }

      // Nothing valid under cursor.
      dropCard = null;
      dropPos = null;
      dropCol = null;
      clearHighlights();
    };

    const cleanup = () => {
      document.body.classList.remove('kanban-dragging');
      if (ref) ref.style.removeProperty('opacity');
      clearHighlights();
      try {
        if (captureTarget.hasPointerCapture?.(capturePointerId)) {
          captureTarget.releasePointerCapture(capturePointerId);
        }
      } catch { /* detached */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };

    const onUp = (ev: PointerEvent) => {
      cleanup();
      if (!started) {
        console.log(KANBAN_LOG, 'pointerup below threshold — click path');
        return;
      }
      justDragged = true;
      // Reset on a later task so the synthetic `click` event that
      // follows `pointerup` still sees `justDragged=true` and bails.
      // queueMicrotask runs BEFORE the click is dispatched, which
      // would re-enter edit mode after a drop.
      setTimeout(() => { justDragged = false; }, 0);

      // Card-relative drop (insert above/below a specific card)
      if (dropCard && dropPos) {
        const targetId = dropCard.getAttribute('data-kanban-card-id');
        if (!targetId || targetId === sourceId) {
          console.log(KANBAN_LOG, 'drop: same card');
          return;
        }
        const targetCol = dropCard.closest<HTMLElement>('[data-kanban-column-id]');
        const targetParentId = targetCol?.getAttribute('data-kanban-column-id') ?? null;
        // Exclude source card from sibling list — its old position shouldn't
        // affect the insert index in the target column.
        const siblings = targetCol
          ? Array.from(targetCol.querySelectorAll<HTMLElement>('[data-kanban-card-id]'))
              .filter(el => el !== ref)
          : [];
        const baseIdx = siblings.indexOf(dropCard);
        const targetIndex = dropPos === 'below' ? baseIdx + 1 : baseIdx;
        console.log(KANBAN_LOG, 'emit move-block (card)', { sourceId, targetParentId, targetIndex });
        if (ref) {
          emitChirp(ref, 'move-block', { blockId: sourceId, targetParentId, targetIndex });
        }
        ev.preventDefault();
        return;
      }

      // Column empty-space drop (append to end of column)
      if (dropCol) {
        const targetParentId = dropCol.getAttribute('data-kanban-column-id');
        if (!targetParentId) {
          console.log(KANBAN_LOG, 'drop: column missing id');
          return;
        }
        const siblings = Array.from(dropCol.querySelectorAll<HTMLElement>('[data-kanban-card-id]'))
          .filter(el => el !== ref);
        const targetIndex = siblings.length;
        console.log(KANBAN_LOG, 'emit move-block (column)', { sourceId, targetParentId, targetIndex });
        if (ref) {
          emitChirp(ref, 'move-block', { blockId: sourceId, targetParentId, targetIndex });
        }
        ev.preventDefault();
        return;
      }

      console.log(KANBAN_LOG, 'drop: no target');
    };

    const onCancel = () => {
      console.log(KANBAN_LOG, 'pointercancel');
      cleanup();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  // --- CLICK → EDIT ---------------------------------------------------

  const enterEdit = () => {
    // Edit no longer requires bindings — we emit update-block chirp
    // directly in commit(). Only guard on blockId presence.
    if (!props.props.blockId) return;
    console.log(KANBAN_LOG, 'enterEdit', { blockId: props.props.blockId });
    setEditing(true);
    queueMicrotask(() => {
      if (!inputRef) return;
      inputRef.focus();
      const len = inputRef.value.length;
      try { inputRef.setSelectionRange(len, len); } catch { /* not text */ }
    });
  };

  const onClick = (e: MouseEvent) => {
    console.log(KANBAN_LOG, 'click', { blockId: props.props.blockId, editing: editing(), justDragged });
    if (editing() || justDragged) return;
    e.stopPropagation();
    enterEdit();
  };

  // Commit/cancel both exit edit mode, then try to refocus the card.
  // After commit, refresh() regenerates the spec → json-render
  // reconciles → the original `ref` may be detached. Look up the new
  // card DOM by data-kanban-card-id and retry across a few rAFs so we
  // land after the re-projection settles.
  const refocusCard = () => {
    const id = props.props.blockId;
    if (!id) { ref?.focus(); return; }
    let attempts = 0;
    const tryFocus = () => {
      const el = document.querySelector<HTMLElement>(`[data-kanban-card-id="${id}"]`);
      if (el) { el.focus(); return; }
      if (attempts++ < 8) requestAnimationFrame(tryFocus);
    };
    queueMicrotask(tryFocus);
  };

  const commit = () => {
    if (!inputRef) return;
    const next = inputRef.value;
    const prev = String(localValue() ?? '');
    // Emit update-block chirp directly rather than routing through
    // useBoundProp → StateProvider → onStateChange. The StateProvider
    // bridge has two internal gates (value-change + snapshot-identity)
    // that can silently suppress the callback; direct chirp is both
    // simpler and architecturally correct for floatty, where the outline
    // (not spec state) is source of truth. Reactive re-projection via
    // subscribeBlockChanges handles the display round-trip.
    if (next !== prev && props.props.blockId && ref) {
      console.log(KANBAN_LOG, 'emit update-block', { blockId: props.props.blockId });
      emitChirp(ref, 'update-block', { blockId: props.props.blockId, content: next });
    }
    setEditing(false);
    refocusCard();
  };

  const cancel = () => {
    setEditing(false);
    refocusCard();
  };

  const onInputKeyDown = (e: KeyboardEvent) => {
    // stopPropagation so outer card / block handlers don't catch Enter/Escape.
    // Mirrors TableView handleInputKeyDown at BlockDisplay.tsx:570-578.
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  // --- KEYBOARD NAV BETWEEN CARDS ------------------------------------

  const findNeighbor = (dir: 'up' | 'down' | 'left' | 'right'): HTMLElement | null => {
    if (!ref) return null;
    if (dir === 'up' || dir === 'down') {
      const col = ref.closest('[data-kanban-column-id]');
      if (!col) return null;
      const siblings = Array.from(col.querySelectorAll<HTMLElement>('[data-kanban-card-id]'));
      const idx = siblings.indexOf(ref);
      if (idx < 0) return null;
      return dir === 'down' ? (siblings[idx + 1] ?? null) : (siblings[idx - 1] ?? null);
    }
    // Scope to THIS kanban's DOM root (data-section-id="kanban-board"
    // set by kanbanSpec in render.tsx). Without the scope, left/right
    // nav from board A's last column would leak into board B's columns
    // when two kanbans share a split pane.
    const board = ref.closest('[data-section-id="kanban-board"]') ?? ref.closest('.kanban-board') ?? ref.closest('[contenteditable]')?.parentElement ?? document.body;
    const cols = Array.from(board.querySelectorAll<HTMLElement>('[data-kanban-column-id]'));
    const currentCol = ref.closest<HTMLElement>('[data-kanban-column-id]');
    if (!currentCol) return null;
    const colIdx = cols.indexOf(currentCol);
    const targetCol = cols[dir === 'right' ? colIdx + 1 : colIdx - 1];
    if (!targetCol) return null;
    const targetCards = Array.from(targetCol.querySelectorAll<HTMLElement>('[data-kanban-card-id]'));
    if (targetCards.length === 0) return null;
    const currentCards = Array.from(currentCol.querySelectorAll<HTMLElement>('[data-kanban-card-id]'));
    const row = currentCards.indexOf(ref);
    return targetCards[Math.min(row, targetCards.length - 1)] ?? targetCards[0];
  };

  const onCardKeyDown = (e: KeyboardEvent) => {
    if (editing()) return;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        enterEdit();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        const dir = e.key === 'ArrowDown' ? 'down' : 'up';
        const n = findNeighbor(dir);
        if (n) {
          e.preventDefault();
          e.stopPropagation();
          n.focus();
        } else if (ref && props.props.blockId) {
          // Boundary: emit focus-sibling verb. Host's BlockOutputView
          // dispatches to findPrev/NextVisibleBlock + onFocus.
          e.preventDefault();
          e.stopPropagation();
          console.log(KANBAN_LOG, 'emit focus-sibling', { direction: dir });
          emitChirp(ref, 'focus-sibling', { direction: dir, fromBlockId: props.props.blockId });
        }
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowRight' ? 'right' : 'left';
        const n = findNeighbor(dir);
        if (n) {
          e.preventDefault();
          e.stopPropagation();
          n.focus();
        } else if (ref && props.props.blockId) {
          e.preventDefault();
          e.stopPropagation();
          console.log(KANBAN_LOG, 'emit focus-sibling', { direction: dir });
          emitChirp(ref, 'focus-sibling', { direction: dir, fromBlockId: props.props.blockId });
        }
        return;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        ref?.blur();
        return;
    }
  };

  const outlineRing = () => {
    if (editing()) return `1px solid ${V.cy}`;
    if (focused()) return `2px solid ${V.cy}`;
    return '1px solid transparent';
  };

  return (
    <div
      ref={(el) => (ref = el)}
      tabindex={0}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onKeyDown={onCardKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      data-kanban-card-id={props.props.blockId}
      style={{
        background: V.s1,
        color: props.props.color ?? V.t,
        'font-family': V.mono,
        'font-size': '13px',
        border: '1px solid ' + V.b2,
        'border-radius': '4px',
        padding: '6px 8px',
        cursor: editing() ? 'text' : 'grab',
        outline: outlineRing(),
        'outline-offset': '1px',
      }}
    >
      <Show
        when={editing()}
        fallback={<>{String(localValue() ?? '')}</>}
      >
        <input
          ref={(el) => (inputRef = el)}
          type="text"
          value={String(localValue() ?? '')}
          onKeyDown={onInputKeyDown}
          onBlur={commit}
          style={{
            width: '100%',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            padding: '0',
            margin: '0',
            color: 'inherit',
            font: 'inherit',
          }}
        />
      </Show>
    </div>
  );
}

/**
 * KanbanColumn — column container. Pure presentation.
 * Carries `data-kanban-column-id` so KanbanCard's pointer-drag can resolve
 * the drop target's parent. No drop handler — card-level drag owns the
 * entire drop resolution via elementFromPoint.
 */
export function KanbanColumn(
  props: BaseComponentProps<{
    title?: string;
    titleColor?: string;
    blockId?: string;
    childCount?: number;
  }>,
) {
  return (
    <div
      data-kanban-column-id={props.props.blockId}
      style={{
        border: `1px solid ${V.b}`,
        'border-radius': '6px',
        'background-color': 'transparent',
        'min-width': '200px',
        padding: '8px',
      }}
    >
      <div style={{
        'font-family': V.mono,
        'font-size': '11px',
        color: props.props.titleColor ?? V.td,
        'text-transform': 'uppercase',
        'letter-spacing': '0.08em',
        'margin-bottom': '8px',
      }}>
        {props.props.title}
      </div>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        {props.children}
      </div>
    </div>
  );
}

// ─── KANBAN SHIMS (installed at door init) ───────────────────────────
// Non-negotiable for Tier 1 (door-bundle-only, pre-rebuild):
// - body.kanban-dragging CSS so text-selection doesn't fight pointer drag
// - capture-phase ArrowDown interceptor so the render-title descends into
//   the first card instead of jumping past the board
//
// These are both invariant CSS/event concerns unrelated to business
// logic, and belong at the door boundary. Both guarded against HMR
// re-install.

function installKanbanStyles() {
  if (typeof document === 'undefined') return;
  // Always refresh — door HMR should pick up any style changes.
  document.querySelector('[data-kanban-styles]')?.remove();
  const s = document.createElement('style');
  s.setAttribute('data-kanban-styles', '');
  s.textContent = `
    body.kanban-dragging {
      user-select: none !important;
      -webkit-user-select: none !important;
      cursor: grabbing !important;
    }
    body.kanban-dragging * {
      cursor: grabbing !important;
      user-select: none !important;
      -webkit-user-select: none !important;
    }
  `;
  document.head.appendChild(s);
  console.log(KANBAN_LOG, 'styles injected');
}

function installKanbanNavShim() {
  if (typeof document === 'undefined') return;
  const w = window as unknown as {
    __floatty_kanban_nav_v1?: (e: KeyboardEvent) => void;
    __floatty_kanban_nav_v2?: (e: KeyboardEvent) => void;
  };
  // Clean up leaks from any prior bundle version (v1 from 5e/5f stack).
  if (w.__floatty_kanban_nav_v1) {
    document.removeEventListener('keydown', w.__floatty_kanban_nav_v1, true);
    delete w.__floatty_kanban_nav_v1;
  }
  if (w.__floatty_kanban_nav_v2) {
    document.removeEventListener('keydown', w.__floatty_kanban_nav_v2, true);
  }
  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown') return;
    const target = e.target as HTMLElement | null;
    if (!target || !target.classList?.contains('render-title-wrapper')) return;
    const blockItem = target.closest('.block-item');
    const card = blockItem?.querySelector<HTMLElement>('[data-kanban-card-id]');
    if (!card) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    card.focus();
    console.log(KANBAN_LOG, 'nav-shim ArrowDown → first card');
  };
  document.addEventListener('keydown', handler, true);
  w.__floatty_kanban_nav_v2 = handler;
  console.log(KANBAN_LOG, 'nav-shim installed');
}

// ═══════════════════════════════════════════════════════════════
// AUDIO / SYNTH PRIMITIVES (FLO-techno-fidget)
// ═══════════════════════════════════════════════════════════════
//
// Web Audio API. AudioContext is lazy — created on first user interaction
// to satisfy browser autoplay policy. Single shared context for the whole
// page; oscillators are short-lived per-note.

type WaveType = 'sine' | 'square' | 'sawtooth' | 'triangle';

interface TrackSpec {
  label: string;
  freq: number;
  duration?: number;
  wave?: WaveType;
  color?: string;
  /**
   * Per-track gain (0..2.5, default 1.0). Multiplied with the
   * component-level gain prop to compute the effective playTone gainPeak.
   * Use to mix-balance: kick at 1.2, hat at 0.7, etc.
   */
  gain?: number;
  /** Per-track FX sends override the component-level sends. */
  sends?: { delay?: number; reverb?: number };
}

// Audio-rig tunables. Named so swing/BPM math doesn't sprinkle bare numbers.
//   SWING_CAP — max swing fraction before odd-step delay collides with the
//     next step. 1.0 == full step interval; 0.85 leaves headroom.
//   BPM_FLOOR — clamp on bpm denominator in step-interval math; below this,
//     stepInterval explodes and the rig becomes unusable. UI sliders can
//     still display lower values; behavior caps here.
const SWING_CAP = 0.85;
const BPM_FLOOR = 30;

let _audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!_audioCtx) {
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) throw new Error('Web Audio API not supported');
    _audioCtx = new Ctor();
  }
  if (_audioCtx.state === 'suspended') void _audioCtx.resume();
  return _audioCtx;
}

// ─── RigBus: cross-block clock / transport / FX-send pub-sub ─────
//
// Multiple sequencer blocks attach to a named rig (default rigId='main').
// MasterClock emits 'rig:step' + 'rig:transport' events; slave sequencers
// listen and react. Voices route audio through getFxSend(rigId, sendName)
// when MasterFX is mounted on the same rig.

export interface RigStepDetail {
  rigId: string;
  step: number;        // 0-based step counter (looping per masterSteps)
  bpm: number;
  swing: number;       // 0..1 — fraction of step-interval to delay odd 16ths
  masterSteps: number; // master loop length
  audioTime: number;   // ctx.currentTime at the tick (seconds)
}
export interface RigTransportDetail {
  rigId: string;
  state: 'play' | 'stop';
}

// Listener registries. We use a window-attached map so the singleton
// survives Vite HMR; the door bundle re-runs but the listeners persist.
type RigBusGlobal = {
  __floatty_rig_listeners?: Map<string, Set<(d: RigStepDetail) => void>>;
  __floatty_rig_transport?: Map<string, Set<(d: RigTransportDetail) => void>>;
  __floatty_rig_state?: Map<string, { playing: boolean; bpm: number }>;
};
const rigGlobal = (): RigBusGlobal => (window as unknown as RigBusGlobal);

function rigStepListeners(rigId: string): Set<(d: RigStepDetail) => void> {
  const g = rigGlobal();
  if (!g.__floatty_rig_listeners) g.__floatty_rig_listeners = new Map();
  let s = g.__floatty_rig_listeners.get(rigId);
  if (!s) { s = new Set(); g.__floatty_rig_listeners.set(rigId, s); }
  return s;
}
function rigTransportListeners(rigId: string): Set<(d: RigTransportDetail) => void> {
  const g = rigGlobal();
  if (!g.__floatty_rig_transport) g.__floatty_rig_transport = new Map();
  let s = g.__floatty_rig_transport.get(rigId);
  if (!s) { s = new Set(); g.__floatty_rig_transport.set(rigId, s); }
  return s;
}

export function emitRigStep(d: RigStepDetail): void {
  rigStepListeners(d.rigId).forEach(fn => { try { fn(d); } catch { /* swallow */ } });
}
export function emitRigTransport(d: RigTransportDetail): void {
  rigTransportListeners(d.rigId).forEach(fn => { try { fn(d); } catch { /* swallow */ } });
}

export function subscribeRigStep(rigId: string, fn: (d: RigStepDetail) => void): () => void {
  rigStepListeners(rigId).add(fn);
  return () => { rigStepListeners(rigId).delete(fn); };
}
export function subscribeRigTransport(rigId: string, fn: (d: RigTransportDetail) => void): () => void {
  rigTransportListeners(rigId).add(fn);
  return () => { rigTransportListeners(rigId).delete(fn); };
}

/**
 * Wrap a step-fire callback so it honors the rig's swing value: odd 16ths
 * (1/4 of the bar's mid-points) get delayed by `swing * stepIntervalMs`,
 * even 16ths fire immediately. Maps the MasterClock UI knob (0..0.6) into
 * a behavioral delay.
 *
 * Swing 0   = straight 16ths
 * Swing 0.5 = full triplet feel (off-beat halfway between)
 * Swing 0.6 = max — past triplet, into shuffle
 */
export function applySwing(d: RigStepDetail, fire: () => void): void {
  const isOffBeat = (d.step % 2) === 1;
  if (!isOffBeat || d.swing <= 0) {
    fire();
    return;
  }
  const stepIntervalMs = 60000 / Math.max(d.bpm, BPM_FLOOR) / 4;
  const delayMs = Math.min(d.swing, SWING_CAP) * stepIntervalMs;
  setTimeout(fire, delayMs);
}

export function rigStateGet(rigId: string): { playing: boolean; bpm: number } {
  const g = rigGlobal();
  if (!g.__floatty_rig_state) g.__floatty_rig_state = new Map();
  let s = g.__floatty_rig_state.get(rigId);
  if (!s) { s = { playing: false, bpm: 124 }; g.__floatty_rig_state.set(rigId, s); }
  return s;
}

/**
 * Beat-ticks footer for sequencer step grids. Renders one cell per step:
 * the current step shows in amber, downbeats (every 4) show their beat
 * number, off-beats show a dim dot. Width-spacer matches the 70px label
 * gutter that StepSequencer / AcidBass / EuclideanDrums use to align
 * tick numbers with their step columns.
 *
 * Three sequencers had this exact JSX inlined; consolidating prevents
 * style drift if we change tick density / colors in one place.
 */
function BeatTicksFooter(props: { stepCount: number; currentStep: number; gutterWidth?: string }) {
  return (
    <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
      <span style={{ width: props.gutterWidth ?? '70px' }} />
      <div style={{
        display: 'grid',
        'grid-template-columns': `repeat(${props.stepCount}, 1fr)`,
        gap: '3px',
        flex: 1,
      }}>
        <For each={Array.from({ length: props.stepCount }, (_, i) => i)}>{(si) => (
          <div style={{
            'text-align': 'center',
            'font-size': '8px',
            color: props.currentStep === si ? V.amb : (si % 4 === 0 ? V.td : V.tf),
            'font-family': V.mono,
          }}>{si % 4 === 0 ? (si / 4 + 1) : '·'}</div>
        )}</For>
      </div>
    </div>
  );
}

/**
 * Slave-mode "△ clock: rigName" pill. Color-themed per voice, optionally
 * trailed by a live/idle dot. Common visual across the slave fallback in
 * StepSequencer / AcidBass / EuclideanDrums; sibling controls (clear, knobs)
 * are composed outside.
 */
function ClockBadge(props: { rig: string; color: string; playing?: boolean; showStatus?: boolean }) {
  return (
    <span style={{
      'font-size': '10px', color: props.color, 'font-family': V.mono,
      'letter-spacing': '0.1em', 'text-transform': 'uppercase',
      background: V.s2, padding: '4px 10px',
      border: `1px solid ${props.color}`, 'border-radius': '4px',
    }}>△ clock: {props.rig}{props.showStatus ? ` ${props.playing ? '● live' : '○ idle'}` : ''}</span>
  );
}

/**
 * Wire a sequencer voice as a slave on a named rig. Re-subscribes whenever
 * the `clockRig()` accessor changes, tears down on cleanup, hydrates initial
 * playing-state from `rigStateGet`. Pass `null`/`undefined` from `clockRig()`
 * to detach (master mode).
 *
 * Consolidated from StepSequencer / AcidBass / EuclideanDrums — they all had
 * identical re-sub/unsub bookkeeping; only the per-voice fire / transport
 * handlers differ, and those are passed in.
 *
 * The `on(clockRig, ...)` wrapper makes it explicit that this effect tracks
 * ONLY the rig accessor — without it, any reactive read inside `onStep` /
 * `onTransport` callbacks (executed at fire-time, not effect-run-time) would
 * be invisible to the tracker today, but a future refactor that pulls a
 * reactive read into the effect body would silently leak. See
 * `solidjs-patterns.md` rule 7.
 */
function useSlaveRig(opts: {
  clockRig: () => string | undefined;
  /**
   * Called when the rig fires a step. The second arg is a generation
   * accessor — call it before any deferred work (setTimeout, requestAnimationFrame,
   * etc.) to check whether this subscription is still current. Synchronous
   * `onStep` work is always current and doesn't need to consult it.
   *
   * Why: when the rig accessor changes (rig swap or unmount) WHILE a
   * previous step's swing-delayed callback is still pending, the firing
   * sequencer is now wired to a different rig. Without a guard, the
   * deferred fire lands on the new state with the old step index. See
   * CodeRabbit P1.1 review on PR #292.
   */
  onStep: (d: RigStepDetail, isStillCurrent: () => boolean) => void;
  onTransport: (d: RigTransportDetail) => void;
  onAttach?: (rig: string, state: { playing: boolean; bpm: number }) => void;
  /**
   * Called immediately before the previous rig's subscriptions are torn
   * down (rig swap or unmount). Lets stateful consumers reset whatever the
   * old rig left behind: AcidBass kills its sustained osc, the step-based
   * sequencers clear `playing`/`currentStep`. Without this, a live rig
   * swap leaves the consumer wired to the previous rig's last state.
   * CodeRabbit P1 review on PR #292.
   */
  onDetach?: () => void;
}): void {
  let unsubStep: (() => void) | undefined;
  let unsubTransport: (() => void) | undefined;
  let generation = 0;
  createEffect(on(opts.clockRig, (rig) => {
    generation++;
    const myGen = generation;
    const isStillCurrent = () => myGen === generation;
    // Notify consumer before tearing down the old rig — only when we
    // actually had subscriptions (skip the synthetic first-mount transition).
    if (unsubStep || unsubTransport) opts.onDetach?.();
    if (unsubStep) { unsubStep(); unsubStep = undefined; }
    if (unsubTransport) { unsubTransport(); unsubTransport = undefined; }
    if (!rig) return;
    unsubStep = subscribeRigStep(rig, (d) => {
      if (!isStillCurrent()) return; // listener-time guard for sync race
      opts.onStep(d, isStillCurrent);
    });
    unsubTransport = subscribeRigTransport(rig, (d) => {
      if (!isStillCurrent()) return;
      opts.onTransport(d);
    });
    if (opts.onAttach) opts.onAttach(rig, rigStateGet(rig));
  }));
  onCleanup(() => {
    generation++; // any deferred fire after unmount sees a stale gen and bails
    if (unsubStep || unsubTransport) opts.onDetach?.();
    if (unsubStep) unsubStep();
    if (unsubTransport) unsubTransport();
  });
}

// ─── Master output bus per rigId ─────────────────────────────────
//
// Single GainNode inserted between the rig's audio graph and
// ctx.destination. Voices terminate their dry path at masterOut, the
// FX bus terminates its delayMix/reverbMix outputs at masterOut, and
// masterOut → ctx.destination is the only direct speaker connection.
// One gain knob, attenuates everything routed through the rig.
//
// Lazy + autocreated — first voice on a rigId triggers construction
// even without a MasterFX panel mounted (default unity gain). Same
// HMR staleness pattern as FxBus: window-attached map survives module
// reload, AudioContext divergence drops the cached bus and rebuilds.
//
// XYPad is intentionally NOT wired through this graph — it has no
// rigId prop and is treated as a standalone drone voice with its own
// amp envelope. Schema-level rigId addition would bring it in.

interface MasterOutBus {
  ctx: AudioContext;
  masterOut: GainNode;
  setGain: (g: number) => void;
}

function buildMasterOutBus(): MasterOutBus {
  const ctx = getAudioContext();
  const masterOut = ctx.createGain();
  masterOut.gain.value = 1.0; // unity — preserves prior topology's loudness exactly
  masterOut.connect(ctx.destination);

  const setIfChanged = (param: AudioParam, value: number) => {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.linearRampToValueAtTime(value, now + 0.05);
  };

  return {
    ctx,
    masterOut,
    // Ceiling 2.5x — laptop speakers + low-frequency content (80Hz kicks
     // etc.) need real headroom past unity to be audible. Web Audio
     // tolerates >1 cleanly; clipping happens at the destination only when
     // the SUM of all summed sources exceeds 1.0, which 2.5x on a single
     // master node won't reach by itself.
    setGain: (g) => setIfChanged(masterOut.gain, Math.max(0, Math.min(2.5, g))),
  };
}

type MasterOutBusGlobal = { __floatty_master_outs?: Map<string, MasterOutBus> };
const masterOuts = (): Map<string, MasterOutBus> => {
  const g = window as unknown as MasterOutBusGlobal;
  if (!g.__floatty_master_outs) g.__floatty_master_outs = new Map();
  return g.__floatty_master_outs;
};

function getOrCreateMasterOut(rigId: string): MasterOutBus {
  const ctx = getAudioContext();
  const map = masterOuts();
  let bus = map.get(rigId);
  // Staleness check — see getOrCreateFxBus for the AudioContext failure
  // mode (Vite HMR closes the ctx, singleton resets, cached nodes orphan).
  if (bus && bus.ctx !== ctx) {
    map.delete(rigId);
    bus = undefined;
  }
  if (!bus) { bus = buildMasterOutBus(); map.set(rigId, bus); }
  return bus;
}

// ─── FX bus: delay + reverb sends per rigId ─────────────────────
//
// MasterFX creates the bus on mount; voices that opt into a send route
// their output node into getFxInput(rigId, sendName). Bus exposes setters
// that MasterFX's UI controls. Mix outputs terminate at the rig's
// MasterOut (not ctx.destination directly) so the master gain knob
// attenuates FX-routed audio in lock-step with the dry path.

interface FxBus {
  ctx: AudioContext;
  delayInput: GainNode;
  delayNode: DelayNode;
  delayFeedback: GainNode;
  delayMix: GainNode;
  reverbInput: GainNode;
  reverbConvolver: ConvolverNode;
  reverbMix: GainNode;
  dest: AudioNode;
  /**
   * The MasterOut GainNode this bus's mix outputs are connected to.
   * Tracked so getOrCreateFxBus can detect when the rig's MasterOut got
   * rebuilt (HMR or AudioContext rotation) and rebuild the FxBus to
   * re-bind to the fresh node — connecting to an orphaned masterOut
   * silently drops audio.
   */
  masterOutRef: GainNode;
  setDelayTime: (sec: number) => void;
  setDelayFeedback: (g: number) => void;
  setDelayMix: (g: number) => void;
  setReverbMix: (g: number) => void;
}

function createImpulseResponse(ctx: AudioContext, durationSec: number, decay: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * durationSec));
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

function buildFxBus(masterOut: GainNode): FxBus {
  const ctx = getAudioContext();
  const delayInput = ctx.createGain();
  const delayNode = ctx.createDelay(1.0);
  const delayFeedback = ctx.createGain();
  const delayMix = ctx.createGain();
  const reverbInput = ctx.createGain();
  const reverbConvolver = ctx.createConvolver();
  const reverbMix = ctx.createGain();

  delayNode.delayTime.value = 0.375;     // dotted-eighth at 120 BPM-ish
  delayFeedback.gain.value = 0.35;
  delayMix.gain.value = 0.35;
  reverbMix.gain.value = 0.25;
  reverbConvolver.buffer = createImpulseResponse(ctx, 2.5, 2.5);

  // Routing:
  //   delayInput → delayNode → delayMix → masterOut → ctx.destination
  //                   ↘  delayFeedback → delayNode (loop)
  //   reverbInput → reverbConvolver → reverbMix → masterOut → ctx.destination
  delayInput.connect(delayNode);
  delayNode.connect(delayMix);
  delayMix.connect(masterOut);
  delayNode.connect(delayFeedback);
  delayFeedback.connect(delayNode);

  reverbInput.connect(reverbConvolver);
  reverbConvolver.connect(reverbMix);
  reverbMix.connect(masterOut);

  const setIfChanged = (param: AudioParam, value: number) => {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.linearRampToValueAtTime(value, now + 0.05);
  };

  return {
    ctx, delayInput, delayNode, delayFeedback, delayMix,
    reverbInput, reverbConvolver, reverbMix,
    dest: masterOut,
    masterOutRef: masterOut,
    setDelayTime: (sec) => setIfChanged(delayNode.delayTime, Math.max(0.01, Math.min(1.0, sec))),
    setDelayFeedback: (g) => setIfChanged(delayFeedback.gain, Math.max(0, Math.min(0.85, g))),
    setDelayMix: (g) => setIfChanged(delayMix.gain, Math.max(0, Math.min(1.0, g))),
    setReverbMix: (g) => setIfChanged(reverbMix.gain, Math.max(0, Math.min(1.0, g))),
  };
}

type FxBusGlobal = { __floatty_fx_buses?: Map<string, FxBus> };
const fxBuses = (): Map<string, FxBus> => {
  const g = window as unknown as FxBusGlobal;
  if (!g.__floatty_fx_buses) g.__floatty_fx_buses = new Map();
  return g.__floatty_fx_buses;
};

function getOrCreateFxBus(rigId: string): FxBus {
  const ctx = getAudioContext();
  // Resolve masterOut FIRST — if it had to rebuild, FxBus needs to know
  // so it can re-bind its mix outputs to the fresh node.
  const masterBus = getOrCreateMasterOut(rigId);
  const map = fxBuses();
  let bus = map.get(rigId);
  // Staleness check (Vite HMR + AudioContext close): the FX-bus map is
  // window-attached so it survives module reload, but the AudioContext
  // singleton _audioCtx is module-local. After HMR the module reruns,
  // _audioCtx resets to null, getAudioContext() builds a fresh ctx —
  // but the cached bus still holds nodes bound to the OLD ctx. Voices
  // in the new ctx that try to connect to those nodes throw
  // InvalidAccessError. Drop + rebuild when contexts diverge.
  //
  // Second invariant: masterOutRef must match the current rig's
  // MasterOut. MasterOut can rebuild independently (its own staleness
  // path), and an FxBus pointing at an orphaned masterOut silently
  // drops audio with no error. Drop + rebuild on either drift.
  if (bus && (bus.ctx !== ctx || bus.masterOutRef !== masterBus.masterOut)) {
    map.delete(rigId);
    bus = undefined;
  }
  if (!bus) { bus = buildFxBus(masterBus.masterOut); map.set(rigId, bus); }
  return bus;
}

/**
 * Returns an input node for the named send on the rig's FX bus, or null
 * if the bus doesn't exist (no MasterFX mounted) OR if the cached bus
 * is from a previous AudioContext (HMR staleness — see getOrCreateFxBus).
 * Voices should route to this OR ctx.destination depending on whether
 * the user wired up FX. Stale buses get evicted from the map so the next
 * MasterFX mount rebuilds cleanly.
 */
function getFxSend(rigId: string, sendName: 'delay' | 'reverb'): AudioNode | null {
  const bus = fxBuses().get(rigId);
  if (!bus) return null;
  // Staleness check — see getOrCreateFxBus for the failure mode.
  if (bus.ctx !== getAudioContext()) {
    fxBuses().delete(rigId);
    return null;
  }
  return sendName === 'delay' ? bus.delayInput : bus.reverbInput;
}

/**
 * Connect a voice node to dry destination AND optionally to FX sends in
 * proportion to send levels (0..1). All sends are derived from a single
 * source connection chain — the voice picks its sources here.
 *
 * Dry path terminates at the rig's MasterOut (autocreated on first use
 * if no MasterFX panel is mounted), not ctx.destination directly. Same
 * applies transitively to FX-routed audio: getFxSend → FxBus mix nodes
 * → masterOut → ctx.destination. Result: a single GainNode controls
 * the entire rig's level.
 */
function routeVoiceToFx(
  source: AudioNode,
  ctx: AudioContext,
  rigId: string,
  delaySend: number,
  reverbSend: number,
): void {
  // Dry path always connects, now via the rig's MasterOut so the master
  // gain knob attenuates it (default unity = identical loudness to prior).
  const masterBus = getOrCreateMasterOut(rigId);
  source.connect(masterBus.masterOut);

  if (delaySend > 0) {
    const send = getFxSend(rigId, 'delay');
    if (send) {
      const g = ctx.createGain();
      g.gain.value = Math.max(0, Math.min(1, delaySend));
      source.connect(g);
      g.connect(send);
    }
  }
  if (reverbSend > 0) {
    const send = getFxSend(rigId, 'reverb');
    if (send) {
      const g = ctx.createGain();
      g.gain.value = Math.max(0, Math.min(1, reverbSend));
      source.connect(g);
      g.connect(send);
    }
  }
}

function playTone(
  freq: number,
  durationMs: number,
  wave: WaveType = 'sine',
  gainPeak = 0.25,
  rigId = 'main',
  delaySend = 0,
  reverbSend = 0,
): void {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = wave;
  osc.frequency.value = freq;
  const now = ctx.currentTime;
  const dur = Math.max(durationMs, 20) / 1000;
  // ADSR-ish: 5ms attack, exponential decay to silence.
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(gainPeak, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain);
  routeVoiceToFx(gain, ctx, rigId, delaySend, reverbSend);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

export function Tone(props: BaseComponentProps<{
  freq?: number;
  duration?: number;
  wave?: WaveType;
  label?: string;
  color?: string;
  gain?: number;
  rigId?: string;
  sends?: { delay?: number; reverb?: number };
}>) {
  const freq = () => props.props.freq ?? 440;
  const duration = () => props.props.duration ?? 200;
  const wave = () => props.props.wave ?? 'sine';
  const color = () => props.props.color ?? V.cy;
  const label = () => props.props.label ?? `${Math.round(freq())} Hz`;
  const rigId = () => props.props.rigId ?? 'main';
  const delaySend = () => props.props.sends?.delay ?? 0;
  const reverbSend = () => props.props.sends?.reverb ?? 0;
  // Voice-level gain: multiplied into the ADSR peak. Same shape as
  // sequencer per-track gain (commit 3) — preserves the envelope, just
  // scales the peak amplitude.
  const gain = () => props.props.gain ?? 1;
  const [active, setActive] = createSignal(false);

  const handleClick = () => {
    playTone(freq(), duration(), wave(), 0.25 * gain(), rigId(), delaySend(), reverbSend());
    setActive(true);
    setTimeout(() => setActive(false), Math.min(duration(), 300));
  };

  return (
    <button
      onClick={handleClick}
      style={{
        background: active() ? color() : V.s2,
        color: active() ? '#000' : color(),
        border: `1px solid ${color()}`,
        'border-radius': '6px',
        padding: '10px 16px',
        'font-size': '12px',
        'font-family': V.mono,
        'letter-spacing': '0.04em',
        cursor: 'pointer',
        transition: 'background 0.05s ease, color 0.05s ease',
        'min-width': '64px',
        'user-select': 'none',
      }}
    >
      {label()}
    </button>
  );
}

export function DrumPad(props: BaseComponentProps<{
  pads: Array<{ label: string; freq: number; duration?: number; wave?: WaveType; color?: string; gain?: number }>;
  columns?: number;
  title?: string;
  gain?: number;
  rigId?: string;
  sends?: { delay?: number; reverb?: number };
}>) {
  const pads = () => props.props.pads ?? [];
  const columns = () => props.props.columns ?? 4;
  const title = () => props.props.title;
  const rigId = () => props.props.rigId ?? 'main';
  const delaySend = () => props.props.sends?.delay ?? 0;
  const reverbSend = () => props.props.sends?.reverb ?? 0;
  // Component-level gain attenuates the whole pad; per-pad gain
  // multiplies in for mix-balance. Effective gainPeak per pad =
  // 0.25 * componentGain * (pad.gain ?? 1).
  const gain = () => props.props.gain ?? 1;

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <Show when={title()}>
        <div style={{
          'font-size': '11px',
          color: V.td,
          'font-family': V.mono,
          'text-transform': 'uppercase',
          'letter-spacing': '0.1em',
        }}>{title()}</div>
      </Show>
      <div style={{
        display: 'grid',
        'grid-template-columns': `repeat(${columns()}, 1fr)`,
        gap: '6px',
      }}>
        <For each={pads()}>{(pad) => {
          const [active, setActive] = createSignal(false);
          const wave: WaveType = pad.wave ?? 'sine';
          const dur = pad.duration ?? 200;
          const color = pad.color ?? V.mag;
          const padGain = (pad.gain ?? 1) * gain();
          const handleClick = () => {
            playTone(pad.freq, dur, wave, 0.25 * padGain, rigId(), delaySend(), reverbSend());
            setActive(true);
            setTimeout(() => setActive(false), Math.min(dur, 300));
          };
          return (
            <button
              onClick={handleClick}
              style={{
                background: active() ? color : V.s1,
                color: active() ? '#000' : color,
                border: `1px solid ${color}`,
                'border-radius': '8px',
                padding: '18px 8px',
                'font-size': '11px',
                'font-family': V.mono,
                'letter-spacing': '0.05em',
                'text-transform': 'uppercase',
                cursor: 'pointer',
                transition: 'background 0.04s ease, color 0.04s ease',
                'user-select': 'none',
                'min-height': '54px',
              }}
            >
              <div style={{ 'font-weight': 'bold' }}>{pad.label}</div>
              <div style={{ 'font-size': '9px', opacity: 0.7, 'margin-top': '2px' }}>{Math.round(pad.freq)} Hz · {wave}</div>
            </button>
          );
        }}</For>
      </div>
    </div>
  );
}

export function StepSequencer(props: BaseComponentProps<{
  bpm?: number;
  steps?: number;
  gain?: number;
  tracks: TrackSpec[];
  initial?: boolean[][];
  title?: string;
  clock?: string;
  rigId?: string;
  sends?: { delay?: number; reverb?: number };
}>) {
  const stepCount = () => props.props.steps ?? 16;
  const bpm = () => props.props.bpm ?? 120;
  const tracks = () => props.props.tracks ?? [];
  const title = () => props.props.title;
  const clockRig = () => props.props.clock; // truthy = slave mode
  const rigId = () => props.props.rigId ?? props.props.clock ?? 'main';
  const delaySend = () => props.props.sends?.delay ?? 0;
  const reverbSend = () => props.props.sends?.reverb ?? 0;
  // Component-level gain attenuates the whole sequencer; per-track gain
  // multiplies in for mix-balance. Live-editable via the GAIN knob below.
  const [gain, setGain] = createSignal(props.props.gain ?? 1);

  const seedGrid = (): boolean[][] => {
    const t = tracks();
    const s = stepCount();
    const init = props.props.initial;
    return t.map((_, ti) => {
      const row = init?.[ti];
      return Array.from({ length: s }, (_, si) => Boolean(row?.[si]));
    });
  };

  const [grid, setGrid] = createSignal<boolean[][]>(seedGrid());
  const [currentStep, setCurrentStep] = createSignal(-1);
  const [playing, setPlaying] = createSignal(false);
  const [bpmLocal, setBpmLocal] = createSignal(bpm());

  let intervalId: number | null = null;
  let stepCursor = -1;

  const stepIntervalMs = () => 60000 / bpmLocal() / 4; // 16th notes

  const fireStep = (idx: number) => {
    setCurrentStep(idx);
    const g = grid();
    const t = tracks();
    g.forEach((row, ti) => {
      if (row[idx]) {
        const tk = t[ti];
        if (tk) {
          // Per-track sends override component-level sends. Lets a kit
          // mix kick-dry-hat-wet without needing per-component scopes.
          const trackDelay = tk.sends?.delay ?? delaySend();
          const trackReverb = tk.sends?.reverb ?? reverbSend();
          // Effective gainPeak: 0.25 baseline × component gain × per-track gain.
          // Ceiling is 2.5×2.5×0.25 = 1.5625 — above unity, so layering both gains
          // near max will clip at ctx.destination on its own (before the master
          // GainNode multiplies further). Set both near max only when master is
          // correspondingly low.
          const trackGain = (tk.gain ?? 1) * gain();
          playTone(tk.freq, tk.duration ?? 100, tk.wave ?? 'sine', 0.25 * trackGain, rigId(), trackDelay, trackReverb);
        }
      }
    });
  };

  const tick = () => {
    stepCursor = (stepCursor + 1) % stepCount();
    fireStep(stepCursor);
  };

  // Slave mode: subscribe to RigBus, no internal interval.
  useSlaveRig({
    clockRig,
    onStep: (d, isStillCurrent) => {
      // Map master step → local step (modulo our own loop length)
      const idx = d.step % stepCount();
      applySwing(d, () => {
        if (!isStillCurrent()) return; // rig swapped during swing window
        fireStep(idx);
      });
    },
    onTransport: (d) => {
      setPlaying(d.state === 'play');
      if (d.state === 'stop') {
        stepCursor = -1;
        setCurrentStep(-1);
      }
    },
    onAttach: (_rig, s) => setPlaying(s.playing),
    onDetach: () => {
      // Old rig is going away — drop its transport state so we don't keep
      // showing "playing" on the previous rig's last beat. CodeRabbit P1.
      setPlaying(false);
      setCurrentStep(-1);
      stepCursor = -1;
    },
  });

  const start = () => {
    if (playing()) return;
    if (clockRig()) return; // slave — driven by rig bus
    // Unlock AudioContext via user gesture before scheduling.
    getAudioContext();
    stepCursor = -1;
    setCurrentStep(-1);
    setPlaying(true);
    intervalId = window.setInterval(tick, stepIntervalMs());
  };

  const stop = () => {
    if (clockRig()) return; // slave — only rig bus stops
    setPlaying(false);
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    setCurrentStep(-1);
    stepCursor = -1;
  };

  const clear = () => {
    setGrid(g => g.map(row => row.map(() => false)));
  };

  // Re-arm interval if BPM changes mid-play. `on(bpmLocal, ...)` scopes
  // the dependency so transitions of `playing` don't pointlessly re-run
  // the body (per Greptile P2 #290).
  createEffect(on(bpmLocal, () => {
    if (playing() && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = window.setInterval(tick, stepIntervalMs());
    }
  }));

  onCleanup(() => {
    if (intervalId !== null) clearInterval(intervalId);
  });

  const toggleCell = (track: number, step: number) => {
    setGrid(g => g.map((row, ti) =>
      ti === track ? row.map((cell, si) => si === step ? !cell : cell) : row
    ));
  };

  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      gap: '10px',
      padding: '12px',
      background: V.s1,
      border: `1px solid ${V.b2}`,
      'border-radius': '8px',
    }}>
      <Show when={title()}>
        <div style={{
          'font-size': '12px',
          color: V.cy,
          'font-family': V.mono,
          'text-transform': 'uppercase',
          'letter-spacing': '0.12em',
        }}>{title()}</div>
      </Show>

      {/* Transport — local in master mode, badge in slave mode */}
      <Show when={!clockRig()} fallback={
        <div style={{
          display: 'flex', 'align-items': 'center', gap: '8px',
          'padding-bottom': '8px', 'border-bottom': `1px solid ${V.b}`,
        }}>
          <ClockBadge rig={clockRig() ?? ''} color={V.cy} />
          <button
            onClick={clear}
            style={{
              background: V.s2, color: V.td, border: `1px solid ${V.b2}`,
              'border-radius': '4px', padding: '4px 10px',
              'font-size': '11px', 'font-family': V.mono, cursor: 'pointer',
            }}
          >CLEAR</button>
          <span style={{
            'font-size': '10px', color: V.tf, 'font-family': V.mono,
            'margin-left': 'auto',
          }}>{playing() ? '● live' : '○ idle'}</span>
        </div>
      }>
        <div style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          'padding-bottom': '8px',
          'border-bottom': `1px solid ${V.b}`,
        }}>
          <button
            onClick={() => playing() ? stop() : start()}
            style={{
              background: playing() ? V.cor : V.green,
              color: '#000',
              border: 'none',
              'border-radius': '4px',
              padding: '6px 14px',
              'font-size': '11px',
              'font-family': V.mono,
              'font-weight': 'bold',
              'letter-spacing': '0.1em',
              cursor: 'pointer',
              'min-width': '60px',
            }}
          >{playing() ? 'STOP' : 'PLAY'}</button>

          <button
            onClick={clear}
            style={{
              background: V.s2,
              color: V.td,
              border: `1px solid ${V.b2}`,
              'border-radius': '4px',
              padding: '6px 12px',
              'font-size': '11px',
              'font-family': V.mono,
              cursor: 'pointer',
            }}
          >CLEAR</button>

          <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'margin-left': 'auto' }}>
            <span style={{ 'font-size': '10px', color: V.td, 'font-family': V.mono, 'letter-spacing': '0.1em' }}>BPM</span>
            <input
              type="range"
              min="40"
              max="240"
              value={bpmLocal()}
              onInput={(e) => setBpmLocal(parseInt(e.currentTarget.value, 10) || 120)}
              style={{ width: '120px', 'accent-color': V.amb }}
            />
            <span style={{ 'font-size': '12px', color: V.amb, 'font-family': V.mono, 'min-width': '32px', 'text-align': 'right' }}>{bpmLocal()}</span>
            <span style={{ 'font-size': '10px', color: V.td, 'font-family': V.mono, 'letter-spacing': '0.1em', 'margin-left': '12px' }}>GAIN</span>
            <input
              type="range"
              min="0"
              max="2.5"
              step="0.01"
              value={gain()}
              onInput={(e) => setGain(parseFloat(e.currentTarget.value))}
              style={{ width: '80px', 'accent-color': V.cy }}
            />
            <span style={{ 'font-size': '12px', color: V.cy, 'font-family': V.mono, 'min-width': '36px', 'text-align': 'right' }}>{Math.round(gain() * 100)}%</span>
          </div>
        </div>
      </Show>

      {/* Grid */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        <For each={tracks()}>{(track, ti) => (
          <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
            <span style={{
              width: '70px',
              color: track.color ?? V.cy,
              'font-family': V.mono,
              'font-size': '10px',
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
              'text-align': 'right',
              'padding-right': '4px',
            }}>{track.label}</span>
            <div style={{
              display: 'grid',
              'grid-template-columns': `repeat(${stepCount()}, 1fr)`,
              gap: '3px',
              flex: 1,
            }}>
              <For each={Array.from({ length: stepCount() }, (_, i) => i)}>{(si) => {
                const isActive = () => grid()[ti()]?.[si] ?? false;
                const isCurrent = () => currentStep() === si;
                const isBeat = si % 4 === 0;
                const trackColor = track.color ?? V.cy;
                return (
                  <button
                    onClick={() => toggleCell(ti(), si)}
                    style={{
                      background: isActive() ? trackColor : (isBeat ? V.s2 : V.bg),
                      border: `1px solid ${isCurrent() ? V.amb : (isActive() ? trackColor : V.b)}`,
                      'border-radius': '3px',
                      height: '26px',
                      cursor: 'pointer',
                      transition: 'background 0.04s ease',
                      padding: 0,
                      'box-shadow': isCurrent() ? `0 0 6px ${V.amb}66` : 'none',
                    }}
                    aria-label={`${track.label} step ${si + 1}`}
                  />
                );
              }}</For>
            </div>
          </div>
        )}</For>
      </div>

      <BeatTicksFooter stepCount={stepCount()} currentStep={currentStep()} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ACID BASS — 303-style mono with filter envelope (FLO-techno-fidget)
// ═══════════════════════════════════════════════════════════════
//
// Pseudo-mono voice: single oscillator running continuously while
// transport plays, retriggered per step via amp + filter envelopes.
// Slide flag does linear-ramp portamento to next note's frequency.
// Accent boosts amp peak and adds extra cutoff modulation.

interface AcidVoice {
  ctx: AudioContext;
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  amp: GainNode;
  ampEnv: GainNode;
}

function createAcidVoice(
  wave: 'sawtooth' | 'square',
  rigId = 'main',
  delaySend = 0,
  reverbSend = 0,
): AcidVoice {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const ampEnv = ctx.createGain(); // per-note shape
  const amp = ctx.createGain(); // master volume

  osc.type = wave;
  osc.frequency.value = 110;
  filter.type = 'lowpass';
  filter.frequency.value = 600;
  filter.Q.value = 12;
  ampEnv.gain.value = 0.0001;
  amp.gain.value = 0.45;

  osc.connect(filter);
  filter.connect(ampEnv);
  ampEnv.connect(amp);
  routeVoiceToFx(amp, ctx, rigId, delaySend, reverbSend);
  return { ctx, osc, filter, amp, ampEnv };
}

function semitoneToHz(base: number, semi: number): number {
  return base * Math.pow(2, semi / 12);
}

export function AcidBass(props: BaseComponentProps<{
  bpm?: number;
  steps?: number;
  notes: Array<number | null>;
  accents?: boolean[];
  slides?: boolean[];
  baseFreq?: number;
  wave?: 'sawtooth' | 'square';
  gain?: number;
  cutoff?: number;
  resonance?: number;
  envAmount?: number;
  envDecay?: number;
  title?: string;
  clock?: string;
  rigId?: string;
  sends?: { delay?: number; reverb?: number };
}>) {
  const stepCount = () => props.props.steps ?? 16;
  const baseFreq = () => props.props.baseFreq ?? 55;
  const wave = () => props.props.wave ?? 'sawtooth';
  const clockRig = () => props.props.clock;
  const rigId = () => props.props.rigId ?? props.props.clock ?? 'main';
  const delaySend = () => props.props.sends?.delay ?? 0;
  const reverbSend = () => props.props.sends?.reverb ?? 0;

  const seedNotes = (): Array<number | null> => {
    const n = props.props.notes ?? [];
    const out: Array<number | null> = [];
    for (let i = 0; i < stepCount(); i++) out.push(n[i] ?? null);
    return out;
  };
  const seedBools = (src?: boolean[]): boolean[] => {
    const out: boolean[] = [];
    for (let i = 0; i < stepCount(); i++) out.push(Boolean(src?.[i]));
    return out;
  };

  const [notes, setNotes] = createSignal<Array<number | null>>(seedNotes());
  const [accents, setAccents] = createSignal<boolean[]>(seedBools(props.props.accents));
  const [slides, setSlides] = createSignal<boolean[]>(seedBools(props.props.slides));
  const [currentStep, setCurrentStep] = createSignal(-1);
  const [playing, setPlaying] = createSignal(false);
  const [bpm, setBpm] = createSignal(props.props.bpm ?? 124);
  const [gain, setGain] = createSignal(props.props.gain ?? 1);
  const [cutoff, setCutoff] = createSignal(props.props.cutoff ?? 600);
  const [resonance, setResonance] = createSignal(props.props.resonance ?? 14);
  const [envAmount, setEnvAmount] = createSignal(props.props.envAmount ?? 2400);
  const [envDecay, setEnvDecay] = createSignal(props.props.envDecay ?? 220);

  let voice: AcidVoice | null = null;
  let intervalId: number | null = null;
  let stepCursor = -1;
  let prevWasNote = false;

  const stepIntervalMs = () => 60000 / bpm() / 4;

  const triggerStep = (idx: number) => {
    if (!voice) return;
    const { ctx, osc, filter, ampEnv } = voice;
    const note = notes()[idx];
    if (note == null) {
      // rest — just silence the amp env
      const now = ctx.currentTime;
      ampEnv.gain.cancelScheduledValues(now);
      ampEnv.gain.linearRampToValueAtTime(0.0001, now + 0.04);
      prevWasNote = false;
      return;
    }
    const targetHz = semitoneToHz(baseFreq(), note);
    const accent = accents()[idx];
    const slide = slides()[idx];
    const now = ctx.currentTime;
    const decaySec = Math.max(envDecay(), 30) / 1000;

    // Pitch — slide does portamento, otherwise instant
    osc.frequency.cancelScheduledValues(now);
    if (slide && prevWasNote) {
      osc.frequency.linearRampToValueAtTime(targetHz, now + 0.05);
    } else {
      osc.frequency.setValueAtTime(targetHz, now);
    }

    // Amp env — quick attack, exponential decay
    const peak = accent ? 1.0 : 0.7;
    ampEnv.gain.cancelScheduledValues(now);
    ampEnv.gain.setValueAtTime(0.0001, now);
    ampEnv.gain.linearRampToValueAtTime(peak, now + 0.005);
    ampEnv.gain.exponentialRampToValueAtTime(0.0001, now + decaySec);

    // Filter env
    filter.Q.setValueAtTime(resonance(), now);
    const baseCut = cutoff();
    const peakCut = baseCut + envAmount() + (accent ? envAmount() * 0.6 : 0);
    filter.frequency.cancelScheduledValues(now);
    filter.frequency.setValueAtTime(peakCut, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(baseCut, 80), now + decaySec);

    prevWasNote = true;
  };

  const ensureVoice = () => {
    if (!voice) {
      voice = createAcidVoice(wave(), rigId(), delaySend(), reverbSend());
      voice.osc.start();
      // Apply current gain to the freshly-created voice. The gain effect
      // below handles live changes; this seeds the initial value so a
      // play-after-knob-drag respects the user's setting.
      voice.amp.gain.value = 0.45 * gain();
    }
  };

  // Live: knob changes ramp amp.gain on the active voice. Scoped with on()
  // so the effect doesn't re-run when other reactive reads (rigId, sends,
  // etc.) happen — only gain transitions matter here.
  createEffect(on(gain, (g) => {
    if (!voice) return;
    const ctx = voice.ctx;
    const now = ctx.currentTime;
    voice.amp.gain.cancelScheduledValues(now);
    voice.amp.gain.linearRampToValueAtTime(0.45 * g, now + 0.05);
  }));

  const fireStep = (idx: number) => {
    setCurrentStep(idx);
    triggerStep(idx);
  };

  const tick = () => {
    stepCursor = (stepCursor + 1) % stepCount();
    fireStep(stepCursor);
  };

  // Slave-mode rig subscriptions. Acid voice lifecycle is asymmetric vs the
  // poly sequencers: a sustained osc must be created on play and stopped
  // (not just amp-envelope-released) on stop, and re-created on next play.
  useSlaveRig({
    clockRig,
    onStep: (d, isStillCurrent) => {
      ensureVoice();
      applySwing(d, () => {
        if (!isStillCurrent()) return; // rig swapped during swing window
        fireStep(d.step % stepCount());
      });
    },
    onTransport: (d) => {
      if (d.state === 'play') {
        ensureVoice();
        prevWasNote = false;
        setPlaying(true);
      } else {
        if (voice) {
          const now = voice.ctx.currentTime;
          voice.ampEnv.gain.cancelScheduledValues(now);
          voice.ampEnv.gain.linearRampToValueAtTime(0.0001, now + 0.05);
          voice.osc.stop(now + 0.1);
          voice = null;
        }
        setPlaying(false);
        stepCursor = -1;
        setCurrentStep(-1);
        prevWasNote = false;
      }
    },
    onAttach: (_rig, s) => {
      setPlaying(s.playing);
      if (s.playing) ensureVoice();
    },
    // Old rig is leaving — silence the sustained osc and reset state so
    // a new rig swap doesn't leave 303-bass droning. CodeRabbit P1 #292.
    onDetach: () => {
      if (voice) {
        const now = voice.ctx.currentTime;
        voice.ampEnv.gain.cancelScheduledValues(now);
        voice.ampEnv.gain.linearRampToValueAtTime(0.0001, now + 0.05);
        voice.osc.stop(now + 0.1);
        voice = null;
      }
      setPlaying(false);
      setCurrentStep(-1);
      stepCursor = -1;
      prevWasNote = false;
    },
  });

  const start = () => {
    if (playing()) return;
    if (clockRig()) return;
    ensureVoice();
    stepCursor = -1;
    prevWasNote = false;
    setCurrentStep(-1);
    setPlaying(true);
    intervalId = window.setInterval(tick, stepIntervalMs());
  };

  const stop = () => {
    if (clockRig()) return;
    setPlaying(false);
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (voice) {
      const now = voice.ctx.currentTime;
      voice.ampEnv.gain.cancelScheduledValues(now);
      voice.ampEnv.gain.linearRampToValueAtTime(0.0001, now + 0.05);
      voice.osc.stop(now + 0.1);
      voice = null;
    }
    setCurrentStep(-1);
    stepCursor = -1;
    prevWasNote = false;
  };

  // Re-arm interval on BPM change
  // BPM re-arm — `on(bpm, ...)` scopes deps so transitions of `playing`
  // don't pointlessly re-run the body (Greptile P2 #290).
  createEffect(on(bpm, () => {
    if (playing() && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = window.setInterval(tick, stepIntervalMs());
    }
  }));

  onCleanup(() => {
    if (intervalId !== null) clearInterval(intervalId);
    if (voice) { try { voice.osc.stop(); } catch { /* may already be stopped */ } voice = null; }
  });

  const cycleNote = (i: number) => {
    // Cycle through useful 303 voicings (semitones from base)
    const cycle: Array<number | null> = [null, 0, 3, 5, 7, 10, 12, 15];
    setNotes(ns => ns.map((n, idx) => {
      if (idx !== i) return n;
      const cur = cycle.indexOf(n ?? null);
      return cycle[(cur + 1) % cycle.length];
    }));
  };

  const toggleAccent = (i: number) => setAccents(a => a.map((v, idx) => idx === i ? !v : v));
  const toggleSlide = (i: number) => setSlides(a => a.map((v, idx) => idx === i ? !v : v));

  // Knob primitive — vertical slider styled as a fader
  const Knob = (kp: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; setter: (v: number) => void; color?: string }) => (
    <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '4px', 'min-width': '64px' }}>
      <span style={{ 'font-size': '9px', color: V.td, 'font-family': V.mono, 'letter-spacing': '0.1em', 'text-transform': 'uppercase' }}>{kp.label}</span>
      <input
        type="range"
        min={kp.min}
        max={kp.max}
        step={kp.step ?? 1}
        value={kp.value}
        onInput={(e) => kp.setter(parseFloat(e.currentTarget.value))}
        style={{ width: '64px', 'accent-color': kp.color ?? V.amb }}
      />
      <span style={{ 'font-size': '10px', color: kp.color ?? V.amb, 'font-family': V.mono, 'min-width': '36px', 'text-align': 'center' }}>
        {Math.round(kp.value)}{kp.suffix ?? ''}
      </span>
    </div>
  );

  const semiLabel = (n: number | null): string => {
    if (n == null) return '·';
    if (n === 0) return '0';
    return n > 0 ? `+${n}` : `${n}`;
  };

  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      gap: '12px',
      padding: '14px',
      background: V.s1,
      border: `1px solid ${V.b2}`,
      'border-radius': '8px',
    }}>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '12px',
          color: V.cor,
          'font-family': V.mono,
          'text-transform': 'uppercase',
          'letter-spacing': '0.12em',
        }}>{props.props.title}</div>
      </Show>

      {/* Transport */}
      <div style={{
        display: 'flex',
        'align-items': 'center',
        gap: '12px',
        'padding-bottom': '10px',
        'border-bottom': `1px solid ${V.b}`,
        'flex-wrap': 'wrap',
      }}>
        <Show when={!clockRig()} fallback={
          <ClockBadge rig={clockRig() ?? ''} color={V.cor} playing={playing()} showStatus />
        }>
          <button
            onClick={() => playing() ? stop() : start()}
            style={{
              background: playing() ? V.cor : V.green,
              color: '#000',
              border: 'none',
              'border-radius': '4px',
              padding: '6px 14px',
              'font-size': '11px',
              'font-family': V.mono,
              'font-weight': 'bold',
              'letter-spacing': '0.1em',
              cursor: 'pointer',
              'min-width': '60px',
            }}
          >{playing() ? 'STOP' : 'PLAY'}</button>
          <Knob label="BPM" value={bpm()} min={60} max={200} step={1} setter={setBpm} />
        </Show>
        <Knob label="GAIN" value={gain() * 100} min={0} max={250} step={1} suffix="%" setter={(v) => setGain(v / 100)} color={V.cy} />
        <Knob label="CUTOFF" value={cutoff()} min={80} max={4000} step={10} suffix=" Hz" setter={setCutoff} color={V.cy} />
        <Knob label="RES" value={resonance()} min={0.5} max={28} step={0.5} setter={setResonance} color={V.mag} />
        <Knob label="ENV AMT" value={envAmount()} min={0} max={6000} step={50} suffix=" Hz" setter={setEnvAmount} color={V.amb} />
        <Knob label="DECAY" value={envDecay()} min={40} max={900} step={10} suffix=" ms" setter={setEnvDecay} color={V.green} />
      </div>

      {/* Pitch row — click to cycle */}
      <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
        <span style={{
          width: '70px',
          color: V.cor,
          'font-family': V.mono,
          'font-size': '10px',
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
          'text-align': 'right',
          'padding-right': '4px',
        }}>NOTE</span>
        <div style={{
          display: 'grid',
          'grid-template-columns': `repeat(${stepCount()}, 1fr)`,
          gap: '3px',
          flex: 1,
        }}>
          <For each={Array.from({ length: stepCount() }, (_, i) => i)}>{(si) => {
            const note = () => notes()[si];
            const isCurrent = () => currentStep() === si;
            const isBeat = si % 4 === 0;
            const hasNote = () => note() != null;
            return (
              <button
                onClick={() => cycleNote(si)}
                style={{
                  background: hasNote() ? V.cor : (isBeat ? V.s2 : V.bg),
                  color: hasNote() ? '#000' : V.tf,
                  border: `1px solid ${isCurrent() ? V.amb : (hasNote() ? V.cor : V.b)}`,
                  'border-radius': '3px',
                  height: '30px',
                  'font-size': '10px',
                  'font-family': V.mono,
                  'font-weight': hasNote() ? 'bold' : 'normal',
                  cursor: 'pointer',
                  padding: 0,
                  'box-shadow': isCurrent() ? `0 0 6px ${V.amb}66` : 'none',
                }}
                aria-label={`step ${si + 1} note`}
              >{semiLabel(note())}</button>
            );
          }}</For>
        </div>
      </div>

      {/* Accent row */}
      <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
        <span style={{
          width: '70px',
          color: V.amb,
          'font-family': V.mono,
          'font-size': '10px',
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
          'text-align': 'right',
          'padding-right': '4px',
        }}>ACCENT</span>
        <div style={{
          display: 'grid',
          'grid-template-columns': `repeat(${stepCount()}, 1fr)`,
          gap: '3px',
          flex: 1,
        }}>
          <For each={Array.from({ length: stepCount() }, (_, i) => i)}>{(si) => {
            const isAcc = () => accents()[si];
            return (
              <button
                onClick={() => toggleAccent(si)}
                style={{
                  background: isAcc() ? V.amb : V.bg,
                  border: `1px solid ${isAcc() ? V.amb : V.b}`,
                  'border-radius': '3px',
                  height: '14px',
                  cursor: 'pointer',
                  padding: 0,
                }}
                aria-label={`step ${si + 1} accent`}
              />
            );
          }}</For>
        </div>
      </div>

      {/* Slide row */}
      <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
        <span style={{
          width: '70px',
          color: V.cy,
          'font-family': V.mono,
          'font-size': '10px',
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
          'text-align': 'right',
          'padding-right': '4px',
        }}>SLIDE</span>
        <div style={{
          display: 'grid',
          'grid-template-columns': `repeat(${stepCount()}, 1fr)`,
          gap: '3px',
          flex: 1,
        }}>
          <For each={Array.from({ length: stepCount() }, (_, i) => i)}>{(si) => {
            const isSli = () => slides()[si];
            return (
              <button
                onClick={() => toggleSlide(si)}
                style={{
                  background: isSli() ? V.cy : V.bg,
                  border: `1px solid ${isSli() ? V.cy : V.b}`,
                  'border-radius': '3px',
                  height: '14px',
                  cursor: 'pointer',
                  padding: 0,
                }}
                aria-label={`step ${si + 1} slide`}
              />
            );
          }}</For>
        </div>
      </div>

      <BeatTicksFooter stepCount={stepCount()} currentStep={currentStep()} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EUCLIDEAN DRUMS — Bjorklund n-of-k pattern generator
// ═══════════════════════════════════════════════════════════════
//
// Bjorklund's algorithm distributes `hits` pulses as evenly as possible
// across `steps` positions. (3,8) -> tresillo, (5,8) -> cinquillo,
// (7,12) -> Aksak, etc. Tweaking hits/steps live = cascading polyrhythm
// magic. Rotation shifts the start position.

export function bjorklund(hits: number, steps: number): boolean[] {
  if (hits <= 0 || steps <= 0) return Array(Math.max(steps, 0)).fill(false);
  if (hits >= steps) return Array(steps).fill(true);

  // E. Bjorklund's recursive algorithm (2003) — produces the most
  // evenly-distributed pattern of `hits` pulses across `steps` positions.
  // Reference: "The Theory of Rep-Rate Pattern Generation in the SNS
  // Timing System".
  //
  // The recursive form below builds the pattern by Euclidean division of
  // (steps - hits) by `hits`. Output starts with a `false` (`0...01`
  // segments). After build, we rotate to the first `true` so the pattern
  // begins on a hit — that's what users expect when they say "(3, 8) is
  // tresillo at positions 0, 3, 6".
  const pattern: boolean[] = [];
  const counts: number[] = [];
  const remainders: number[] = [hits];
  let divisor = steps - hits;
  let level = 0;

  while (true) {
    counts.push(Math.floor(divisor / remainders[level]));
    remainders.push(divisor % remainders[level]);
    divisor = remainders[level];
    level++;
    if (remainders[level] <= 1) break;
  }
  counts.push(divisor);

  const build = (lvl: number): void => {
    if (lvl === -1) {
      pattern.push(false);
    } else if (lvl === -2) {
      pattern.push(true);
    } else {
      for (let i = 0; i < counts[lvl]; i++) build(lvl - 1);
      if (remainders[lvl] !== 0) build(lvl - 2);
    }
  };
  build(level);

  // Rotate so the first hit lands on position 0 (canonical form).
  const firstHit = pattern.indexOf(true);
  if (firstHit <= 0) return pattern;
  return [...pattern.slice(firstHit), ...pattern.slice(0, firstHit)];
}

export function rotateArray<T>(arr: T[], by: number): T[] {
  const n = arr.length;
  if (n === 0) return arr;
  const r = ((by % n) + n) % n;
  return [...arr.slice(r), ...arr.slice(0, r)];
}

interface EuclidTrack {
  label: string;
  hits: number;
  rotation?: number;
  freq: number;
  duration?: number;
  wave?: WaveType;
  color?: string;
  /**
   * Per-track gain (0..2.5, default 1.0). Multiplied with the
   * component-level gain to compute the effective playTone gainPeak.
   */
  gain?: number;
  /** Per-track FX sends override component-level sends. */
  sends?: { delay?: number; reverb?: number };
}

export function EuclideanDrums(props: BaseComponentProps<{
  bpm?: number;
  steps?: number;
  gain?: number;
  tracks: EuclidTrack[];
  title?: string;
  clock?: string;
  rigId?: string;
  sends?: { delay?: number; reverb?: number };
}>) {
  const stepCount = () => props.props.steps ?? 16;
  const clockRig = () => props.props.clock;
  const rigId = () => props.props.rigId ?? props.props.clock ?? 'main';
  const delaySend = () => props.props.sends?.delay ?? 0;
  const reverbSend = () => props.props.sends?.reverb ?? 0;
  const initialTracks = (): EuclidTrack[] =>
    (props.props.tracks ?? []).map(t => ({ ...t }));

  const [tracks, setTracks] = createSignal<EuclidTrack[]>(initialTracks());
  const [bpm, setBpm] = createSignal(props.props.bpm ?? 124);
  const [currentStep, setCurrentStep] = createSignal(-1);
  const [playing, setPlaying] = createSignal(false);
  const [gain, setGain] = createSignal(props.props.gain ?? 1);

  const patterns = createMemo(() =>
    tracks().map(t => rotateArray(bjorklund(t.hits, stepCount()), t.rotation ?? 0))
  );

  let intervalId: number | null = null;
  let stepCursor = -1;

  const stepIntervalMs = () => 60000 / bpm() / 4;

  const fireStep = (idx: number) => {
    setCurrentStep(idx);
    const ts = tracks();
    const ps = patterns();
    ts.forEach((tk, ti) => {
      if (ps[ti]?.[idx]) {
        // Per-track sends override component-level sends.
        const trackDelay = tk.sends?.delay ?? delaySend();
        const trackReverb = tk.sends?.reverb ?? reverbSend();
        // Effective gainPeak = baseline 0.25 × component gain × per-track gain.
        const trackGain = (tk.gain ?? 1) * gain();
        playTone(tk.freq, tk.duration ?? 100, tk.wave ?? 'sine', 0.25 * trackGain, rigId(), trackDelay, trackReverb);
      }
    });
  };

  const tick = () => {
    stepCursor = (stepCursor + 1) % stepCount();
    fireStep(stepCursor);
  };

  useSlaveRig({
    clockRig,
    onStep: (d, isStillCurrent) => applySwing(d, () => {
      if (!isStillCurrent()) return; // rig swapped during swing window
      fireStep(d.step % stepCount());
    }),
    onTransport: (d) => {
      setPlaying(d.state === 'play');
      if (d.state === 'stop') {
        stepCursor = -1;
        setCurrentStep(-1);
      }
    },
    onAttach: (_rig, s) => setPlaying(s.playing),
    onDetach: () => {
      // Drop transport state from the old rig so a swap doesn't leave the
      // step-cursor frozen on the previous rig's last beat. CodeRabbit P1.
      setPlaying(false);
      setCurrentStep(-1);
      stepCursor = -1;
    },
  });

  const start = () => {
    if (playing()) return;
    if (clockRig()) return;
    getAudioContext();
    stepCursor = -1;
    setCurrentStep(-1);
    setPlaying(true);
    intervalId = window.setInterval(tick, stepIntervalMs());
  };

  const stop = () => {
    if (clockRig()) return;
    setPlaying(false);
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    setCurrentStep(-1);
    stepCursor = -1;
  };

  // BPM re-arm — `on(bpm, ...)` scopes deps so transitions of `playing`
  // don't pointlessly re-run the body (Greptile P2 #290).
  createEffect(on(bpm, () => {
    if (playing() && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = window.setInterval(tick, stepIntervalMs());
    }
  }));

  onCleanup(() => {
    if (intervalId !== null) clearInterval(intervalId);
  });

  const updateTrack = (i: number, patch: Partial<EuclidTrack>) => {
    setTracks(ts => ts.map((t, idx) => idx === i ? { ...t, ...patch } : t));
  };

  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      gap: '10px',
      padding: '12px',
      background: V.s1,
      border: `1px solid ${V.b2}`,
      'border-radius': '8px',
    }}>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '12px',
          color: V.mag,
          'font-family': V.mono,
          'text-transform': 'uppercase',
          'letter-spacing': '0.12em',
        }}>{props.props.title}</div>
      </Show>

      {/* Transport */}
      <Show when={!clockRig()} fallback={
        <div style={{
          display: 'flex', 'align-items': 'center', gap: '8px',
          'padding-bottom': '8px', 'border-bottom': `1px solid ${V.b}`,
        }}>
          <ClockBadge rig={clockRig() ?? ''} color={V.mag} playing={playing()} showStatus />
        </div>
      }>
        <div style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          'padding-bottom': '8px',
          'border-bottom': `1px solid ${V.b}`,
        }}>
          <button
            onClick={() => playing() ? stop() : start()}
            style={{
              background: playing() ? V.cor : V.green,
              color: '#000',
              border: 'none',
              'border-radius': '4px',
              padding: '6px 14px',
              'font-size': '11px',
              'font-family': V.mono,
              'font-weight': 'bold',
              'letter-spacing': '0.1em',
              cursor: 'pointer',
              'min-width': '60px',
            }}
          >{playing() ? 'STOP' : 'PLAY'}</button>

          <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'margin-left': 'auto' }}>
            <span style={{ 'font-size': '10px', color: V.td, 'font-family': V.mono, 'letter-spacing': '0.1em' }}>BPM</span>
            <input
              type="range"
              min="60"
              max="200"
              value={bpm()}
              onInput={(e) => setBpm(parseInt(e.currentTarget.value, 10) || 124)}
              style={{ width: '120px', 'accent-color': V.amb }}
            />
            <span style={{ 'font-size': '12px', color: V.amb, 'font-family': V.mono, 'min-width': '32px', 'text-align': 'right' }}>{bpm()}</span>
            <span style={{ 'font-size': '10px', color: V.td, 'font-family': V.mono, 'letter-spacing': '0.1em', 'margin-left': '12px' }}>GAIN</span>
            <input
              type="range"
              min="0"
              max="2.5"
              step="0.01"
              value={gain()}
              onInput={(e) => setGain(parseFloat(e.currentTarget.value))}
              style={{ width: '80px', 'accent-color': V.cy }}
            />
            <span style={{ 'font-size': '12px', color: V.cy, 'font-family': V.mono, 'min-width': '36px', 'text-align': 'right' }}>{Math.round(gain() * 100)}%</span>
          </div>
        </div>
      </Show>

      {/* Tracks */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <For each={tracks()}>{(track, ti) => {
          const trackColor = track.color ?? V.cy;
          const pattern = () => patterns()[ti()] ?? [];
          return (
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
              {/* Track header with hits/rotation knobs */}
              <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'padding-bottom': '2px' }}>
                <span style={{
                  width: '70px',
                  color: trackColor,
                  'font-family': V.mono,
                  'font-size': '10px',
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.05em',
                  'text-align': 'right',
                  'padding-right': '4px',
                }}>{track.label}</span>

                <div style={{ display: 'flex', 'align-items': 'center', gap: '4px' }}>
                  <span style={{ 'font-size': '9px', color: V.tf, 'font-family': V.mono }}>HITS</span>
                  <button
                    onClick={() => updateTrack(ti(), { hits: Math.max(0, track.hits - 1) })}
                    style={{ background: V.s2, color: V.t, border: `1px solid ${V.b2}`, 'border-radius': '3px', width: '20px', height: '18px', cursor: 'pointer', 'font-family': V.mono, 'font-size': '11px', padding: 0 }}
                  >−</button>
                  <span style={{ 'font-size': '11px', color: trackColor, 'font-family': V.mono, 'min-width': '20px', 'text-align': 'center' }}>{track.hits}</span>
                  <button
                    onClick={() => updateTrack(ti(), { hits: Math.min(stepCount(), track.hits + 1) })}
                    style={{ background: V.s2, color: V.t, border: `1px solid ${V.b2}`, 'border-radius': '3px', width: '20px', height: '18px', cursor: 'pointer', 'font-family': V.mono, 'font-size': '11px', padding: 0 }}
                  >+</button>
                </div>

                <div style={{ display: 'flex', 'align-items': 'center', gap: '4px' }}>
                  <span style={{ 'font-size': '9px', color: V.tf, 'font-family': V.mono }}>ROT</span>
                  <button
                    onClick={() => updateTrack(ti(), { rotation: ((track.rotation ?? 0) - 1 + stepCount()) % stepCount() })}
                    style={{ background: V.s2, color: V.t, border: `1px solid ${V.b2}`, 'border-radius': '3px', width: '20px', height: '18px', cursor: 'pointer', 'font-family': V.mono, 'font-size': '11px', padding: 0 }}
                  >◀</button>
                  <span style={{ 'font-size': '11px', color: trackColor, 'font-family': V.mono, 'min-width': '20px', 'text-align': 'center' }}>{track.rotation ?? 0}</span>
                  <button
                    onClick={() => updateTrack(ti(), { rotation: ((track.rotation ?? 0) + 1) % stepCount() })}
                    style={{ background: V.s2, color: V.t, border: `1px solid ${V.b2}`, 'border-radius': '3px', width: '20px', height: '18px', cursor: 'pointer', 'font-family': V.mono, 'font-size': '11px', padding: 0 }}
                  >▶</button>
                </div>

                <span style={{ 'font-size': '9px', color: V.tf, 'font-family': V.mono, 'margin-left': 'auto' }}>
                  {track.hits}/{stepCount()}
                </span>
              </div>

              {/* Step row (read-only — derived from hits/rotation) */}
              <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
                <span style={{ width: '70px' }} />
                <div style={{
                  display: 'grid',
                  'grid-template-columns': `repeat(${stepCount()}, 1fr)`,
                  gap: '3px',
                  flex: 1,
                }}>
                  <For each={Array.from({ length: stepCount() }, (_, i) => i)}>{(si) => {
                    const isActive = () => pattern()[si] ?? false;
                    const isCurrent = () => currentStep() === si;
                    const isBeat = si % 4 === 0;
                    return (
                      <div style={{
                        background: isActive() ? trackColor : (isBeat ? V.s2 : V.bg),
                        border: `1px solid ${isCurrent() ? V.amb : (isActive() ? trackColor : V.b)}`,
                        'border-radius': '3px',
                        height: '20px',
                        'box-shadow': isCurrent() ? `0 0 6px ${V.amb}66` : 'none',
                      }} />
                    );
                  }}</For>
                </div>
              </div>
            </div>
          );
        }}</For>
      </div>

      <BeatTicksFooter stepCount={stepCount()} currentStep={currentStep()} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// XY PAD — drone with continuous filter sweep
// ═══════════════════════════════════════════════════════════════
//
// Press-and-drag pad. Pointer down starts a sustained oscillator
// through a lowpass filter; pointer move modulates cutoff (X, log)
// and resonance (Y, linear). Pointer up releases.

interface XYVoice {
  ctx: AudioContext;
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  amp: GainNode;
}

function createXYVoice(wave: WaveType, baseFreq: number): XYVoice {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();
  osc.type = wave;
  osc.frequency.value = baseFreq;
  filter.type = 'lowpass';
  filter.frequency.value = 800;
  filter.Q.value = 8;
  amp.gain.value = 0;
  osc.connect(filter);
  filter.connect(amp);
  amp.connect(ctx.destination);
  osc.start();
  return { ctx, osc, filter, amp };
}

export function XYPad(props: BaseComponentProps<{
  baseFreq?: number;
  wave?: WaveType;
  width?: number;
  height?: number;
  color?: string;
  title?: string;
}>) {
  const baseFreq = () => props.props.baseFreq ?? 110;
  const wave = () => props.props.wave ?? 'sawtooth';
  const W = () => props.props.width ?? 280;
  const H = () => props.props.height ?? 220;
  const color = () => props.props.color ?? V.mag;

  const [active, setActive] = createSignal(false);
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
  const [readout, setReadout] = createSignal<{ cutoff: number; q: number }>({ cutoff: 800, q: 8 });

  let voice: XYVoice | null = null;
  let containerRef: HTMLDivElement | undefined;

  // Map normalized x [0,1] to log frequency [200, 8000]
  const xToCutoff = (x: number) => {
    const fMin = 200, fMax = 8000;
    return fMin * Math.pow(fMax / fMin, Math.max(0, Math.min(1, x)));
  };
  const yToQ = (y: number) => 0.5 + (1 - Math.max(0, Math.min(1, y))) * 24.5;

  const updateFromEvent = (e: PointerEvent) => {
    if (!containerRef || !voice) return;
    const rect = containerRef.getBoundingClientRect();
    const xN = (e.clientX - rect.left) / rect.width;
    const yN = (e.clientY - rect.top) / rect.height;
    const cutoff = xToCutoff(xN);
    const q = yToQ(yN);
    setPos({ x: xN, y: yN });
    setReadout({ cutoff, q });
    const now = voice.ctx.currentTime;
    voice.filter.frequency.setTargetAtTime(cutoff, now, 0.02);
    voice.filter.Q.setTargetAtTime(q, now, 0.02);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!containerRef) return;
    containerRef.setPointerCapture(e.pointerId);
    voice = createXYVoice(wave(), baseFreq());
    const now = voice.ctx.currentTime;
    voice.amp.gain.cancelScheduledValues(now);
    voice.amp.gain.linearRampToValueAtTime(0.35, now + 0.04);
    setActive(true);
    updateFromEvent(e);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!active()) return;
    updateFromEvent(e);
  };

  const release = (e?: PointerEvent) => {
    if (!active()) return;
    setActive(false);
    setPos(null);
    if (voice) {
      const now = voice.ctx.currentTime;
      voice.amp.gain.cancelScheduledValues(now);
      voice.amp.gain.linearRampToValueAtTime(0.0001, now + 0.08);
      voice.osc.stop(now + 0.12);
      voice = null;
    }
    if (e && containerRef && containerRef.hasPointerCapture(e.pointerId)) {
      containerRef.releasePointerCapture(e.pointerId);
    }
  };

  onCleanup(() => release());

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '11px', color: V.td, 'font-family': V.mono,
          'text-transform': 'uppercase', 'letter-spacing': '0.1em',
        }}>{props.props.title}</div>
      </Show>

      <div
        ref={(el) => { containerRef = el; }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => release(e)}
        onPointerCancel={(e) => release(e)}
        onPointerLeave={(e) => active() && release(e)}
        style={{
          width: `${W()}px`,
          height: `${H()}px`,
          background: `radial-gradient(circle at 50% 50%, ${V.s2}, ${V.bg})`,
          border: `1px solid ${active() ? color() : V.b2}`,
          'border-radius': '8px',
          position: 'relative',
          cursor: active() ? 'crosshair' : 'pointer',
          'touch-action': 'none',
          'user-select': 'none',
          transition: 'border-color 0.1s ease',
        }}
      >
        {/* Crosshair guides */}
        <div style={{
          position: 'absolute',
          left: '0', right: '0', top: '50%',
          height: '1px',
          background: V.b,
        }} />
        <div style={{
          position: 'absolute',
          top: '0', bottom: '0', left: '50%',
          width: '1px',
          background: V.b,
        }} />

        {/* Pointer dot */}
        <Show when={pos()}>
          {(p) => (
            <div style={{
              position: 'absolute',
              left: `${p().x * 100}%`,
              top: `${p().y * 100}%`,
              width: '20px',
              height: '20px',
              background: color(),
              'border-radius': '50%',
              transform: 'translate(-50%, -50%)',
              'box-shadow': `0 0 16px ${color()}, 0 0 32px ${color()}66`,
              'pointer-events': 'none',
            }} />
          )}
        </Show>

        {/* Corner labels */}
        <div style={{
          position: 'absolute', bottom: '6px', left: '8px',
          'font-size': '9px', color: V.tf, 'font-family': V.mono,
        }}>200 Hz</div>
        <div style={{
          position: 'absolute', bottom: '6px', right: '8px',
          'font-size': '9px', color: V.tf, 'font-family': V.mono,
        }}>8 kHz</div>
        <div style={{
          position: 'absolute', top: '6px', left: '8px',
          'font-size': '9px', color: V.tf, 'font-family': V.mono,
        }}>Q 25</div>
        <div style={{
          position: 'absolute', top: '6px', right: '8px',
          'font-size': '9px', color: V.tf, 'font-family': V.mono,
        }}>{Math.round(baseFreq())} Hz · {wave()}</div>
      </div>

      {/* Readout */}
      <div style={{ display: 'flex', gap: '12px', 'font-family': V.mono, 'font-size': '11px' }}>
        <span style={{ color: V.cy }}>cutoff {Math.round(readout().cutoff)} Hz</span>
        <span style={{ color: V.mag }}>Q {readout().q.toFixed(1)}</span>
        <span style={{ color: active() ? V.amb : V.tf, 'margin-left': 'auto' }}>{active() ? '● live' : '○ idle'}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MASTER CLOCK — drives RigBus on a named rigId
// ═══════════════════════════════════════════════════════════════

export function MasterClock(props: BaseComponentProps<{
  rigId?: string;
  bpm?: number;
  steps?: number;
  swing?: number;
  title?: string;
}>) {
  const rigId = () => props.props.rigId ?? 'main';
  const masterSteps = () => props.props.steps ?? 16;
  const initialBpm = props.props.bpm ?? 124;

  const [bpm, setBpm] = createSignal(initialBpm);
  const [swing, setSwing] = createSignal(props.props.swing ?? 0);
  const [playing, setPlaying] = createSignal(false);
  const [currentStep, setCurrentStep] = createSignal(-1);

  let intervalId: number | null = null;
  let stepCursor = -1;

  const stepIntervalMs = () => 60000 / bpm() / 4;

  const tick = () => {
    stepCursor = (stepCursor + 1) % masterSteps();
    setCurrentStep(stepCursor);
    const ctx = getAudioContext();
    emitRigStep({
      rigId: rigId(),
      step: stepCursor,
      bpm: bpm(),
      swing: swing(),
      masterSteps: masterSteps(),
      audioTime: ctx.currentTime,
    });
  };

  const start = () => {
    if (playing()) return;
    getAudioContext();
    stepCursor = -1;
    setCurrentStep(-1);
    setPlaying(true);
    rigStateGet(rigId()).playing = true;
    rigStateGet(rigId()).bpm = bpm();
    emitRigTransport({ rigId: rigId(), state: 'play' });
    intervalId = window.setInterval(tick, stepIntervalMs());
  };

  const stop = () => {
    setPlaying(false);
    rigStateGet(rigId()).playing = false;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    setCurrentStep(-1);
    stepCursor = -1;
    emitRigTransport({ rigId: rigId(), state: 'stop' });
  };

  // Re-arm on BPM change
  // BPM re-arm — `on(bpm, ...)` scopes deps so transitions of `playing`
  // don't pointlessly re-run the body (Greptile P2 #290).
  createEffect(on(bpm, () => {
    if (playing() && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = window.setInterval(tick, stepIntervalMs());
    }
  }));

  onCleanup(() => {
    if (intervalId !== null) clearInterval(intervalId);
    if (playing()) emitRigTransport({ rigId: rigId(), state: 'stop' });
  });

  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      gap: '10px',
      padding: '14px',
      background: 'linear-gradient(135deg, #0d0d0d, #1a0d18)',
      border: `1px solid ${V.amb}`,
      'border-radius': '8px',
      'box-shadow': playing() ? `0 0 18px ${V.amb}33` : 'none',
      transition: 'box-shadow 0.15s ease',
    }}>
      <div style={{
        display: 'flex', 'align-items': 'center', gap: '12px',
      }}>
        <span style={{
          'font-size': '11px', color: V.amb, 'font-family': V.mono,
          'text-transform': 'uppercase', 'letter-spacing': '0.18em',
          'font-weight': 'bold',
        }}>◇ master clock</span>
        <span style={{
          'font-size': '10px', color: V.td, 'font-family': V.mono,
          padding: '3px 8px', background: V.s2,
          border: `1px solid ${V.b2}`, 'border-radius': '4px',
        }}>rig: {rigId()}</span>
        <Show when={props.props.title}>
          <span style={{
            'font-size': '10px', color: V.tf, 'font-family': V.mono,
            'margin-left': 'auto',
          }}>{props.props.title}</span>
        </Show>
      </div>

      <div style={{
        display: 'flex', 'align-items': 'center', gap: '14px',
      }}>
        <button
          onClick={() => playing() ? stop() : start()}
          style={{
            background: playing() ? V.cor : V.amb,
            color: '#000',
            border: 'none',
            'border-radius': '4px',
            padding: '8px 18px',
            'font-size': '12px',
            'font-family': V.mono,
            'font-weight': 'bold',
            'letter-spacing': '0.12em',
            cursor: 'pointer',
            'min-width': '74px',
          }}
        >{playing() ? '◼ STOP' : '▶ PLAY'}</button>

        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
          <span style={{ 'font-size': '10px', color: V.td, 'font-family': V.mono, 'letter-spacing': '0.1em' }}>BPM</span>
          <input
            type="range"
            min="60"
            max="200"
            value={bpm()}
            onInput={(e) => setBpm(parseInt(e.currentTarget.value, 10) || 124)}
            style={{ width: '120px', 'accent-color': V.amb }}
          />
          <span style={{ 'font-size': '14px', color: V.amb, 'font-family': V.mono, 'min-width': '36px', 'text-align': 'right', 'font-weight': 'bold' }}>{bpm()}</span>
        </div>

        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
          <span style={{ 'font-size': '10px', color: V.td, 'font-family': V.mono, 'letter-spacing': '0.1em' }}>SWING</span>
          <input
            type="range"
            min="0"
            max="0.6"
            step="0.01"
            value={swing()}
            onInput={(e) => setSwing(parseFloat(e.currentTarget.value) || 0)}
            style={{ width: '80px', 'accent-color': V.cy }}
          />
          <span style={{ 'font-size': '11px', color: V.cy, 'font-family': V.mono, 'min-width': '32px', 'text-align': 'right' }}>{Math.round(swing() * 100)}%</span>
        </div>
      </div>

      {/* Step indicator */}
      <div style={{
        display: 'grid',
        'grid-template-columns': `repeat(${masterSteps()}, 1fr)`,
        gap: '3px',
      }}>
        <For each={Array.from({ length: masterSteps() }, (_, i) => i)}>{(si) => {
          const isCurrent = () => currentStep() === si;
          const isBeat = si % 4 === 0;
          return (
            <div style={{
              height: '8px',
              background: isCurrent() ? V.amb : (isBeat ? V.s2 : V.bg),
              border: `1px solid ${isCurrent() ? V.amb : V.b}`,
              'border-radius': '2px',
              'box-shadow': isCurrent() ? `0 0 6px ${V.amb}` : 'none',
              transition: 'background 0.04s ease',
            }} />
          );
        }}</For>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MASTER FX — shared delay + reverb bus per rigId
// ═══════════════════════════════════════════════════════════════

export function MasterFX(props: BaseComponentProps<{
  rigId?: string;
  gain?: number;
  delayTime?: number;
  delayFeedback?: number;
  delayMix?: number;
  reverbMix?: number;
  title?: string;
}>) {
  const rigId = () => props.props.rigId ?? 'main';
  const [gain, setGain] = createSignal(props.props.gain ?? 1.0);
  const [delayTime, setDelayTime] = createSignal(props.props.delayTime ?? 0.375);
  const [delayFeedback, setDelayFeedback] = createSignal(props.props.delayFeedback ?? 0.35);
  const [delayMix, setDelayMix] = createSignal(props.props.delayMix ?? 0.35);
  const [reverbMix, setReverbMix] = createSignal(props.props.reverbMix ?? 0.25);

  // Mount: build bus on this rigId, push initial values. MasterOut is
  // a separate per-rig bus from FxBus — touch both so initial gain
  // value is applied even when the rig has no voices yet.
  onMount(() => {
    const fx = getOrCreateFxBus(rigId());
    fx.setDelayTime(delayTime());
    fx.setDelayFeedback(delayFeedback());
    fx.setDelayMix(delayMix());
    fx.setReverbMix(reverbMix());
    const master = getOrCreateMasterOut(rigId());
    master.setGain(gain());
  });

  // Live: push knob changes to bus. Each knob gets its own effect so a
  // change to one parameter doesn't re-emit the others' setIfChanged ramps.
  const pushParam = (read: () => number, apply: (b: FxBus, v: number) => void) => {
    createEffect(() => {
      const v = read();
      const bus = fxBuses().get(rigId());
      if (!bus) return;
      apply(bus, v);
    });
  };
  pushParam(delayTime, (b, v) => b.setDelayTime(v));
  pushParam(delayFeedback, (b, v) => b.setDelayFeedback(v));
  pushParam(delayMix, (b, v) => b.setDelayMix(v));
  pushParam(reverbMix, (b, v) => b.setReverbMix(v));

  // Master gain rides on its own bus (MasterOut, not FxBus) — separate
  // effect so it doesn't entangle with FX-knob lookups. Use the
  // autocreating getOrCreateMasterOut() so a runtime rigId change (e.g.
  // rebinding MasterFX to a different rig that hasn't been touched yet)
  // doesn't silently default the new rig's masterOut to unity. Mirrors
  // the getOrCreateFxBus() pattern used by the FX param effects above.
  // Safe to call inside createEffect: getOrCreateMasterOut reads only
  // module-local + window-attached state, no reactive signals.
  createEffect(() => {
    const v = gain();
    const bus = getOrCreateMasterOut(rigId());
    bus.setGain(v);
  });

  // Note: we don't tear down the bus on cleanup — it's a shared resource
  // keyed by rigId, and other voices may still be sending to it. Cleanup
  // is implicit at AudioContext close.

  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      gap: '10px',
      padding: '14px',
      background: 'linear-gradient(135deg, #0d0d0d, #0d1a18)',
      border: `1px solid ${V.cy}`,
      'border-radius': '8px',
    }}>
      <div style={{
        display: 'flex', 'align-items': 'center', gap: '12px',
      }}>
        <span style={{
          'font-size': '11px', color: V.cy, 'font-family': V.mono,
          'text-transform': 'uppercase', 'letter-spacing': '0.18em',
          'font-weight': 'bold',
        }}>◇ master fx</span>
        <span style={{
          'font-size': '10px', color: V.td, 'font-family': V.mono,
          padding: '3px 8px', background: V.s2,
          border: `1px solid ${V.b2}`, 'border-radius': '4px',
        }}>rig: {rigId()}</span>
        <Show when={props.props.title}>
          <span style={{
            'font-size': '10px', color: V.tf, 'font-family': V.mono,
            'margin-left': 'auto',
          }}>{props.props.title}</span>
        </Show>
      </div>

      <div style={{
        display: 'flex', gap: '18px', 'flex-wrap': 'wrap',
        'align-items': 'flex-start',
      }}>
        {/* Master output group — single knob controlling the per-rig
            masterOut GainNode all voices and FX-mix outputs transit. */}
        <div style={{
          display: 'flex', 'flex-direction': 'column', gap: '6px',
          padding: '10px 12px',
          background: V.s1,
          border: `1px solid ${V.amb}`,
          'border-radius': '6px',
        }}>
          <span style={{ 'font-size': '9px', color: V.amb, 'font-family': V.mono, 'letter-spacing': '0.1em', 'text-transform': 'uppercase' }}>master out</span>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', 'align-items': 'center', 'min-width': '60px' }}>
              <span style={{ 'font-size': '8px', color: V.td, 'font-family': V.mono }}>GAIN</span>
              <input type="range" min="0" max="2.5" step="0.01" value={gain()} onInput={(e) => setGain(parseFloat(e.currentTarget.value))} style={{ width: '60px', 'accent-color': V.amb }} />
              <span style={{ 'font-size': '9px', color: V.amb, 'font-family': V.mono }}>{Math.round(gain() * 100)}%</span>
            </div>
          </div>
        </div>

        {/* Delay group */}
        <div style={{
          display: 'flex', 'flex-direction': 'column', gap: '6px',
          padding: '10px 12px',
          background: V.s1,
          border: `1px solid ${V.b}`,
          'border-radius': '6px',
        }}>
          <span style={{ 'font-size': '9px', color: V.cy, 'font-family': V.mono, 'letter-spacing': '0.1em', 'text-transform': 'uppercase' }}>delay</span>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', 'align-items': 'center', 'min-width': '60px' }}>
              <span style={{ 'font-size': '8px', color: V.td, 'font-family': V.mono }}>TIME</span>
              <input type="range" min="0.05" max="0.95" step="0.01" value={delayTime()} onInput={(e) => setDelayTime(parseFloat(e.currentTarget.value))} style={{ width: '60px', 'accent-color': V.cy }} />
              <span style={{ 'font-size': '9px', color: V.cy, 'font-family': V.mono }}>{(delayTime() * 1000).toFixed(0)} ms</span>
            </div>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', 'align-items': 'center', 'min-width': '60px' }}>
              <span style={{ 'font-size': '8px', color: V.td, 'font-family': V.mono }}>FBK</span>
              <input type="range" min="0" max="0.85" step="0.01" value={delayFeedback()} onInput={(e) => setDelayFeedback(parseFloat(e.currentTarget.value))} style={{ width: '60px', 'accent-color': V.cy }} />
              <span style={{ 'font-size': '9px', color: V.cy, 'font-family': V.mono }}>{Math.round(delayFeedback() * 100)}%</span>
            </div>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', 'align-items': 'center', 'min-width': '60px' }}>
              <span style={{ 'font-size': '8px', color: V.td, 'font-family': V.mono }}>MIX</span>
              <input type="range" min="0" max="1" step="0.01" value={delayMix()} onInput={(e) => setDelayMix(parseFloat(e.currentTarget.value))} style={{ width: '60px', 'accent-color': V.cy }} />
              <span style={{ 'font-size': '9px', color: V.cy, 'font-family': V.mono }}>{Math.round(delayMix() * 100)}%</span>
            </div>
          </div>
        </div>

        {/* Reverb group */}
        <div style={{
          display: 'flex', 'flex-direction': 'column', gap: '6px',
          padding: '10px 12px',
          background: V.s1,
          border: `1px solid ${V.b}`,
          'border-radius': '6px',
        }}>
          <span style={{ 'font-size': '9px', color: V.mag, 'font-family': V.mono, 'letter-spacing': '0.1em', 'text-transform': 'uppercase' }}>reverb</span>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', 'align-items': 'center', 'min-width': '60px' }}>
              <span style={{ 'font-size': '8px', color: V.td, 'font-family': V.mono }}>MIX</span>
              <input type="range" min="0" max="1" step="0.01" value={reverbMix()} onInput={(e) => setReverbMix(parseFloat(e.currentTarget.value))} style={{ width: '60px', 'accent-color': V.mag }} />
              <span style={{ 'font-size': '9px', color: V.mag, 'font-family': V.mono }}>{Math.round(reverbMix() * 100)}%</span>
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex', 'flex-direction': 'column', gap: '4px',
          'align-self': 'center',
          'font-family': V.mono, 'font-size': '10px', color: V.tf,
          'max-width': '220px',
          'line-height': '1.4',
        }}>
          <span style={{ color: V.td, 'font-size': '9px', 'letter-spacing': '0.1em', 'text-transform': 'uppercase' }}>send wiring</span>
          <span>voices opt in via</span>
          <span style={{ color: V.cy }}>sends: {'{ delay, reverb }'}</span>
          <span>matching <span style={{ color: V.amb }}>rigId</span></span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// STRUDEL — iframe to strudel.cc with pattern URL-encoded
// ═══════════════════════════════════════════════════════════════
//
// strudel.cc accepts the mini-notation source as a base64-encoded URL
// hash. No NPM dep needed; the page hosts the runtime. Doesn't sync to
// our RigBus today — runs its own clock. Future work: postMessage bridge
// from MasterClock to Strudel for clock-locked patterns.

export function Strudel(props: BaseComponentProps<{
  pattern: string;
  cps?: number;
  height?: string;
  title?: string;
}>) {
  const cps = () => props.props.cps ?? 0.5;
  const height = () => props.props.height ?? '420px';
  const pattern = () => props.props.pattern ?? '';

  const url = createMemo(() => {
    // Strudel REPL accepts: https://strudel.cc/?<id>#<base64-encoded-pattern>
    // We don't need an id (any random nonce works) — pattern lives in the hash.
    // Coerce cps to a finite number — the value flows into a templated
    // string that becomes evaluated JS inside the strudel.cc iframe. Spec
    // authors are trusted in floatty's threat model, but the iframe still
    // runs in strudel.cc's origin; defensive coercion keeps a stray
    // string-typed `cps` (or `Infinity`/`NaN`) from corrupting the call.
    // CodeRabbit P3.3 #292.
    const cpsRaw = Number(cps());
    const cpsSafe = Number.isFinite(cpsRaw) ? cpsRaw : 0.5;
    const fullPattern = `setcps(${cpsSafe})\n\n${pattern()}`;
    // btoa accepts only Latin-1 (0x00–0xFF). UTF-8 in `pattern` (emoji,
    // accents, CJK) would throw InvalidCharacterError and blank the iframe.
    // Encode to UTF-8 bytes, render as a binary string, then base64.
    // CodeRabbit P3 #292.
    const encoded = (() => {
      if (typeof btoa === 'undefined') return '';
      const bytes = new TextEncoder().encode(fullPattern);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    })();
    const safeEncoded = encoded.replace(/=+$/, '');
    return `https://strudel.cc/?${Math.random().toString(36).slice(2, 10)}#${safeEncoded}`;
  });

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '11px', color: V.amb, 'font-family': V.mono,
          'text-transform': 'uppercase', 'letter-spacing': '0.1em',
        }}>{props.props.title} <span style={{ color: V.tf }}>· strudel.cc</span></div>
      </Show>
      <iframe
        src={url()}
        // sandbox includes allow-same-origin per the floatty Tauri rule —
        // iframe content is cross-origin from tauri://localhost so it
        // needs same-origin to access its own subresources.
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{
          width: '100%',
          height: height(),
          border: `1px solid ${V.b2}`,
          'border-radius': '8px',
          background: V.s1,
        }}
        title="Strudel REPL"
        allow="autoplay"
      />
      <div style={{
        'font-size': '9px', color: V.tf, 'font-family': V.mono,
        'letter-spacing': '0.05em',
      }}>cps {cps()} · pattern {pattern().length}b · iframe → strudel.cc</div>
    </div>
  );
}

export function injectBodyStyles() {
  if (typeof document === 'undefined') return;
  if (!document.querySelector('[data-bbs-entry-styles]')) {
    const style = document.createElement('style');
    style.setAttribute('data-bbs-entry-styles', '');
    style.textContent = BODY_STYLES;
    document.head.appendChild(style);
  }
  installKanbanStyles();
  installKanbanNavShim();
}
