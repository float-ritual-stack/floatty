import { createSignal, onMount, onCleanup, For, Show } from 'solid-js';
import { exec } from '@floatty/stdlib';
import type { DoorViewProps } from '../door-types';

// ── Theme ──
const ACCENT = '#00ffcc';
const DIM = '#666';
const WARN = '#ffaa00';
const CARD_BG = '#111128';
const BORDER = '#1a1a3e';

// ── Types ──
interface PRItem {
  number: number;
  issue: string;
  status: string;
  notes: string;
}

interface MeetingItem {
  date: string;
  meeting: string;
  summary: string;
  details?: MeetingDetails | null;
}

interface MeetingDetails {
  decisions: string[];
  nextSteps: string[];
  participants: string[];
  duration: string;
  transcript: string;
}

interface TimelineEntry {
  time: string;
  sortKey: string; // YYYY-MM-DD HH:MM for correct dedup and chronological sort
  label: string;
}

interface DashData {
  prs: PRItem[];
  meetings: MeetingItem[];
  timeline: TimelineEntry[];
  week: string;
  headlines: string[];
  weekFocus: string;
}

// ── Parse markdown tables from rangle-weekly tracker ──

function parseMarkdownTable(text: string, sectionHeader: string): string[][] {
  const lines = text.split('\n');
  let inSection = false;
  let headerFound = false;
  const rows: string[][] = [];

  for (const line of lines) {
    if (line.trim().startsWith('## ') && line.includes(sectionHeader)) {
      inSection = true;
      continue;
    }
    if (inSection && line.trim().startsWith('## ')) break; // next section
    if (inSection && line.trim().startsWith('---') && headerFound) break; // section divider after table
    if (!inSection) continue;

    // Skip header separator (|---|---|)
    if (/^\s*\|[\s-|]+\|\s*$/.test(line)) { headerFound = true; continue; }
    // Skip the header row itself
    if (!headerFound && line.includes('|')) { headerFound = false; continue; }
    // Parse data rows
    if (headerFound && line.includes('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length >= 2) rows.push(cells);
    }
  }
  return rows;
}

function parsePRTable(text: string): PRItem[] {
  const rows = parseMarkdownTable(text, 'PRs Status');
  return rows.map(cells => {
    // cells: [PR, Issue, Status, Notes]
    const prMatch = (cells[0] || '').match(/#(\d+)/);
    const number = prMatch ? parseInt(prMatch[1]) : 0;
    const issue = (cells[1] || '').replace(/\[\[|\]\]/g, '').replace(/\[issue::\d+\]\s*/g, '').trim();
    const rawStatus = (cells[2] || '').replace(/\*\*/g, '').trim();

    let status = 'open';
    if (/merged/i.test(rawStatus)) status = 'merged';
    else if (/review/i.test(rawStatus)) status = 'review';
    else if (/approved/i.test(rawStatus)) status = 'open';

    const notes = (cells[3] || '').trim();
    return { number, issue, status, notes };
  }).filter(p => p.number > 0);
}

function parseMeetingTable(text: string): MeetingItem[] {
  const rows = parseMarkdownTable(text, 'Meetings');
  return rows.map(cells => ({
    date: (cells[0] || '').trim(),
    meeting: (cells[1] || '').trim(),
    summary: (cells[2] || '').replace(/\[\[|\]\]/g, '').trim(),
  })).filter(m => m.date);
}

function parseHeadlines(text: string): string[] {
  const lines = text.split('\n');
  let inSection = false;
  const headlines: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('## Daily Headlines')) { inSection = true; continue; }
    if (inSection && line.trim().startsWith('## ')) break;
    if (inSection && line.trim().startsWith('- ')) {
      headlines.push(line.trim().replace(/^-\s*/, '').replace(/\[\[|\]\]/g, ''));
    }
  }
  return headlines;
}

function parseWeekFocus(text: string): string {
  const lines = text.split('\n');
  let inSection = false;
  const focusLines: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('## Week Focus')) { inSection = true; continue; }
    if (inSection && line.trim().startsWith('## ')) break;
    if (inSection && line.trim().startsWith('---')) break;
    if (inSection && line.trim()) focusLines.push(line.trim());
  }
  // Just grab the first meaningful line
  return focusLines.find(l => l.startsWith('**')) || focusLines[0] || '';
}

// ── Load meeting details from summary files ──

