import { For, Show } from 'solid-js';
import { exec } from '@floatty/stdlib';

interface TimelogEntry {
  time: string;
  proj: string;
  desc: string;
}

interface Arc {
  name: string;
  range: string;
  proj: string;
  summary: string;
}

interface DayData {
  date: string;
  weekLabel: string;
  dayLabel: string;
  timelog: TimelogEntry[];
  arcs: Arc[];
  refs: string[];
}

const PROJ_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  floatty:    { bg: '#1a2820', border: '#3a6840', text: '#60c880' },
  rangle:     { bg: '#281a1a', border: '#683a3a', text: '#c86060' },
  'float-hub':{ bg: '#201a28', border: '#583a68', text: '#b060c8' },
  float:      { bg: '#1a2028', border: '#3a5068', text: '#6090c8' },
  'float-av': { bg: '#282018', border: '#685838', text: '#c8a060' },
};

function projColor(proj: string) {
  const key = Object.keys(PROJ_COLORS).find(k => proj?.startsWith(k) || proj === k);
  return PROJ_COLORS[key || ''] || { bg: '#1a2028', border: '#3a5068', text: '#6090c8' };
}

function ProjBadge(props: { proj: string }) {
  const c = () => projColor(props.proj);
  return (
    <span style={{
      background: c().bg,
      border: `1px solid ${c().border}`,
      'border-radius': '2px',
      color: c().text,
      'font-size': '0.65rem',
      padding: '0 4px',
      'flex-shrink': '0',
      'white-space': 'nowrap',
    }}>
      {props.proj}
    </span>
  );
}

function DailyView(props: any) {
  const days = (): DayData[] => props.data?.days ?? [];

  return (
    <div style={{
      padding: '0.75rem',
      'font-family': 'JetBrains Mono, monospace',
      'font-size': '0.8rem',
      color: 'var(--color-text)',
      height: '100%',
      'overflow-y': 'auto',
      'box-sizing': 'border-box',
    }}>
      <Show when={days().length === 0}>
        <div style={{ color: 'var(--color-ansi-bright-black)' }}>no entries found</div>
      </Show>

      <For each={days()}>
        {(day) => (
          <div style={{ 'margin-bottom': '1.25rem' }}>

            {/* Day header — navigates to day page */}
            <div
              style={{
                display: 'flex',
                'align-items': 'baseline',
                gap: '0.4rem',
                cursor: 'pointer',
                padding: '1px 4px',
                'border-radius': '3px',
                'margin-bottom': '0.25rem',
              }}
              onClick={() => props.onNavigate(day.date, { type: 'page' })}
              title={`navigate to ${day.date}`}
            >
              <span style={{ color: 'var(--color-ansi-bright-black)', 'font-size': '0.7rem' }}>●</span>
              <span style={{ color: 'var(--color-ansi-blue)', 'font-weight': '600' }}>{day.dayLabel}</span>
              <span style={{ color: 'var(--color-ansi-bright-black)', 'font-size': '0.7rem' }}>{day.weekLabel}</span>
            </div>

            {/* Timelog entries */}
            <For each={day.timelog}>
              {(entry) => (
                <div style={{
                  display: 'flex',
                  'align-items': 'baseline',
                  gap: '0.4rem',
                  'padding-left': '1.25rem',
                  'padding-top': '1px',
                  'padding-bottom': '1px',
                }}>
                  <span style={{ color: 'var(--color-ansi-bright-black)', 'font-size': '0.65rem', 'flex-shrink': '0' }}>·</span>
                  <span style={{ color: 'var(--color-ansi-bright-black)', 'font-size': '0.7rem', 'min-width': '3rem', 'flex-shrink': '0' }}>
                    {entry.time}
                  </span>
                  <Show when={entry.proj}>
                    <ProjBadge proj={entry.proj} />
                  </Show>
                  <span style={{ color: 'var(--color-text)', 'font-size': '0.75rem', 'word-break': 'break-word' }}>
                    {entry.desc}
                  </span>
                </div>
              )}
            </For>

            {/* Arcs */}
            <For each={day.arcs}>
              {(arc) => (
                <div style={{ 'padding-left': '1.25rem', 'margin-top': '0.3rem' }}>
                  <div style={{ display: 'flex', 'align-items': 'baseline', gap: '0.4rem', 'flex-wrap': 'wrap' }}>
                    <span style={{ color: 'var(--color-ansi-bright-black)', 'font-size': '0.65rem', 'flex-shrink': '0' }}>▸</span>
                    <span style={{ color: 'var(--color-ansi-cyan)', 'font-size': '0.75rem' }}>{arc.name}</span>
                    <span style={{ color: 'var(--color-ansi-bright-black)', 'font-size': '0.65rem', 'white-space': 'nowrap' }}>({arc.range})</span>
                    <Show when={arc.proj}>
                      <ProjBadge proj={arc.proj} />
                    </Show>
                  </div>
                  <Show when={arc.summary}>
                    <div style={{
                      'padding-left': '1.25rem',
                      color: 'var(--color-ansi-bright-black)',
                      'font-size': '0.7rem',
                      'margin-top': '1px',
                    }}>
                      {arc.summary}
                    </div>
                  </Show>
                </div>
              )}
            </For>

            {/* Refs */}
            <Show when={day.refs.length > 0}>
              <div style={{
                display: 'flex',
                'align-items': 'center',
                gap: '0.3rem',
                'flex-wrap': 'wrap',
                'padding-left': '1.25rem',
                'margin-top': '0.3rem',
              }}>
                <span style={{ color: 'var(--color-ansi-bright-black)', 'font-size': '0.65rem' }}>→</span>
                <For each={day.refs}>
                  {(ref) => (
                    <span
                      style={{
                        background: '#1a2030',
                        border: '1px solid #2a3040',
                        'border-radius': '3px',
                        color: 'var(--color-ansi-cyan)',
                        'font-size': '0.65rem',
                        padding: '1px 5px',
                        cursor: 'pointer',
                      }}
                      onClick={() => props.onNavigate(ref, { type: 'page' })}
                      title={`navigate to ${ref}`}
                    >
                      [[{ref}]]
                    </span>
                  )}
                </For>
              </div>
            </Show>

          </div>
        )}
      </For>
    </div>
  );
}

