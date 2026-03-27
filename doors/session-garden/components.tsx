/**
 * BBS Document Viewer components for @json-render/solid
 *
 * SolidJS implementations of the bbsCatalog.
 * These components render inside floatty blocks via the door system
 * or standalone in any SolidJS app.
 *
 * Aesthetic: sunday-session-garden — dark, monospace nav, serif body,
 * magenta/cyan/coral accent system.
 */

import { Show, For, createSignal } from 'solid-js';
import type { BaseComponentProps } from '@json-render/solid';

// Platform-aware modifier: ⌘ on Mac, Ctrl elsewhere
const _isMac = typeof navigator !== 'undefined' &&
  (navigator.platform ? /Mac|iPod|iPhone|iPad/.test(navigator.platform) : false);
const isModClick = (e: MouseEvent) => _isMac ? e.metaKey : e.ctrlKey;

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

/** Apply inline formatting (bold, italic, code, wikilinks) to a string */
function inlineFormat(s: string): string {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Wikilinks — render as clickable spans
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, target) => {
    const escaped = target.replace(/"/g, '&quot;');
    return `<span class="bbs-wikilink" data-wikilink="${escaped}">${target}</span>`;
  });
  // [issue::NNN] markers — render as muted tags
  s = s.replace(/\[issue::(\d+)\]/g, '<span class="bbs-marker">#$1</span>');
  return s;
}

function renderMarkdown(text: string): string {
  let s = text;

  // Code fences FIRST — protect from inline formatting
  const fences: string[] = [];
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    const c = m.slice(3, -3).trim().replace(/</g, '&lt;');
    fences.push('<pre><code>' + c + '</code></pre>');
    return `\x00FENCE${fences.length - 1}\x00`;
  });

  // Tables — inline formatting per cell (already formatted, skip later pass)
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
  // List items — wrap consecutive <li> in <ul>
  s = s.replace(/^- (.+)$/gm, '<li>$1</li>');
  s = s.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Inline formatting on remaining text (fences + tables already extracted)
  s = inlineFormat(s);

  // Restore fences and tables
  fences.forEach((html, i) => { s = s.replace(`\x00FENCE${i}\x00`, html); });
  tables.forEach((html, i) => { s = s.replace(`\x00TABLE${i}\x00`, html); });

  s = s.replace(/\n\n/g, '</p><p>');
  return s;
}

// ═══════════════════════════════════════════════════════════════
// LAYOUT
// ═══════════════════════════════════════════════════════════════

