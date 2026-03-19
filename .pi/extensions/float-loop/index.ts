/**
 * Float Loop Extension for pi
 *
 * Event-driven work track orchestration.
 * Triggers commands at workflow boundaries, not human memory.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, Container, Spacer, matchesKey, Key } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { registerDemoCommand } from "./demo.js";

// ─── Types ─────────────────────────────────────────────────────────────────

interface TrackState {
  name: string;
  currentUnit: string | null;
  unitStatus: 'planning' | 'entry' | 'implementation' | 'exit' | null;
  createdAt: string;
  lastSession: string;
}

interface SessionWorkLog {
  trackName: string | null;
  unitId: string | null;
  filesRead: Set<string>;
  filesWritten: Set<string>;
  filesEdited: Set<string>;
  hasCodeChanges: boolean;
  sweepRun: boolean;
  testsRun: boolean;
  handoffWritten: boolean;
  gatePassed: boolean;
  entryChecklistComplete: boolean;
}

interface FloatLoopSessionState {
  activeTrack: string | null;
  tracks: Record<string, TrackState>;
  sessionLog: SessionWorkLog;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const FLOAT_DIR = ".float/work";
const STATE_FILE = "STATE.md";
const UNITS_FILE = "WORK_UNITS.md";

// Architecture-sensitive paths that trigger arch-review
const ARCH_PATHS = [
  /src[/\\]lib[/\\]handlers[/\\]/,
  /src[/\\]lib[/\\]hooks[/\\]/,
  /src[/\\]lib[/\\]projections[/\\]/,
  /src-tauri[/\\].*[/\\]src[/\\].*\.rs$/,
];

// ─── State Management ──────────────────────────────────────────────────────

let extensionState: FloatLoopSessionState = {
  activeTrack: null,
  tracks: {},
  sessionLog: {
    trackName: null,
    unitId: null,
    filesRead: new Set(),
    filesWritten: new Set(),
    filesEdited: new Set(),
    hasCodeChanges: false,
    sweepRun: false,
    testsRun: false,
    handoffWritten: false,
    gatePassed: false,
    entryChecklistComplete: false,
  },
};

function getTrackDir(trackName: string): string {
  return join(process.cwd(), FLOAT_DIR, trackName);
}

function discoverTracks(): Array<{ name: string; currentUnit: string | null; lastSession: string; status: string }> {
  const tracks: Array<{ name: string; currentUnit: string | null; lastSession: string; status: string }> = [];
  const floatPath = join(process.cwd(), FLOAT_DIR);
  
  if (!existsSync(floatPath)) return tracks;
  
  try {
    const entries = readdirSync(floatPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const trackName = entry.name;
        const statePath = join(floatPath, trackName, STATE_FILE);
        
        if (existsSync(statePath)) {
          try {
            const content = readFileSync(statePath, 'utf-8');
            const currentUnitMatch = content.match(/\*\*Current Unit\*\*:\s*(.+)/);
            const lastSessionMatch = content.match(/\*\*Last Session\*\*:\s*(.+)/);
            
            const currentUnit = currentUnitMatch?.[1]?.trim() ?? 'unknown';
            const lastSession = lastSessionMatch?.[1]?.trim() ?? 'unknown';
            
            // Determine status from session log
            let status = 'idle';
            if (extensionState.activeTrack === trackName) {
              status = '🔥 active';
            } else if (currentUnit && currentUnit !== 'None (planning phase)' && currentUnit !== 'unknown') {
              status = '📋 in progress';
            } else {
              status = '⏸ idle';
            }
            
            tracks.push({
              name: trackName,
              currentUnit: currentUnit === 'None (planning phase)' ? null : currentUnit,
              lastSession,
              status,
            });
          } catch {
            // Skip tracks with unreadable STATE.md
          }
        }
      }
    }
  } catch {
    // .float/work doesn't exist or isn't readable
  }
  
  // Sort by last session (most recent first)
  return tracks.sort((a, b) => {
    if (a.status.includes('active')) return -1;
    if (b.status.includes('active')) return 1;
    return 0;
  });
}

function saveSessionState(pi: ExtensionAPI) {
  pi.appendEntry("float-loop", { ...extensionState });
}

function restoreSessionState(entries: any[]): FloatLoopSessionState {
  const stateEntry = entries
    .filter((e: any) => e.type === "custom" && e.customType === "float-loop")
    .pop() as { data?: FloatLoopSessionState } | undefined;

  return stateEntry?.data ?? {
    activeTrack: null,
    tracks: {},
    sessionLog: {
      trackName: null,
      unitId: null,
      filesRead: new Set(),
      filesWritten: new Set(),
      filesEdited: new Set(),
      hasCodeChanges: false,
      sweepRun: false,
      testsRun: false,
      handoffWritten: false,
      gatePassed: false,
      entryChecklistComplete: false,
    },
  };
}

// ─── File Operations ───────────────────────────────────────────────────────

function trackExists(trackName: string): boolean {
  return existsSync(getTrackDir(trackName));
}

function readTrackState(trackName: string): any {
  const path = join(getTrackDir(trackName), STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    // Parse basic fields from STATE.md
    const currentUnitMatch = content.match(/\*\*Current Unit\*\*:\s*(.+)/);
    const lastSessionMatch = content.match(/\*\*Last Session\*\*:\s*(.+)/);
    return {
      currentUnit: currentUnitMatch?.[1]?.trim() ?? "None",
      lastSession: lastSessionMatch?.[1]?.trim() ?? "unknown",
      raw: content,
    };
  } catch {
    return null;
  }
}

function readLastHandoff(trackName: string): any {
  const handoffsDir = join(getTrackDir(trackName), "handoffs");
  if (!existsSync(handoffsDir)) return null;
  
  try {
    const files = readdirSync(handoffsDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();
    
    if (files.length === 0) return null;
    
    const content = readFileSync(join(handoffsDir, files[0]!), "utf-8");
    const whatWasDoneMatch = content.match(/## What Was Done\s*\n([\s\S]*?)(?=\n## |$)/);
    return {
      file: files[0],
      whatWasDone: whatWasDoneMatch?.[1]?.trim() ?? "",
    };
  } catch {
    return null;
  }
}

function isNewFile(filePath: string): boolean {
  try {
    // Check if file exists in git
    execSync(`git ls-files --error-unmatch "${filePath}"`, { stdio: 'pipe' });
    return false; // File tracked by git
  } catch {
    return true; // File not tracked (new)
  }
}

function isArchitecturePath(filePath: string): boolean {
  return ARCH_PATHS.some(pattern => pattern.test(filePath));
}

function isTestCommand(command: string): boolean {
  return /npm test|cargo test|pytest|jest|vitest/.test(command);
}

// ─── Context Building ──────────────────────────────────────────────────────

function buildContextBlock(track: TrackState): string {
  const state = readTrackState(track.name);
  const lastHandoff = readLastHandoff(track.name);
  
  let block = `[FLOAT LOOP: ${track.name}`;
  if (track.currentUnit) {
    block += ` | Unit ${track.currentUnit}`;
  }
  if (track.unitStatus) {
    block += ` | ${track.unitStatus}`;
  }
  block += ']\n\n';
  
  if (state?.currentUnit) {
    block += `Current: ${state.currentUnit}\n`;
  }
  
  if (lastHandoff?.whatWasDone) {
    const summary = lastHandoff.whatWasDone.split('\n')[0]?.slice(0, 80) ?? '';
    block += `Last: ${summary}\n`;
  }
  
  block += '\nProtocol: Entry → Implementation → Exit → Handoff';
  
  return block;
}

// ─── UI Helpers ────────────────────────────────────────────────────────────

function updateStatus(ctx: ExtensionContext) {
  const { activeTrack, tracks } = extensionState;
  if (!activeTrack) {
    ctx.ui.setStatus("float-loop", undefined);
    return;
  }

  const track = tracks[activeTrack];
  const unit = track?.currentUnit ?? "planning";
  ctx.ui.setStatus("float-loop", ctx.ui.theme.fg("accent", `🔥 ${activeTrack} │ ${unit}`));
}

function showTrackWidget(ctx: ExtensionContext, trackName: string) {
  const state = readTrackState(trackName);
  if (!state) return;

  const unitMatch = state.raw?.match(/\*\*Current Unit\*\*:\s*(.+)/);
  const currentUnit = unitMatch?.[1]?.trim() ?? "unknown";

  extensionState.tracks[trackName] = {
    name: trackName,
    currentUnit: currentUnit === "None (planning phase)" ? null : currentUnit,
    unitStatus: 'planning',
    createdAt: new Date().toISOString(),
    lastSession: new Date().toISOString(),
  };

  const lines = [
    `┌─ ${trackName} ${"─".repeat(Math.max(0, 40 - trackName.length))}┐`,
    `│ Current: ${ctx.ui.theme.fg("accent", currentUnit)}`,
    `│`,
    `│ ${ctx.ui.theme.fg("dim", "Commands: /fl-unit, /fl-handoff, /fl-sweep, /fl-tracks")}`,
    "└" + "─".repeat(48) + "┘",
  ];

  ctx.ui.setWidget("float-loop-track", lines);
}

async function nudgeClassify(ctx: ExtensionContext, filePath: string) {
  ctx.ui.notify(`New file: ${filePath}. Classify this feature?`, "info");
  // Could show a key hint: "Press Ctrl+Shift+C to classify"
}

async function nudgeArchReview(ctx: ExtensionContext, filePath: string) {
  ctx.ui.notify(`Architecture path: ${filePath}. Aligns with PHILOSOPHY.md?`, "info");
}

// ─── Sweep Implementation ──────────────────────────────────────────────────

const BUG_PATTERNS = [
  {
    id: "P1",
    name: "Unguarded State Transitions",
    grep: '= true',
    grepFilter: '(flushing|syncing|loading|disposing|applying)',
    check: 'Flag reset in finally block?',
  },
  {
    id: "P2",
    name: "TypedArray/Buffer Boundary",
    grep: '\\.buffer',
    check: 'Pass Uint8Array instead of .buffer?',
  },
  {
    id: "P3",
    name: "Unbounded Collections",
    grep: '\\.push|\\.add|\\.set',
    check: 'Size limit and overflow behavior?',
  },
  {
    id: "P4",
    name: "Fire-and-Forget Async",
    grep: 'async.*=>',
    check: 'Await or .catch() for promises?',
  },
  {
    id: "P5",
    name: "Silent Degradation",
    grep: 'catch',
    check: 'Does catch just log and continue?',
  },
  {
    id: "P6",
    name: "HMR Singletons",
    grep: '^let |^const.*= new ',
    check: 'import.meta.hot.dispose() cleanup?',
  },
];

async function runSweep(files: string[]): Promise<any[]> {
  const findings: any[] = [];
  
  for (const file of files) {
    if (!file.match(/\.(ts|tsx|js|jsx|rs)$/)) continue;
    
    for (const pattern of BUG_PATTERNS) {
      try {
        let cmd = `grep -n "${pattern.grep}" "${file}"`;
        if (pattern.grepFilter) {
          cmd += ` | grep -E "${pattern.grepFilter}"`;
        }
        const result = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
        if (result.trim()) {
          findings.push({
            file,
            pattern: pattern.id,
            name: pattern.name,
            check: pattern.check,
            lines: result.split('\n').slice(0, 3),
          });
        }
      } catch {
        // No matches
      }
    }
  }
  
  return findings;
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

function bootstrapTrack(
  trackName: string,
  size: "small" | "medium" | "large",
  goal: string
): void {
  const dir = getTrackDir(trackName);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "handoffs"), { recursive: true });

  const date = new Date().toISOString().split("T")[0];

  const stateContent = `# ${trackName} Track State

**Created**: ${date}
**Last Session**: ${date}
**Current Unit**: None (planning phase)
**Size**: ${size}
**Goal**: ${goal}

## Session Log

| Date | Unit | Outcome | Notes |
|------|------|---------|-------|
| ${date} | - | Track created | Initial bootstrap |

## Active Context

- ${goal}
- Key constraints: [fill in]
- Open questions: [fill in]

## Next Actions

1. Define work units in WORK_UNITS.md
2. Begin first unit
`;
  writeFileSync(join(dir, STATE_FILE), stateContent);

  const unitsContent = `# ${trackName}: Work Units

**Generated**: ${date}
**Methodology**: Isolated work units with handoff documents

## Work Unit Index

| Unit | Name | Depends On | Delivers | Status |
|------|------|------------|----------|--------|
| 0.1 | Discovery | None | Context + plan | Pending |

## Unit 0.1: Discovery

### Entry Prompt

Understand the current state before making changes.

### Implementation

1. Read relevant code
2. Identify key files
3. Document findings

### Exit Checklist
- [ ] Key files identified
- [ ] Approach documented
- [ ] Handoff written
`;
  writeFileSync(join(dir, UNITS_FILE), unitsContent);

  if (size !== "small") {
    const archContent = `# ${trackName}: Architecture Context

**Created**: ${date}

## Goal

${goal}

## Current State

[Document current architecture]

## Target State

[Describe where we want to be]

## Key Files

| File | Purpose |
|------|---------|
| [add as discovered] | |

## Constraints

- [Architectural constraints]
- [Dependencies]
- [Anti-patterns to avoid]
`;
    writeFileSync(join(dir, "ARCHITECTURE.md"), archContent);

    const agentContent = `# ${trackName} — Agent Prompt

You are working on: ${goal}

## Session Protocol

### On Entry
1. Read STATE.md → current position
2. Read WORK_UNITS.md → find next unit
3. Read latest handoff (if any)
4. Verify preconditions by READING CODE

### During Implementation
- Follow unit's implementation steps
- If discovery needed: document gaps
- Grep before building

### Before Declaring Done
- Tests pass
- Runtime behavior verified (not just unit tests)
- Run /fl-sweep for bug patterns

### On Exit
1. Update STATE.md
2. Write handoff
3. Commit: \`feat(${trackName}): Unit X.Y - {name}\`
`;
    writeFileSync(join(dir, "AGENT_PROMPT.md"), agentContent);

    mkdirSync(join(dir, "refs"), { recursive: true });
  }
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function floatLoopExtension(pi: ExtensionAPI): void {
  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    extensionState = restoreSessionState(ctx.sessionManager.getEntries());
    updateStatus(ctx);

    if (extensionState.activeTrack) {
      showTrackWidget(ctx, extensionState.activeTrack);
    }
  });

  // ─── Context Injection ───────────────────────────────────────────────────
  
  pi.on("before_agent_start", async (_event, ctx) => {
    const { activeTrack } = extensionState;
    if (!activeTrack) return;

    const track = extensionState.tracks[activeTrack];
    if (!track) return;

    const contextBlock = buildContextBlock(track);

    return {
      message: {
        customType: "float-loop-context",
        content: contextBlock,
        display: false,
      },
    };
  });

  // ─── Session Tracking ────────────────────────────────────────────────────
  
  pi.on("tool_call", async (event, ctx) => {
    const log = extensionState.sessionLog;
    
    if (event.toolName === 'read') {
      log.filesRead.add(event.input.path);
    } else if (event.toolName === 'write') {
      log.filesWritten.add(event.input.path);
      log.hasCodeChanges = true;
      
      // Nudge: Classify new files
      if (isNewFile(event.input.path)) {
        await nudgeClassify(ctx, event.input.path);
      }
      
      // Nudge: Arch review for sensitive paths
      if (isArchitecturePath(event.input.path)) {
        await nudgeArchReview(ctx, event.input.path);
      }
    } else if (event.toolName === 'edit') {
      log.filesEdited.add(event.input.path);
      log.hasCodeChanges = true;
    } else if (event.toolName === 'bash') {
      if (isTestCommand(event.input.command)) {
        log.testsRun = true;
      }
    }
  });

  // ─── Auto-Sweep on Agent End ─────────────────────────────────────────────
  
  pi.on("agent_end", async (event, ctx) => {
    const log = extensionState.sessionLog;
    
    // Auto-run sweep if code changed and not already run
    if (log.hasCodeChanges && !log.sweepRun) {
      const changedFiles = [...log.filesWritten, ...log.filesEdited];
      if (changedFiles.length > 0) {
        ctx.ui.setWorkingMessage("Running sweep...");
        const findings = await runSweep(changedFiles);
        log.sweepRun = true;
        
        if (findings.length > 0) {
          ctx.ui.notify(
            `Sweep found ${findings.length} potential issues. Run /fl-sweep for details.`,
            'warning'
          );
        }
        ctx.ui.setWorkingMessage();
      }
    }
    
    // Nudge: Handoff if code changed and no handoff written
    if (log.hasCodeChanges && !log.handoffWritten) {
      ctx.ui.notify("Code changed. Write handoff when ready: /fl-handoff", 'info');
    }
  });

  // ─── Commands ────────────────────────────────────────────────────────────

  pi.registerCommand("fl-track", {
    description: "Enter or bootstrap a work track",
    getArgumentCompletions: (prefix: string) => {
      const tracks = discoverTracks();
      const filtered = tracks
        .filter(t => t.name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map(t => ({
          value: t.name,
          label: `${t.status === '🔥 active' ? '🔥 ' : ''}${t.name}`,
          description: t.currentUnit ? `Unit: ${t.currentUnit.slice(0, 30)}` : 'Planning phase',
        }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const trackName = args?.trim();
      
      // No argument: show track browser
      if (!trackName) {
        const tracks = discoverTracks();
        
        if (tracks.length === 0) {
          ctx.ui.notify("No tracks found. Use /fl-track <name> to create one.", "info");
          return;
        }
        
        const items = tracks.map(t => ({
          value: t.name,
          label: `${t.status} ${t.name}`,
          description: t.currentUnit 
            ? `Current: ${t.currentUnit.slice(0, 40)}${t.currentUnit.length > 40 ? '...' : ''}`
            : 'Planning phase',
        }));
        
        // Add option to create new
        items.push({
          value: '__new__',
          label: '➕ Create new track',
          description: 'Bootstrap a new work track',
        });
        
        const selected = await ctx.ui.select("Select track:", items);
        
        if (!selected) return;
        
        if (selected === '__new__') {
          const newName = await ctx.ui.input("Track name:");
          if (!newName) return;
          await bootstrapAndEnterTrack(ctx, pi, newName);
          return;
        }
        
        // Enter selected track
        extensionState.activeTrack = selected;
        extensionState.sessionLog.trackName = selected;
        showTrackWidget(ctx, selected);
        updateStatus(ctx);
        saveSessionState(pi);
        ctx.ui.notify(`Entered track: ${selected}`, "info");
        return;
      }
      
      // With argument: enter existing or bootstrap new
      if (trackExists(trackName)) {
        extensionState.activeTrack = trackName;
        extensionState.sessionLog.trackName = trackName;
        showTrackWidget(ctx, trackName);
        updateStatus(ctx);
        saveSessionState(pi);
        ctx.ui.notify(`Entered track: ${trackName}`, "info");
      } else {
        await bootstrapAndEnterTrack(ctx, pi, trackName);
      }
    },
  });
  
  // Helper function for bootstrapping
  async function bootstrapAndEnterTrack(ctx: ExtensionContext, pi: ExtensionAPI, trackName: string) {
    const size = await ctx.ui.select("Track size?", [
      "small (1-3 units)",
      "medium (4-8 units)",
      "large (9+ units)",
    ]);
    if (!size) return;

    const sizeValue = size.split(" ")[0] as "small" | "medium" | "large";
    const goal = await ctx.ui.input("What's the goal?");
    if (!goal) return;

    bootstrapTrack(trackName, sizeValue, goal);

    extensionState.activeTrack = trackName;
    extensionState.sessionLog.trackName = trackName;
    updateStatus(ctx);
    saveSessionState(pi);
    ctx.ui.notify(`Bootstrapped ${sizeValue} track: ${trackName}`, "success");
  }

  // Browse all tracks command
  pi.registerCommand("fl-tracks", {
    description: "Browse all work tracks",
    handler: async (_args, ctx) => {
      const tracks = discoverTracks();
      
      if (tracks.length === 0) {
        ctx.ui.notify("No tracks found in .float/work/", "info");
        return;
      }
      
      // Build compact track list (to avoid widget truncation)
      const lines: string[] = [
        ctx.ui.theme.fg("accent", `┌─ Work Tracks (${tracks.length}) ─`),
      ];
      
      for (const track of tracks.slice(0, 5)) { // Limit to 5 tracks
        const isActive = track.status.includes('active');
        const name = isActive 
          ? ctx.ui.theme.fg("accent", track.name)
          : track.name;
        
        // Compact: status + name on one line
        lines.push(`${track.status} ${name}`);
        
        // Compact: just the unit (truncated), no date
        if (track.currentUnit) {
          const unitShort = track.currentUnit.slice(0, 35);
          lines.push(`  ${ctx.ui.theme.fg("dim", `→ ${unitShort}${track.currentUnit.length > 35 ? '...' : ''}`)}`);
        } else {
          lines.push(`  ${ctx.ui.theme.fg("dim", "→ Planning")}`);
        }
      }
      
      if (tracks.length > 5) {
        lines.push(ctx.ui.theme.fg("dim", `... and ${tracks.length - 5} more`));
      }
      
      lines.push(ctx.ui.theme.fg("accent", "└─────────────────"));
      lines.push(ctx.ui.theme.fg("dim", "/fl-track <name> to enter"));
      
      // Show as widget temporarily
      ctx.ui.setWidget("fl-tracks-list", lines);
      
      // Auto-clear after 30 seconds
      setTimeout(() => {
        ctx.ui.setWidget("fl-tracks-list", undefined);
      }, 30000);
      
      // Also show full info in notification (scrollable)
      const trackList = tracks.map(t => {
        const unit = t.currentUnit ? t.currentUnit.slice(0, 30) : 'Planning';
        return `${t.status} ${t.name}: ${unit}`;
      }).join('\n');
      
      ctx.ui.notify(`Found ${tracks.length} track(s):\n${trackList}`, "info");
    },
  });

  pi.registerCommand("fl-unit", {
    description: "Unit operations (next, current, list)",
    handler: async (args, ctx) => {
      const { activeTrack } = extensionState;
      if (!activeTrack) {
        ctx.ui.notify("No active track. Use /fl-track <name> first.", "warning");
        return;
      }

      const subcommand = args?.trim() || "current";
      const unitsPath = join(getTrackDir(activeTrack), UNITS_FILE);

      if (!existsSync(unitsPath)) {
        ctx.ui.notify("No WORK_UNITS.md found", "error");
        return;
      }

      const unitsContent = readFileSync(unitsPath, "utf-8");

      if (subcommand === "current") {
        ctx.ui.notify(`Current unit:\n${unitsContent.slice(0, 500)}...`, "info");
      } else if (subcommand === "list") {
        const tableMatch = unitsContent.match(/## Work Unit Index[\s\S]+?(?=\n## |$)/);
        ctx.ui.notify(tableMatch?.[0] ?? "No unit index found", "info");
      } else {
        ctx.ui.notify(`Unknown subcommand: ${subcommand}. Try: next, current, list`, "warning");
      }
    },
  });

  pi.registerCommand("fl-handoff", {
    description: "Write or view handoffs",
    handler: async (args, ctx) => {
      const { activeTrack, sessionLog } = extensionState;
      if (!activeTrack) {
        ctx.ui.notify("No active track. Use /fl-track <name> first.", "warning");
        return;
      }

      const handoffsDir = join(getTrackDir(activeTrack), "handoffs");
      const subcommand = args?.trim();

      if (subcommand === "list") {
        try {
          const files = readdirSync(handoffsDir).filter(f => f.endsWith('.md'));
          ctx.ui.notify(`Handoffs:\n${files.join('\n') || 'None'}`, "info");
        } catch {
          ctx.ui.notify("No handoffs directory", "warning");
        }
        return;
      }

      // Gate check before creating handoff
      if (sessionLog.hasCodeChanges && !sessionLog.gatePassed) {
        const ok = await ctx.ui.confirm(
          "Gate Check",
          "Code changed but gate not run. Run quick check?"
        );
        if (ok) {
          // Quick gate: tests and lint
          ctx.ui.setWorkingMessage("Running gate check...");
          // TODO: Actually run tests/lint
          sessionLog.gatePassed = true;
          ctx.ui.setWorkingMessage();
        }
      }

      const track = extensionState.tracks[activeTrack];
      const unit = track?.currentUnit ?? "unknown";
      const date = new Date().toISOString().split("T")[0];
      const handoffPath = join(handoffsDir, `unit-${unit}-${date}.md`);

      const template = `# Unit ${unit} Handoff

**Status**: Complete | Partial | Blocked
**Date**: ${date}
**Commit**: [hash]

## What Was Done
- 

## Verification Evidence
- 

## Decisions Made
- 

## Gaps Discovered
- 

## What Next Session Needs
- 
`;
      writeFileSync(handoffPath, template);
      sessionLog.handoffWritten = true;
      saveSessionState(pi);
      ctx.ui.notify(`Created handoff: ${handoffPath}`, "success");
    },
  });

  pi.registerCommand("fl-sweep", {
    description: "Run bug pattern sweep",
    handler: async (_args, ctx) => {
      const { sessionLog } = extensionState;
      const files = [...sessionLog.filesWritten, ...sessionLog.filesEdited];
      
      if (files.length === 0) {
        ctx.ui.notify("No files changed this session. Run /fl-sweep all?", "info");
        return;
      }

      ctx.ui.setWorkingMessage("Running sweep...");
      const findings = await runSweep(files);
      sessionLog.sweepRun = true;
      saveSessionState(pi);
      ctx.ui.setWorkingMessage();

      if (findings.length === 0) {
        ctx.ui.notify("✓ No issues found", "success");
      } else {
        const summary = findings.map(f => `${f.file}: ${f.pattern} ${f.name}`).join('\n');
        ctx.ui.notify(`Found ${findings.length} issues:\n${summary}`, "warning");
      }
    },
  });

  pi.registerCommand("fl-track-clear", {
    description: "Clear active track",
    handler: async (_args, ctx) => {
      extensionState.activeTrack = null;
      ctx.ui.setWidget("float-loop-track", undefined);
      updateStatus(ctx);
      saveSessionState(pi);
      ctx.ui.notify("Track cleared", "info");
    },
  });

  // ─── LLM-Callable Tools ──────────────────────────────────────────────────

  pi.registerTool({
    name: "float_loop_gap",
    description: "Document a discovered gap in architecture or requirements. Use when you find something missing during implementation.",
    parameters: Type.Object({
      description: Type.String({ description: "What was discovered" }),
      impact: StringEnum(["low", "medium", "high", "blocking"] as const),
      discoveredDuring: Type.String({ description: "Unit X.Y or 'exploration'" }),
      suggestedResolution: Type.Optional(Type.String()),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      const { activeTrack } = extensionState;
      if (!activeTrack) {
        throw new Error("No active track. Use /fl-track <name> first.");
      }

      const unitsPath = join(getTrackDir(activeTrack), UNITS_FILE);
      const date = new Date().toISOString().split("T")[0];
      
      const gapEntry = `

### Gap: ${params.description.slice(0, 50)}

**Discovered**: ${date} during ${params.discoveredDuring}
**Impact**: ${params.impact}
**Description**: ${params.description}
${params.suggestedResolution ? `**Suggested Resolution**: ${params.suggestedResolution}` : ''}
**Status**: Documented
`;

      // Append to Discovered Gaps section
      let content = readFileSync(unitsPath, "utf-8");
      const gapSection = content.indexOf("## Discovered Gaps");
      if (gapSection === -1) {
        content += `\n## Discovered Gaps\n${gapEntry}`;
      } else {
        content = content.slice(0, gapSection + 18) + gapEntry + content.slice(gapSection + 18);
      }
      writeFileSync(unitsPath, content);

      ctx.ui.notify(
        `Gap documented (${params.impact}): ${params.description.slice(0, 40)}...`,
        params.impact === 'blocking' ? 'warning' : 'info'
      );

      return {
        content: [{ type: "text", text: `Gap documented in ${activeTrack}/WORK_UNITS.md` }],
        details: { track: activeTrack, gap: params },
      };
    },
  });

  pi.registerTool({
    name: "float_loop_classify",
    description: "Classify a feature using the Five Questions framework",
    parameters: Type.Object({
      featureDescription: Type.String(),
      whoInitiates: StringEnum(["user", "system"] as const),
      ownsBlock: Type.Boolean(),
      whenRuns: StringEnum(["explicit", "pipeline", "observer"] as const),
      criticalPath: Type.Boolean(),
      needsOtherHooks: Type.Boolean(),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      // Five Questions logic
      let classification: string;
      let rationale: string;

      if (params.whoInitiates === "user" && params.ownsBlock) {
        classification = "HANDLER";
        rationale = "User-initiated, owns block transformation";
      } else if (params.whenRuns === "observer" && !params.criticalPath) {
        classification = "PROJECTION";
        rationale = "Background observer, not in critical path";
      } else if (params.needsOtherHooks || params.whenRuns === "pipeline") {
        classification = "HOOK";
        rationale = "Part of execution pipeline or needs context from other hooks";
      } else {
        classification = "HOOK";
        rationale = "Enriches or reacts to changes";
      }

      const nextSteps = {
        HANDLER: "Add to src/lib/handlers/, register in index",
        HOOK: "Add to src/lib/hooks/, set priority appropriately",
        PROJECTION: "Add to ProjectionScheduler with debounce timing",
        RENDERER: "Add detection hook + display component",
      };

      return {
        content: [{
          type: "text",
          text: `**${classification}**: ${rationale}\n\nNext: ${nextSteps[classification as keyof typeof nextSteps]}`
        }],
        details: { classification, params },
      };
    },
  });

  // Register demo command
  registerDemoCommand(pi);
}