async function loadMeetingDetails(weekDir: string, meeting: MeetingItem): Promise<MeetingDetails | null> {
  try {
    // Extract date from meeting.date (e.g. "Mar 17 @ 1:00 PM" → "03-17", or "2026-03-17" → "03-17")
    const monthMap: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    let datePrefix = '';
    const namedMatch = meeting.date.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})/i);
    if (namedMatch) {
      const mm = monthMap[namedMatch[1].toLowerCase()] || '01';
      const dd = namedMatch[2].padStart(2, '0');
      datePrefix = `${new Date().getFullYear()}-${mm}-${dd}`;
    }
    const isoMatch = meeting.date.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) datePrefix = isoMatch[1];

    if (!datePrefix) return null;

    // List all meeting files matching this date
    const files = await exec(
      `ls $HOME/float-hub/float.dispatch/boards/rangle-weekly/meetings/ 2>/dev/null | grep "^${datePrefix}" | head -10`
    ) || '';

    if (!files.trim()) return null;

    // Match by meeting type keyword in filename
    const keyword = meeting.meeting.toLowerCase().replace(/\s+/g, '-').slice(0, 15);
    const fileList = files.split('\n').filter(f => f.trim());
    const matchFile = fileList.find(f => f.toLowerCase().includes(keyword)) || fileList[0];

    if (!matchFile) return null;

    const content = await exec(
      `cat "$HOME/float-hub/float.dispatch/boards/rangle-weekly/meetings/${matchFile.trim()}" 2>/dev/null`
    ) || '';

    if (!content) return null;

    // Parse key sections
    const decisions: string[] = [];
    const nextSteps: string[] = [];
    let participants: string[] = [];
    let duration = '';
    let transcript = '';

    const lines = content.split('\n');
    let section = '';

    for (const line of lines) {
      // Frontmatter parsing
      if (line.startsWith('participants:')) {
        participants = line.replace('participants:', '').replace(/[\[\]]/g, '').split(',').map(s => s.trim());
      }
      if (line.startsWith('duration:')) {
        duration = line.replace('duration:', '').trim();
      }

      // Section detection — numbered ### N. headers are excluded so they fall through
      // to the h3 regex below (which captures them as decisions in Scott sync format).
      if (line.startsWith('## Key Decisions') || (line.startsWith('### ') && !/^### \d+\./.test(line))) {
        section = line.includes('Decision') ? 'decisions' :
                  line.includes('Next') ? 'next' :
                  line.includes('Transcript') ? 'transcript' : section;
        continue;
      }
      if (line.startsWith('## ') && !line.includes('Key')) {
        if (line.includes('Next')) section = 'next';
        else if (line.includes('Transcript')) section = 'transcript';
        else section = '';
      }

      // Collect items
      const bullet = line.match(/^[-*]\s+\[?\s*\]?\s*(.+)/);
      if (bullet) {
        if (section === 'decisions') decisions.push(bullet[1].trim());
        else if (section === 'next') nextSteps.push(bullet[1].trim());
      }

      // Grab ### headers as decisions too (Scott sync format)
      const h3 = line.match(/^### \d+\.\s+(.+)/);
      if (h3 && section === 'decisions') decisions.push(h3[1].trim());

      // Transcript path
      if (line.includes('`') && (line.includes('transcript') || line.includes('Transcript'))) {
        const pathMatch = line.match(/`([^`]+)`/);
        if (pathMatch) transcript = pathMatch[1];
      }
    }

    return { decisions, nextSteps, participants, duration, transcript };
  } catch {
    return null;
  }
}

// ── Parse ctx:: timeline from search hits ──

function extractTimeline(hits: any[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const seen = new Set<string>();

  for (const hit of hits) {
    const content: string = hit.content || '';
    const ctxMatch = content.match(/ctx::(\d{4}-\d{2}-\d{2})\s*@\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?)/i);
    if (!ctxMatch) continue;

    // Strip all marker syntax to get clean label
    let label = content
      .replace(/ctx::\d{4}-\d{2}-\d{2}\s*@\s*[\d:]+\s*(?:[AP]M)?\s*/gi, '')
      .replace(/\[project::[^\]]*\]/g, '')
      .replace(/\[mode::[^\]]*\]/g, '')
      .replace(/\[issue::[^\]]*\]/g, '')
      .replace(/\[slug::[^\]]*\]/g, '')
      .replace(/\[plan::[^\]]*\]/g, '')
      .replace(/\[branch::[^\]]*\]/g, '')
      .replace(/\[sc::[^\]]*\]/g, '')
      .replace(/project::\S+/g, '')
      .replace(/mode::\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!label || label.length < 5) continue;
    // Truncate long labels
    if (label.length > 120) label = label.slice(0, 117) + '...';

    const sortKey = ctxMatch[1] + ' ' + ctxMatch[2].trim();
    const key = sortKey + label.slice(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({ time: ctxMatch[2].trim(), sortKey, label });
  }

  return entries
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .slice(0, 25);
}

// ── Components ──

function StatusBadge(props: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    'merged': { bg: '#0d3320', text: '#00ff88' },
    'review': { bg: '#1a1a3e', text: '#88aaff' },
    'open': { bg: '#2a2a0a', text: WARN },
    'backlog': { bg: '#1a1a1a', text: DIM },
  };
  const c = () => colors[props.status] || colors.open;
  return (
    <span style={{
      background: c().bg, color: c().text, padding: '2px 8px',
      'border-radius': '3px', 'font-size': '11px', 'font-weight': '600',
      'text-transform': 'uppercase', 'letter-spacing': '0.5px',
    }}>{props.status}</span>
  );
}

function Section(props: { title: string; count?: number; children: any }) {
  return (
    <div style={{ 'margin-bottom': '1.5rem' }}>
      <div style={{
        display: 'flex', 'align-items': 'center', gap: '8px',
        'border-bottom': `1px solid ${BORDER}`, 'padding-bottom': '6px', 'margin-bottom': '10px',
      }}>
        <span style={{ color: ACCENT, 'font-size': '13px', 'font-weight': '700', 'letter-spacing': '1px' }}>
          {props.title}
        </span>
        <Show when={props.count != null}>
          <span style={{ color: DIM, 'font-size': '11px' }}>({props.count})</span>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

function PRCard(props: { pr: PRItem; onNavigate?: (target: string) => void }) {
  const [expanded, setExpanded] = createSignal(false);
  const borderColor = () =>
    props.pr.status === 'merged' ? '#00ff88' :
    props.pr.status === 'review' ? '#88aaff' : WARN;

  return (
    <div
      onClick={() => setExpanded(!expanded())}
      style={{
        background: CARD_BG, border: `1px solid ${BORDER}`, 'border-radius': '4px',
        padding: '8px 12px', 'margin-bottom': '6px', cursor: 'pointer',
        'border-left': `3px solid ${borderColor()}`,
      }}
    >
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
        <div>
          <span
            style={{ color: ACCENT, 'font-weight': '600', cursor: 'pointer' }}
            title="⌘-click to jump to outline"
            onClick={(e) => { if (e.metaKey || e.ctrlKey) { e.stopPropagation(); props.onNavigate?.(`PR #${props.pr.number}`); } }}
          >PR #{props.pr.number}</span>
          <Show when={props.pr.issue}>
            <span style={{ color: '#ccc', 'margin-left': '8px', 'font-size': '13px' }}>{props.pr.issue}</span>
          </Show>
        </div>
        <StatusBadge status={props.pr.status} />
      </div>
      <Show when={expanded() && props.pr.notes}>
        <div style={{ color: '#999', 'font-size': '12px', 'margin-top': '6px', 'padding-left': '8px', 'border-left': `2px solid ${BORDER}` }}>
          {props.pr.notes}
        </div>
      </Show>
    </div>
  );
}

function MeetingCard(props: { meeting: MeetingItem; weekDir: string; onNavigate: any }) {
  const [expanded, setExpanded] = createSignal(false);
  const [details, setDetails] = createSignal<MeetingDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = createSignal(false);

  const toggle = async () => {
    const willExpand = !expanded();
    setExpanded(willExpand);
    if (willExpand && !details() && !loadingDetails()) {
      setLoadingDetails(true);
      const d = await loadMeetingDetails(props.weekDir, props.meeting);
      setDetails(d);
      setLoadingDetails(false);
    }
  };

  return (
    <div style={{
      background: CARD_BG, border: `1px solid ${BORDER}`, 'border-radius': '4px',
      padding: '10px 12px', 'margin-bottom': '8px', cursor: 'pointer',
      'border-left': `3px solid ${ACCENT}`,
    }} onClick={toggle}>
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
        <span style={{ color: ACCENT, 'font-weight': '600' }}>{props.meeting.meeting}</span>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <Show when={details()?.duration}>
            <span style={{ color: DIM, 'font-size': '11px' }}>{details()!.duration}</span>
          </Show>
          <span style={{ color: DIM, 'font-size': '11px' }}>{props.meeting.date}</span>
          <span style={{ color: DIM, 'font-size': '10px' }}>{expanded() ? '▼' : '▶'}</span>
        </div>
      </div>
      <div style={{ color: '#ccc', 'font-size': '12px', 'margin-top': '4px' }}>{props.meeting.summary}</div>

      <Show when={expanded()}>
        <Show when={loadingDetails()}>
          <div style={{ color: DIM, 'font-size': '11px', 'margin-top': '8px' }}>loading details...</div>
        </Show>
        <Show when={details()}>
          <div style={{ 'margin-top': '10px', 'padding-top': '8px', 'border-top': `1px solid ${BORDER}` }}>
            <Show when={details()!.participants.length > 0}>
              <div style={{ color: DIM, 'font-size': '11px', 'margin-bottom': '6px' }}>
                {details()!.participants.join(', ')}
              </div>
            </Show>

            <Show when={details()!.decisions.length > 0}>
              <div style={{ 'margin-bottom': '8px' }}>
                <div style={{ color: ACCENT, 'font-size': '11px', 'font-weight': '700', 'margin-bottom': '4px', 'letter-spacing': '0.5px' }}>DECISIONS</div>
                <For each={details()!.decisions}>{(d) =>
                  <div style={{ color: '#ccc', 'font-size': '12px', padding: '2px 0 2px 10px', 'border-left': `2px solid ${ACCENT}`, 'margin-bottom': '2px' }}>
                    {d}
                  </div>
                }</For>
              </div>
            </Show>

            <Show when={details()!.nextSteps.length > 0}>
              <div style={{ 'margin-bottom': '8px' }}>
                <div style={{ color: WARN, 'font-size': '11px', 'font-weight': '700', 'margin-bottom': '4px', 'letter-spacing': '0.5px' }}>NEXT STEPS</div>
                <For each={details()!.nextSteps}>{(s) =>
                  <div style={{ color: '#aaa', 'font-size': '12px', padding: '2px 0 2px 10px', 'border-left': `2px solid ${WARN}`, 'margin-bottom': '2px' }}>
                    {s}
                  </div>
                }</For>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={!loadingDetails() && !details()}>
          <div style={{ color: DIM, 'font-size': '11px', 'margin-top': '8px' }}>No meeting summary file found.</div>
        </Show>
      </Show>
    </div>
  );
}

// ── Main View ──

function RangleDashView(props: DoorViewProps<DashData>) {
  const [tab, setTab] = createSignal('overview');
  const [data, setData] = createSignal<DashData>(props.data as DashData);
  const [loading, setLoading] = createSignal(true);
  const [weekNum, setWeekNum] = createSignal(0);
  const [lastMtime, setLastMtime] = createSignal('');
  const [lastRefresh, setLastRefresh] = createSignal('');

  const tabs = ['overview', 'timeline', 'meeting'];

  const currentWeekNum = () => {
    const now = new Date();
    const oneJan = new Date(now.getFullYear(), 0, 1);
    return Math.ceil(((now.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) / 7);
  };

  const trackerPath = (wNum: number) => {
    const year = new Date().getFullYear();
    const weekDir = `${year}-W${wNum}`;
    return `$HOME/float-hub/float.dispatch/boards/rangle-weekly/${weekDir}/${weekDir}-rangle-weekly.md`;
  };

  const loadWeek = async (wNum: number, silent?: boolean) => {
    if (!silent) setLoading(true);
    setWeekNum(wNum);
    const year = new Date().getFullYear();
    const weekStr = `W${wNum}`;
    const weekDir = `${year}-${weekStr}`;

    try {
      // Check mtime — skip tracker re-parse if unchanged, but always refresh timeline
      const mtime = (await exec(`stat -f '%m' ${trackerPath(wNum)} 2>/dev/null`))?.trim() || '';
      const trackerUnchanged = silent && mtime && mtime === lastMtime();
      if (!trackerUnchanged) setLastMtime(mtime);

      const now = new Date();
      setLastRefresh(`${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`);

      // Parse tracker content only when it has changed
      let prs = data()?.prs ?? [];
      let meetings = data()?.meetings ?? [];
      let headlines = data()?.headlines ?? [];
      let weekFocus = data()?.weekFocus ?? '';

      if (!trackerUnchanged) {
        const trackerContent = await exec(
          `cat ${trackerPath(wNum)} 2>/dev/null || echo ""`
        ) || '';

        if (!trackerContent.trim()) {
          setData({ prs: [], meetings: [], timeline: [], headlines: [], week: weekStr, weekFocus: `No tracker found for ${weekDir}` });
          setLoading(false);
          return;
        }

        prs = parsePRTable(trackerContent);
        meetings = parseMeetingTable(trackerContent);
        headlines = parseHeadlines(trackerContent);
        weekFocus = parseWeekFocus(trackerContent);
      }

      // Always refresh timeline — ctx:: markers update independently of tracker file
      const daysBack = (currentWeekNum() - wNum) * 7 + 7;
      const daysStart = (currentWeekNum() - wNum) * 7;
      const cutoffStart = Math.floor(Date.now() / 1000) - (daysBack * 86400);
      const cutoffEnd = Math.floor(Date.now() / 1000) - (daysStart * 86400);
      let timeline: TimelineEntry[] = [];

      if (wNum === currentWeekNum()) {
        // Current week: just use recent
        const searchUrl = `/api/v1/search?q=&marker_type=project&marker_val=rangle%2Fpharmacy&ctx_after=${cutoffStart}&limit=40&include_metadata=true`;
        const resp = await props.server.fetch(searchUrl);
        const searchData = await resp.json();
        timeline = extractTimeline(searchData.hits || []);
      } else {
        // Past week: use date range
        const searchUrl = `/api/v1/search?q=&marker_type=project&marker_val=rangle%2Fpharmacy&ctx_after=${cutoffStart}&ctx_before=${cutoffEnd}&limit=40&include_metadata=true`;
        const resp = await props.server.fetch(searchUrl);
        const searchData = await resp.json();
        timeline = extractTimeline(searchData.hits || []);
      }

      setData({ prs, meetings, timeline, headlines, week: weekStr, weekFocus });
      setLoading(false);
    } catch (e: any) {
      setData(d => ({ ...(d || {} as DashData), week: weekStr, weekFocus: `Error: ${e.message}` }));
      setLoading(false);
    }
  };

  onMount(() => {
    loadWeek(currentWeekNum());
    // Poll for changes every 30s
    const interval = setInterval(() => {
      const wNum = weekNum();
      if (wNum > 0) loadWeek(wNum, true); // silent refresh
    }, 30_000);
    onCleanup(() => clearInterval(interval));
  });

  const openPRs = () => (data()?.prs || []).filter(p => p.status !== 'merged');
  const mergedPRs = () => (data()?.prs || []).filter(p => p.status === 'merged');

  return (
    <div style={{
      color: '#e0e0e0', 'font-family': 'JetBrains Mono, Fira Code, monospace',
      'font-size': '13px', padding: '0.75rem', 'min-height': '0',
      overflow: 'auto',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '0.75rem' }}>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <span
            style={{ color: weekNum() > 1 ? ACCENT : BORDER, cursor: weekNum() > 1 ? 'pointer' : 'default', 'font-size': '13px', padding: '0 4px' }}
            onClick={() => { if (weekNum() > 1) loadWeek(weekNum() - 1); }}
          >{'<<'}</span>
          <span style={{ color: ACCENT, 'font-weight': '700', 'font-size': '15px' }}>rangle/pharmacy</span>
          <span
            style={{ color: DIM, cursor: 'pointer', 'text-decoration': 'none' }}
            title="⌘-click to jump to outline"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) {
                const w = weekNum();
                props.onNavigate?.(`${new Date().getFullYear()}-W${w}-rangle-weekly`, { type: 'page' });
              }
            }}
          >{data()?.week || '...'}</span>
          <span
            style={{ color: weekNum() < currentWeekNum() ? ACCENT : BORDER, cursor: weekNum() < currentWeekNum() ? 'pointer' : 'default', 'font-size': '13px', padding: '0 4px' }}
            onClick={() => { if (weekNum() < currentWeekNum()) loadWeek(weekNum() + 1); }}
          >{'>>'}</span>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <For each={tabs}>
            {(t) => (
              <button
                onClick={() => setTab(t)}
                style={{
                  background: tab() === t ? '#1a1a3e' : 'transparent',
                  color: tab() === t ? ACCENT : DIM,
                  border: `1px solid ${tab() === t ? ACCENT : BORDER}`,
                  padding: '3px 10px', 'border-radius': '3px', cursor: 'pointer',
                  'font-size': '11px', 'font-family': 'inherit', 'text-transform': 'uppercase',
                }}
              >{t}</button>
            )}
          </For>
        </div>
      </div>

      {/* Week Focus */}
      <Show when={data()?.weekFocus}>
        <div style={{
          color: '#aaa', 'font-size': '12px', 'margin-bottom': '0.75rem',
          'padding-left': '8px', 'border-left': `2px solid ${ACCENT}`,
        }}>
          {data()!.weekFocus}
        </div>
      </Show>

      <Show when={loading()}>
        <div style={{ color: DIM, padding: '2rem', 'text-align': 'center' }}>loading from rangle-weekly...</div>
      </Show>

      <Show when={!loading()}>
        {/* Overview Tab */}
        <Show when={tab() === 'overview'}>
          <Show when={openPRs().length > 0}>
            <Section title="ACTIVE PRS" count={openPRs().length}>
              <For each={openPRs()}>{(pr) =>
                <PRCard pr={pr} onNavigate={(t) => props.onNavigate?.(t, { type: 'page' })} />
              }</For>
            </Section>
          </Show>
          <Show when={mergedPRs().length > 0}>
            <Section title="MERGED" count={mergedPRs().length}>
              <For each={mergedPRs()}>{(pr) =>
                <PRCard pr={pr} onNavigate={(t) => props.onNavigate?.(t, { type: 'page' })} />
              }</For>
            </Section>
          </Show>
          <Show when={(data()?.headlines || []).length > 0}>
            <Section title="HEADLINES">
              <For each={data()!.headlines}>{(h) =>
                <div style={{ color: '#ccc', padding: '2px 0', 'font-size': '12px' }}>{h}</div>
              }</For>
            </Section>
          </Show>
        </Show>

        {/* Timeline Tab */}
        <Show when={tab() === 'timeline'}>
          <Section title="RECENT CTX:: ACTIVITY">
            <div style={{ 'padding-left': '8px' }}>
              <For each={data()?.timeline || []}>
                {(entry) => (
                  <div style={{
                    display: 'flex', gap: '12px', padding: '3px 0',
                    'border-left': `2px solid ${BORDER}`, 'padding-left': '12px', 'margin-left': '4px',
                  }}>
                    <span style={{ color: ACCENT, 'min-width': '85px', 'flex-shrink': '0', 'font-size': '12px' }}>{entry.time}</span>
                    <span style={{ color: '#ccc', 'font-size': '12px' }}>{entry.label}</span>
                  </div>
                )}
              </For>
              <Show when={(data()?.timeline || []).length === 0}>
                <div style={{ color: DIM }}>No ctx:: entries found.</div>
              </Show>
            </div>
          </Section>
        </Show>

        {/* Meeting Tab */}
        <Show when={tab() === 'meeting'}>
          <For each={data()?.meetings || []}>
            {(m) => <MeetingCard meeting={m} weekDir={`${new Date().getFullYear()}-${data()?.week || 'W0'}`} onNavigate={props.onNavigate} />}
          </For>
          <Show when={(data()?.meetings || []).length === 0}>
            <div style={{ color: DIM, padding: '1rem' }}>No meetings logged this week.</div>
          </Show>
        </Show>
      </Show>

      <div style={{ color: DIM, 'font-size': '10px', 'margin-top': '1.5rem', 'border-top': `1px solid ${BORDER}`, 'padding-top': '6px' }}>
        rd:: — live from rangle-weekly + outline ctx:: · refreshed {lastRefresh() || '...'}
      </div>
    </div>
  );
}

// ── Door contract ──

export const door = {
  kind: 'view' as const,
  prefixes: ['rd::'],
  async execute(blockId: string, content: string, ctx: any) {
    const arg = content.replace(/^rd::\s*/i, '').trim();
    const days = parseInt(arg) || 7;
    return { data: { dateRange: String(days) } };
  },
  view: RangleDashView,
};

export const meta = {
  id: 'rangle-dash',
  name: 'Rangle Dashboard',
  version: '0.3.0',
  sidebarEligible: true,
};
