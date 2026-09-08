/**
 * Backlink drawer height math (U2, design doc §U2 "Height bounds and clamping").
 *
 * Persisted height is a raw px value but is never applied raw: every path
 * (pointer drag, keyboard resize, restore) funnels through clampDrawerHeight
 * against the CURRENT pane height, so a height saved on a tall window comes
 * back usable on a short one while the stored value survives untouched.
 */

export const DRAWER_MIN_HEIGHT = 120;
export const DRAWER_DEFAULT_HEIGHT = 240;
/** ↑/↓ on the focused grab strip. */
export const DRAWER_KEY_STEP = 16;
/** ⇧↑/⇧↓ on the focused grab strip. */
export const DRAWER_KEY_STEP_LARGE = 64;
/** The outliner keeps at least this much reading area above the drawer. */
const OUTLINER_RESERVED_HEIGHT = 160;

/**
 * Pane-relative upper bound: min(0.75 × paneHeight, paneHeight − 160px),
 * floored at DRAWER_MIN_HEIGHT so very short panes still yield a sane bound.
 */
export function drawerMaxHeight(paneHeight: number): number {
  return Math.max(
    DRAWER_MIN_HEIGHT,
    Math.min(0.75 * paneHeight, paneHeight - OUTLINER_RESERVED_HEIGHT),
  );
}

/** Clamp a raw px height into [min, max(paneHeight)]. */
export function clampDrawerHeight(height: number, paneHeight: number): number {
  return Math.min(Math.max(height, DRAWER_MIN_HEIGHT), drawerMaxHeight(paneHeight));
}
