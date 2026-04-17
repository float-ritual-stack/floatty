# Weekly Zine Door — Spec v2 (Nuked and Rebuilt)

## The Job

"What the fuck did I ship this week" — at a glance, with doors to everything.

Not a design exercise. Not a neon rave. A **weekly digest that links into the work.**

## What Failed in v1

1. **Blinding green** — #00ff41 at full saturation on black bg = WCAG failure, retina damage, can't read anything else on screen after looking at it
2. **Shallow content** — "PR #1671 — Build fix merged" tells you nothing. The actual story: "BMIData {bmi: null} was truthy, breaking navigation. Replaced with isEmptyValue() guard. 8 new tests."
3. **No doors** — The entire point was clickable links to GitHub PRs, Linear issues, outline blocks. Zero were wired.
4. **No data pipeline** — Hand-typed JSON manifest. Should pull from: GitHub PRs (gh CLI), Linear issues, floatty outline, daily notes, evna context
5. **Aesthetic over utility** — TUIBox glow shadows, phosphorus green, scanlines. Nobody asked for CRT cosplay.

## Design Principles (v2)

### 1. Readable First

- **Background**: `#0a0a0a` or `#111` — fine
- **Body text**: `#a1a1aa` (zinc-400) — readable on dark
- **Accent colors**: Muted. `#4ade80` not `#00ff41`. `#c084fc` not `#ff00ff`. Think IDE syntax highlighting, not rave poster.
- **Headings**: White or near-white. Not neon.
- **Contrast ratio**: All text must pass WCAG AA (4.5:1 for body, 3:1 for large text)
- **No glow-text**: No `text-shadow` blurs. No `box-shadow` neon glow. Clean type.

### 2. Content Depth

Each PR/item needs:
- **Title with number**: `#1671 — fix(assessment-flow): block BMI switch routing`
- **One-liner why**: What was broken and how it was fixed (not "build fix merged")
- **Scope**: Files changed, tests added, lines delta
- **Links**: GitHub PR URL, Linear issue if exists, outline block if exists

### 3. Everything is a Door

A "door" = clickable element that fires chirp to navigate somewhere:
- **PR number** → GitHub PR URL (opens in browser via chirp)
- **Issue number** → Linear issue URL or outline block
- **Outline ref** → chirp::navigate to block ID in outliner
- **Page ref** → chirp::navigate_page

If it has an ID, it's a door. If it's not a door, ask why it's in the zine.

### 4. Repeatable Pipeline

The zine data should be **assembled**, not hand-written:

```
Sources:
  gh pr list --state merged --search "merged:>=2026-03-01" --json number,title,body,additions,deletions
  gh pr list --state open --json number,title,body
  Linear issues updated this week (list_issues updatedAt)
  floatty outline: search for y2026wNN tag
  Daily notes: grep timelog for the week
  evna: active_context query for the week

Assembly:
  Script reads sources → produces w{NN}.ts
  Human curates: reorder, add narrative, pick highlights
  NOT: human types JSON by hand
```

### 5. Scannable Structure

```
HEADER: "This Week in Float — W10 · Mar 1-6, 2026"

STATS BAR: 8 PRs shipped | v0.8.0 released | 6600w history doc
           (horizontal, compact, one line of numbers)

SECTION: Rangle/Pharmacy
  PR #1682 — feat: visual grouping for assessment builder
    xyflow parentId nesting, non-destructive delete, single-level lock
    +948 -61 · 10 files · 381 tests pass
    [GitHub] [#1530]

  PR #1671 — fix: block BMI switch routing until both inputs
    BMIData {bmi: null} was truthy, breaking navigation
    +11 -7 · 3 files · 8 new tests
    [GitHub] [#1528]

  ... (each PR is 3-4 lines max)

SECTION: Floatty
  v0.8.0 released — doors, chirp, pane linking, context API
    [changelog] [FLO-223] [FLO-338] [FLO-283]

  ...

SECTION: Infrastructure
  ...

SECTION: Sacred Chaos (optional, short)
  ...

FOOTER: float.dispatch · y2026w10 · shacks not cathedrals
```

### 6. No TUIBox

The bordered-box-with-title-badge pattern adds visual noise without information. Replace with:
- Section headers: bold text + thin separator line
- PR entries: left-border accent (2px, muted color) + content
- Stats: inline horizontal bar, not individual cards
- Tags: small, muted, inline after description — not neon pills

## Color Palette (v2)

```
bg:           #0a0a0a
surface:      #161616
border:       #262626
text-primary: #e4e4e7 (zinc-200)
text-body:    #a1a1aa (zinc-400)
text-muted:   #71717a (zinc-500)

accent-green:   #4ade80  (for: shipped/merged status)
accent-orange:  #fb923c  (for: floatty section)
accent-blue:    #60a5fa  (for: infra section)
accent-purple:  #c084fc  (for: chaos section)
accent-yellow:  #fbbf24  (for: warnings, open PRs)
accent-red:     #f87171  (for: bugs, critical)
```

All accents are Tailwind 400-weight. Readable on #0a0a0a. No neon.

## Data Schema (v2)

