/**
 * Daily Plugin Styles
 *
 * CSS for the daily view timeline, stats, and error states.
 * Exported as a string for injection via the plugin system.
 *
 * Uses floatty CSS variables for theme-awareness:
 * --color-fg, --color-fg-muted, --color-border, --color-ansi-*, --font-mono
 */

export const dailyStyles = `
/* ═══════════════════════════════════════════════════════════════ */
/* DAILY VIEW - Timeline-based daily note visualization            */
/* Plugin: daily                                                   */
/* ═══════════════════════════════════════════════════════════════ */

.daily-view {
  font-size: 11px;
  line-height: 1.4;
}

/* Header with date and stats */
.daily-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 6px;
}

.daily-date-info {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.daily-date {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-fg);
}

.daily-meta {
  display: flex;
  gap: 6px;
}

.daily-pill {
  display: inline-flex;
  padding: 1px 5px;
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-fg) 3%, transparent);
  color: var(--color-fg-muted);
  font-size: 10px;
}

.daily-stats {
  display: flex;
  gap: 10px;
}

.daily-stat {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.daily-stat-value {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-ansi-green);
  font-family: var(--font-mono);
}

.daily-stat-label {
  font-size: 9px;
  color: var(--color-fg-muted);
  text-transform: uppercase;
}

/* Timeline */
.daily-timeline {
  position: relative;
  padding-left: 12px;
}

.daily-timeline::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 4px;
  bottom: 4px;
  width: 1px;
  background: var(--color-border);
}

/* Timeline entry */
.daily-entry {
  position: relative;
  margin: 0 0 4px;
  padding: 4px 6px;
  border-left: 2px solid transparent;
}

.daily-entry:hover {
  background: color-mix(in srgb, var(--color-fg) 3%, transparent);
}

.daily-entry::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-fg) 25%, transparent);
}

/* Entry type colors for timeline dot */
.daily-entry.shipped::before { background: var(--color-ansi-green); }
.daily-entry.meeting::before { background: var(--color-ansi-yellow); }
.daily-entry.spike::before { background: var(--color-ansi-magenta); }
.daily-entry.maintenance::before { background: var(--color-ansi-cyan); }

.daily-entry-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}

.daily-time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-fg-muted);
}

.daily-clock {
  /* no extra styling, just the time */
}

.daily-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.daily-tag {
  font-size: 9px;
  padding: 0 4px;
  border: 1px solid var(--color-border);
  color: var(--color-fg-muted);
  font-weight: 600;
}

.daily-tag.project {
  border-color: color-mix(in srgb, var(--color-ansi-green) 40%, transparent);
  color: var(--color-ansi-green);
}

.daily-tag.mode {
  border-color: color-mix(in srgb, var(--color-ansi-magenta) 40%, transparent);
  color: var(--color-ansi-magenta);
}

.daily-tag.issue {
  border-color: color-mix(in srgb, var(--color-ansi-bright-red) 40%, transparent);
  color: var(--color-ansi-bright-red);
}

.daily-tag.meeting {
  border-color: color-mix(in srgb, var(--color-ansi-yellow) 40%, transparent);
  color: var(--color-ansi-yellow);
}

.daily-summary {
  font-size: 11px;
  color: var(--color-fg);
  font-weight: 500;
}

.daily-sub {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Expandable details */
.daily-view details {
  border-left: 2px solid var(--color-border);
  padding: 2px 0 2px 8px;
  margin-left: 4px;
}

.daily-view details > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--color-fg-muted);
  font-size: 10px;
  user-select: none;
}

.daily-view details > summary::-webkit-details-marker { display: none; }

.daily-caret {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-fg-muted);
  transition: transform 0.1s ease;
}

.daily-view details[open] .daily-caret {
  transform: rotate(90deg);
}

.daily-list {
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.daily-list li {
  list-style: none;
  font-size: 10px;
  color: color-mix(in srgb, var(--color-fg) 72%, transparent);
  padding-left: 10px;
  position: relative;
}

.daily-list li::before {
  content: '\\2192';
  position: absolute;
  left: 0;
  color: color-mix(in srgb, var(--color-fg) 38%, transparent);
  font-family: var(--font-mono);
  font-size: 9px;
}

/* Phases */
.daily-phases {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
}

.daily-phase {
  font-size: 10px;
  color: color-mix(in srgb, var(--color-fg) 70%, transparent);
  padding: 2px 6px;
  border-left: 2px solid var(--color-ansi-cyan);
}

.daily-phase strong {
  color: var(--color-ansi-cyan);
  font-weight: 600;
}

/* PR chips */
.daily-chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
}

.daily-chip {
  font-family: var(--font-mono);
  font-size: 9px;
  padding: 0 4px;
  border: 1px solid var(--color-border);
  color: var(--color-fg-muted);
  display: inline-flex;
  gap: 3px;
  align-items: center;
}

.daily-chip.pr {
  border-color: color-mix(in srgb, var(--color-ansi-green) 50%, transparent);
  color: var(--color-ansi-green);
}

.daily-chip.pr.merged {
  border-color: color-mix(in srgb, var(--color-ansi-magenta) 50%, transparent);
  color: var(--color-ansi-magenta);
}

.daily-chip.pr.closed {
  border-color: color-mix(in srgb, var(--color-ansi-red) 50%, transparent);
  color: var(--color-ansi-red);
}

.daily-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}

/* Scattered thoughts / notes */
.daily-notes {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--color-border);
}

.daily-notes h2 {
  margin: 0 0 4px;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-fg-muted);
}

.daily-note {
  margin-top: 4px;
  padding: 4px 6px;
  border-left: 2px solid var(--color-ansi-magenta);
}

.daily-note h3 {
  margin: 0 0 2px;
  font-size: 10px;
  color: var(--color-ansi-magenta);
  font-weight: 600;
}

.daily-note p {
  margin: 0;
  font-size: 10px;
  color: color-mix(in srgb, var(--color-fg) 72%, transparent);
}

/* Empty and error states */
.daily-empty {
  color: var(--color-fg-muted);
  font-style: italic;
  padding: 8px;
  font-size: 10px;
}

.daily-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-left: 2px solid var(--color-ansi-red);
}

.daily-error-icon {
  color: var(--color-ansi-red);
}

.daily-error-text {
  color: var(--color-ansi-red);
  font-size: 10px;
}

/* Running indicator */
.daily-running {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  color: var(--color-ansi-yellow);
  font-size: 10px;
}

.daily-running-spinner {
  display: inline-block;
  animation: daily-spin 0.6s linear infinite;
}

@keyframes daily-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.daily-running-text {
  color: var(--color-fg-muted);
}
`;