export function DocLayout(props: BaseComponentProps<{ sidebarWidth?: number }>) {
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
      innerHTML={props.props.content}
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
  const handleClick = (e: MouseEvent) => {
    // Only navigate on ⌘-click (Mac) / Ctrl-click — normal clicks stay in the door
    if (!isModClick(e)) return;

    let el = e.target as HTMLElement | null;
    while (el && !el.dataset?.wikilink) {
      if (el.classList?.contains('bbs-entry-body')) break;
      el = el.parentElement;
    }
    if (el?.dataset?.wikilink) {
      e.preventDefault();
      e.stopPropagation();
      el.dispatchEvent(new CustomEvent('garden-navigate', {
        bubbles: true,
        detail: {
          target: el.dataset.wikilink,
          splitDirection: e.shiftKey ? 'vertical' : undefined,
        },
      }));
    }
  };

  return (
    <div
      class="bbs-entry-body"
      innerHTML={renderMarkdown(props.props.markdown)}
      onClick={handleClick}
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
// BASE (shared with render:: door)
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

export function BarChart(props: BaseComponentProps<{ title?: string; maxHeight?: number }>) {
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
      <div style={{
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
  const pct = () => {
    const max = props.props.max || 100;
    return Math.min(100, (props.props.value / max) * 100);
  };
  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      'align-items': 'center',
      flex: '1',
      'min-width': '28px',
    }}>
      <div style={{
        width: '100%',
        background: props.props.color || V.cy,
        height: `${pct()}%`,
        'min-height': props.props.value > 0 ? '2px' : '0',
        opacity: props.props.value > 0 ? '0.7' : '0.15',
        transition: 'height 0.2s',
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
      <span style={{ color: V.t }} innerHTML={inlineFormat(props.props.content)} />
    </div>
  );
}

export function WikilinkChip(props: BaseComponentProps<{ target: string; label?: string }>) {
  let ref: HTMLSpanElement | undefined;
  const handleClick = (e: MouseEvent) => {
    if (isModClick(e)) {
      // ⌘-click → navigate in outline (respects linked panes)
      e.preventDefault();
      e.stopPropagation();
      ref?.dispatchEvent(new CustomEvent('garden-navigate', {
        bubbles: true,
        detail: {
          target: props.props.target,
          splitDirection: e.shiftKey ? 'vertical' : undefined,
        },
      }));
    } else {
      // Normal click → door-internal action
      props.emit('press');
    }
  };
  return (
    <span
      ref={ref}
      class="bbs-wikilink"
      data-wikilink={props.props.target}
      style={{ cursor: 'pointer' }}
      onClick={handleClick}
    >
      [[{props.props.label || props.props.target}]]
    </span>
  );
}

export function BacklinksFooter(props: BaseComponentProps<{ inbound: string[]; outbound: string[] }>) {
  let containerRef: HTMLDivElement | undefined;
  const handleClick = (e: MouseEvent) => {
    if (!isModClick(e)) return;
    // Walk from click target up to container looking for data-wikilink
    let el = e.target as HTMLElement | null;
    while (el && el !== containerRef) {
      if (el.dataset?.wikilink) {
        e.preventDefault();
        e.stopPropagation();
        el.dispatchEvent(new CustomEvent('garden-navigate', {
          bubbles: true,
          detail: {
            target: el.dataset.wikilink,
            splitDirection: e.shiftKey ? 'vertical' : undefined,
          },
        }));
        return;
      }
      el = el.parentElement;
    }
  };
  return (
    <div ref={containerRef} style={{
      'border-top': `1px dashed ${V.b}`,
      'margin-top': '12px',
      'padding-top': '8px',
      'font-size': '11px',
      'font-family': V.mono,
      color: V.tf,
      display: 'flex',
      'flex-wrap': 'wrap',
      gap: '4px 12px',
    }} onClick={handleClick}>
      <Show when={props.props.inbound.length > 0}>
        <span style={{ color: V.tf }}>referenced by </span>
        <For each={props.props.inbound}>
          {(link) => (
            <span class="bbs-wikilink" data-wikilink={link} style={{ cursor: 'pointer' }}>
              [[{link}]]
            </span>
          )}
        </For>
      </Show>
      <Show when={props.props.outbound.length > 0}>
        <span style={{ color: V.tf }}>links to </span>
        <For each={props.props.outbound}>
          {(link) => (
            <span class="bbs-wikilink" data-wikilink={link} style={{ cursor: 'pointer' }}>
              [[{link}]]
            </span>
          )}
        </For>
      </Show>
    </div>
  );
}

export function PatternCard(props: BaseComponentProps<{
  title: string;
  type?: string;
  confidence?: string;
  content: string;
  connectsTo?: string[];
}>) {
  const [expanded, setExpanded] = createSignal(true);

  const typeColor = () => {
    switch (props.props.type) {
      case 'pattern': return V.mag;
      case 'reference': return V.cy;
      case 'field-note': return V.amb;
      default: return V.td;
    }
  };

  const confidenceIcon = () => {
    switch (props.props.confidence) {
      case 'VERIFIED': return '\u2713';
      case 'INFERRED': return '?';
      default: return '';
    }
  };

  return (
    <div style={{
      border: `1px solid ${V.b}`,
      background: V.s1,
      margin: '8px 0',
    }}>
      {/* Header */}
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
          {props.props.title}
        </span>
        <Show when={props.props.type}>
          <span style={{
            'font-size': '9px',
            'letter-spacing': '1px',
            'text-transform': 'uppercase',
            padding: '2px 6px',
            border: `1px solid ${typeColor()}40`,
            color: typeColor(),
            'font-family': V.mono,
          }}>
            {props.props.type}
          </span>
        </Show>
        <Show when={props.props.confidence}>
          <span style={{
            'font-size': '10px',
            color: props.props.confidence === 'VERIFIED' ? V.green : V.amb,
            'font-family': V.mono,
          }}>
            {confidenceIcon()} {props.props.confidence}
          </span>
        </Show>
      </div>

      {/* Body */}
      <Show when={expanded()}>
        <div style={{ padding: '12px 14px' }}>
          <div class="bbs-entry-body" innerHTML={renderMarkdown(props.props.content)} />
          {props.children}
          <Show when={props.props.connectsTo && props.props.connectsTo.length > 0}>
            <div style={{
              'border-top': `1px dashed ${V.b}`,
              'margin-top': '12px',
              'padding-top': '8px',
              'font-size': '10px',
              color: V.tf,
              'font-family': V.mono,
            }}>
              connects to{' '}
              <For each={props.props.connectsTo!}>
                {(target) => (
                  <span class="bbs-wikilink" data-wikilink={target} style={{ cursor: 'pointer' }}>
                    [[{target}]]
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// BODY STYLES (inject into document once)
// ═══════════════════════════════════════════════════════════════

export const BODY_STYLES = `
.bbs-entry-body {
  font-family: ${V.serif};
  font-size: 16px;
  color: ${V.td};
  line-height: 1.65;
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

/** Call once to inject body styles into the document */
export function injectBodyStyles() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('[data-bbs-entry-styles]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-bbs-entry-styles', '');
  style.textContent = BODY_STYLES;
  document.head.appendChild(style);
}