```ts
interface WeekData {
  week: string;
  dateRange: string;
  stats: StatItem[];        // top-level summary stats
  sections: Section[];
}

interface StatItem {
  label: string;
  value: string;
}

interface Section {
  id: string;
  title: string;
  accent: string;           // from muted palette
  items: ShipItem[];
}

interface ShipItem {
  type: 'pr' | 'release' | 'entry' | 'quote';
  title: string;            // e.g. "#1682 — feat: visual grouping"
  summary: string;          // the WHY — from PR body, not hand-typed
  scope?: string;           // "+948 -61 · 10 files · 381 tests"
  doors: Door[];            // everything clickable
  tags?: string[];          // small, muted, inline
  status?: 'merged' | 'open' | 'fixed' | 'shipped';
  highlight?: boolean;      // top 3 items get brighter border / larger text
}

interface Door {
  label: string;            // "GitHub" | "FLO-223" | "#1528" | "changelog"
  type: 'github' | 'linear' | 'outline-block' | 'outline-page';
  target: string;           // URL or block ID or page name
}
```

## Assembly Script (Future)

```bash
#!/bin/bash
# assemble-week.sh W10 2026-03-01 2026-03-06
# Produces: src/data/w10.ts

WEEK=$1; START=$2; END=$3

# 1. GitHub PRs
gh pr list --repo pharmonline/pharmacy-online \
  --state merged --search "merged:>=$START" \
  --json number,title,body,additions,deletions,mergedAt \
  > /tmp/zine-prs-merged.json

gh pr list --repo pharmonline/pharmacy-online \
  --state open --author @me \
  --json number,title,body,additions,deletions \
  > /tmp/zine-prs-open.json

# 2. Floatty PRs
gh pr list --repo float-ritual-stack/floatty \
  --state merged --search "merged:>=$START" \
  --json number,title,body \
  > /tmp/zine-floatty-prs.json

# 3. Linear issues (explicit — not "via skill")
# mcp__claude_ai_Linear__list_issues with project:"floatty", updatedAt:"$START"
# OR via graphql:
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ issues(filter:{project:{name:{eq:\"floatty\"}},updatedAt:{gte:\"'$START'\"}}) { nodes { identifier title state { name } url } } }"}' \
  > /tmp/zine-linear.json

# 4. Outline block IDs (for door targets)
# Search floatty API for PR numbers and issue numbers to get block IDs
KEY=$(grep api_key ~/.floatty/config.toml | cut -d'"' -f2)
PORT=$(grep server_port ~/.floatty/config.toml | cut -d= -f2 | tr -d ' ')
for PR in 1682 1671 1676 1678 1664 1656 1648 1633 1631 1607; do
  curl -s -H "Authorization: Bearer $KEY" \
    "http://127.0.0.1:$PORT/api/v1/search?q=%23${PR}&limit=3" \
    >> /tmp/zine-outline-blocks.json
done

# 5. Merge into w{NN}.ts template
# (human curates the output)
```

## Pipeline Rule: body → summary (CRITICAL)

The PR body already contains the summary. The v1 failure was kitty having the body in context and still writing "Build fix merged." The pipeline must be explicit:

```
gh pr body field → ShipItem.summary
```

Not "human writes summary." Not "kitty interprets." The PR description IS the summary. The pipeline extracts the first paragraph or `## Summary` section from the body. If no summary section, take the first 2 sentences.

For non-PR items (releases, entries), the assembly script pulls from:
- Release: changelog or sysops-log post
- Entry: outline block content
- Quote: literal text

## Curation Workflow

After assembly produces `src/data/w10-raw.ts`:

1. Copy to `w10.ts`
2. **Delete** entries that aren't highlights (e.g., trivial typo fixes)
3. **Reorder** within sections (most impactful first)
4. **Set `highlight: true`** on the 3 biggest items
5. **Punch up** 1-2 summaries if the PR body was too technical
6. **Verify doors** — every `target` should be a real URL or block ID

That's it. 5 minutes of editing, not 30 minutes of hand-typing JSON.

## Door Visual Pattern

Not buttons. Bracketed glyphs that change color on hover:

```
#1682 — feat: visual grouping for assessment builder
  xyflow parentId nesting, non-destructive delete, single-level lock
  +948 -61 · 10 files · 381 tests
  [GH] [#1530] [FLO-223]
       ^--- muted zinc-500, hover → accent color, cursor pointer
```

Keeps the terminal feel without looking like a web app toolbar.

## Stats Bar Pattern

Single line, pipe-separated, mono font:

```
8 PRs SHIPPED  |  v0.8.0 RELEASED  |  6600w HISTORY DOC  |  12 LINEAR ISSUES
```

Not cards. Not boxes. One scannable line at the top.

## File Changes Needed

1. **Nuke**: `src/data/w10.ts` — rewrite with real PR content + doors
2. **Nuke**: `tailwind.config.ts` accent colors — swap to muted palette
3. **Nuke**: `src/styles/index.css` — remove glow-text, scanlines
4. **Nuke**: `src/components/TUIBox.tsx` — replace with simple bordered div or delete
5. **Rewrite**: All 4 section components — PR-focused layout, door buttons
6. **Rewrite**: `ZineHeader.tsx` — clean header, no glow
7. **Rewrite**: `StatCard.tsx` — inline stat bar, not individual neon cards
8. **Add**: `src/components/DoorButton.tsx` — clickable link that fires chirp
9. **Update**: `ZineNav.tsx` — tone down colors, remove glow

## Success Criteria

- [ ] Can read the zine for 5 minutes without eye strain
- [ ] Every PR shows what was fixed/built and WHY
- [ ] Every PR number is a door to GitHub
- [ ] Every issue number is a door to Linear or outline
- [ ] Stats bar tells you the week's shape in one line
- [ ] Works in floatty iframe (eval:: block)
- [ ] Data layer is separable — swap w10.ts for w11.ts next week
- [ ] Assembly script exists (even if rough) for populating data