// ── Parsing helpers ──────────────────────────────────────────────

function getISOWeek(d: Date): number {
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
  return Math.ceil((d.getTime() - monday.getTime()) / 604800000 + 1);
}

function parseTimelog(section: string): TimelogEntry[] {
  const entries: TimelogEntry[] = [];
  for (const line of section.split('\n')) {
    // Format: "  HH:MM  proj  desc" or "  HH:MM              desc"
    const m = line.match(/^ {2}(\d{1,2}:\d{2})(.*)$/);
    if (!m) continue;
    const rest = m[2];
    // Try to extract project: 2+ spaces, word chars (with /), 2+ spaces, desc
    const withProj = rest.match(/^ {2,}([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?) {2,}(.+)$/);
    if (withProj) {
      entries.push({ time: m[1], proj: withProj[1], desc: withProj[2].trim() });
    } else {
      const noProj = rest.match(/^ {2,}(.+)$/);
      if (noProj) entries.push({ time: m[1], proj: '', desc: noProj[1].trim() });
    }
  }
  return entries;
}

function parseArcs(section: string): Arc[] {
  const arcs: Arc[] = [];
  const blocks = section.split(/(?=^### )/m).filter(b => b.startsWith('### '));
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0].match(/^### (.+?) \(([^)]+)\)(?: \[project::([^\]]+)\])?/);
    if (!header) continue;
    const name = header[1].trim();
    const range = header[2].trim();
    const proj = header[3] || '';
    // First non-empty, non-header, non-bullet line after header = summary
    const summary = lines.slice(1).find(l => {
      const t = l.trim();
      return t && !t.startsWith('-') && !t.startsWith('*') && !t.startsWith('#') && !t.startsWith('[');
    })?.trim() || '';
    arcs.push({ name, range, proj, summary });
  }
  return arcs;
}

function parseRefs(section: string): string[] {
  const refs: string[] = [];
  for (const m of section.matchAll(/\[\[([^\]]+)\]\]/g)) {
    refs.push(m[1]);
  }
  return refs;
}

function extractSection(raw: string, header: string): string {
  const re = new RegExp(`^## ${header}\\s*\\n([\\s\\S]*?)(?=\\n---\\n|\\n## [a-z]|$)`, 'm');
  return raw.match(re)?.[1] ?? '';
}

// ── Door definition ──────────────────────────────────────────────

export const door = {
  kind: 'view' as const,
  prefixes: ['dailylog::'],

  async execute(blockId: string, content: string, ctx: any) {
    const rawArg = content.replace(/^dailylog::\s*/i, '').trim().toLowerCase();

    let count = 7;
    let dateFilter: string | null = null;
    let projectFilter: string | null = null;

    if (rawArg) {
      if (/^\d+$/.test(rawArg)) {
        count = Math.min(parseInt(rawArg, 10), 60);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawArg)) {
        dateFilter = rawArg;
        count = 1;
      } else if (rawArg === 'today') {
        count = 1;
      } else if (rawArg === 'week') {
        count = 7;
      } else {
        projectFilter = rawArg;
        count = 14;
      }
    }

    const fileList = await exec(
      `ls -1t ~/.evans-notes/daily/*.md 2>/dev/null | head -${count * 2}`
    ).catch(() => '');

    if (!fileList.trim()) return { data: { days: [] } };

    const files = fileList.trim().split('\n').filter(f => f.endsWith('.md'));
    const targetFiles = dateFilter
      ? files.filter(f => f.includes(dateFilter!))
      : files.slice(0, count);

    const days: DayData[] = [];

    for (const file of targetFiles) {
      const raw = await exec(`cat "${file}"`).catch(() => '');
      if (!raw) continue;

      const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
      if (!dateMatch) continue;
      const date = dateMatch[1];

      const d = new Date(date + 'T12:00:00');
      const weekLabel = `W${getISOWeek(d)}`;
      const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      let timelog = parseTimelog(extractSection(raw, 'timelog'));
      let arcs = parseArcs(extractSection(raw, 'arcs'));
      const refs = parseRefs(extractSection(raw, 'refs'));

      if (projectFilter) {
        timelog = timelog.filter(e =>
          e.proj.startsWith(projectFilter!) ||
          e.desc.toLowerCase().includes(projectFilter!)
        );
        arcs = arcs.filter(a =>
          a.proj.startsWith(projectFilter!) ||
          a.name.toLowerCase().includes(projectFilter!)
        );
      }

      if (timelog.length > 0 || arcs.length > 0) {
        days.push({ date, weekLabel, dayLabel, timelog, arcs, refs });
      }
    }

    return { data: { days: days.slice(0, count) } };
  },

  view: DailyView,
};

export const meta = { id: 'dailylog', name: 'Daily Log', version: '0.1.0', sidebarEligible: true };
