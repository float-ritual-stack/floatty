import { describe, it, expect } from 'vitest';
import {
  DRAWER_MIN_HEIGHT,
  drawerMaxHeight,
  clampDrawerHeight,
} from './drawerLayout';

describe('drawerMaxHeight', () => {
  it('uses 0.75 × paneHeight when that is the tighter bound', () => {
    expect(drawerMaxHeight(1000)).toBe(750); // 0.75×1000=750 < 1000−160=840
  });

  it('uses paneHeight − 160 when that is the tighter bound', () => {
    expect(drawerMaxHeight(400)).toBe(240); // 400−160=240 < 300
  });

  it('floors at DRAWER_MIN_HEIGHT on very short panes', () => {
    expect(drawerMaxHeight(200)).toBe(DRAWER_MIN_HEIGHT); // 200−160=40 → floor
    expect(drawerMaxHeight(0)).toBe(DRAWER_MIN_HEIGHT);
    expect(drawerMaxHeight(-50)).toBe(DRAWER_MIN_HEIGHT);
  });
});

describe('clampDrawerHeight', () => {
  it('passes through an in-bounds height', () => {
    expect(clampDrawerHeight(300, 1000)).toBe(300);
  });

  it('clamps below-min heights up to the minimum', () => {
    expect(clampDrawerHeight(40, 1000)).toBe(DRAWER_MIN_HEIGHT);
    expect(clampDrawerHeight(-10, 1000)).toBe(DRAWER_MIN_HEIGHT);
  });

  it('clamps above-max heights down to the pane-relative maximum', () => {
    expect(clampDrawerHeight(900, 1000)).toBe(750);
    expect(clampDrawerHeight(500, 400)).toBe(240);
  });

  it('returns the minimum on very short panes regardless of stored value', () => {
    // A height saved on a tall window restores usable on a short one.
    expect(clampDrawerHeight(600, 180)).toBe(DRAWER_MIN_HEIGHT);
  });
});
