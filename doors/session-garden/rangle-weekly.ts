/**
 * Rangle Weekly spec builder
 *
 * Transforms rangle-weekly markdown files into Entry[] for the garden viewer.
 * Weekly tracker becomes a 'synthesis' type entry, daily headlines become 'bbs-source'.
 *
 * Usage from garden:: door:
 *   garden:: rangle W12    → render W12 weekly view
 *   garden:: rangle        → render current week
 */

import type { Entry } from './session-garden';

interface RangleWeekData {
  week: string;            // e.g. "W12"
  dates: string;           // e.g. "2026-03-16 to 2026-03-22"
  trackerContent: string;  // raw markdown of weekly tracker
  headlines: {
    day: string;           // e.g. "tuesday"
    date: string;          // e.g. "2026-03-17"
    content: string;       // raw markdown
  }[];
  status?: string;
}

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

/**
 * Convert rangle weekly data to Entry[] for the garden viewer
 */
export function rangleWeekToEntries(data: RangleWeekData): Entry[] {
  const entries: Entry[] = [];

  // Weekly tracker as synthesis entry
  entries.push({
    id: `tracker-${data.week}`,
    type: 'synthesis',
    title: `${data.week} Weekly Tracker`,
    tags: [data.week.toLowerCase(), 'rangle', 'pharmacy'],
    content: data.trackerContent,
    date: data.dates.split(' to ')[0] || data.dates,
    author: 'evan',
    refs: data.headlines.map(h => `headline-${h.day}`),
  });

  // Daily headlines as bbs-source entries
  const sorted = [...data.headlines].sort((a, b) => {
    const ai = DAY_ORDER.indexOf(a.day.toLowerCase());
    const bi = DAY_ORDER.indexOf(b.day.toLowerCase());
    return ai - bi;
  });

  for (const headline of sorted) {
    const dayLabel = headline.day.charAt(0).toUpperCase() + headline.day.slice(1);
    entries.push({
      id: `headline-${headline.day}`,
      type: 'bbs-source',
      title: `${dayLabel} — ${headline.date}`,
      tags: [data.week.toLowerCase(), headline.day, 'pharmacy'],
      content: headline.content,
      date: headline.date,
      author: 'evan',
      board: 'rangle-weekly',
      refs: [`tracker-${data.week}`],
    });
  }

  return entries;
}

/**
 * Parse frontmatter + body from a markdown file content string
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return { meta, body: raw };

  let i = 1;
  while (i < lines.length && lines[i].trim() !== '---') {
    const match = lines[i].match(/^(\w+):\s*(.+)$/);
    if (match) meta[match[1]] = match[2].trim();
    i++;
  }
  const body = lines.slice(i + 1).join('\n').trim();
  return { meta, body };
}

/**
 * Build RangleWeekData from raw file contents (as fetched by the door execute)
 */
export function parseRangleWeekFiles(
  trackerRaw: string,
  headlineFiles: { filename: string; content: string }[],
): RangleWeekData {
  const tracker = parseFrontmatter(trackerRaw);

  const headlines = headlineFiles.map(f => {
    const parsed = parseFrontmatter(f.content);
    // Extract day from filename: 2026-03-17-tuesday-headlines.md → tuesday
    const dayMatch = f.filename.match(/\d{4}-\d{2}-\d{2}-(\w+)-headlines/);
    const day = dayMatch?.[1] || parsed.meta.day || 'unknown';
    // Extract date
    const dateMatch = f.filename.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch?.[1] || '';

    return { day, date, content: parsed.body };
  });

  return {
    week: tracker.meta.week || 'W??',
    dates: tracker.meta.dates || '',
    trackerContent: tracker.body,
    headlines,
    status: tracker.meta.status,
  };
}
