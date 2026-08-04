/**
 * FLO-496 — user-assigned tab titles.
 *
 * The load-bearing contract: `userTitle` is a SEPARATE field from the PTY
 * auto-title, so the OSC title path (which rewrites `title` on every shell
 * event) can never clobber a name the user chose.
 *
 * tabStore is a module-level createRoot singleton — each test hydrates its
 * own tabs and the afterEach restores a clean slate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tabStore, tabDisplayTitle } from './useTabStore';

function reset() {
  tabStore.hydrateTabs(
    [{ id: 'tt-tab-1', title: 'Terminal', ptyPid: null, isAlive: true }],
    'tt-tab-1'
  );
}

beforeEach(reset);
afterEach(reset);

describe('tab userTitle — FLO-496', () => {
  it('display falls back to the auto-title when no userTitle is set', () => {
    expect(tabDisplayTitle(tabStore.tabs[0])).toBe('Terminal');
  });

  it('setTabUserTitle wins the display over the auto-title', () => {
    tabStore.setTabUserTitle('tt-tab-1', 'build watch');
    expect(tabDisplayTitle(tabStore.tabs[0])).toBe('build watch');
  });

  it('the PTY/OSC auto-title path does NOT clobber a user title', () => {
    tabStore.setTabUserTitle('tt-tab-1', 'build watch');
    // Shell pushes a new title via OSC → setTabTitle (Terminal.tsx:handleTitleChange)
    tabStore.setTabTitle('tt-tab-1', 'vim ~/notes.md');

    expect(tabStore.tabs[0].title).toBe('vim ~/notes.md'); // auto-title updated…
    expect(tabDisplayTitle(tabStore.tabs[0])).toBe('build watch'); // …display unchanged
  });

  it('empty/whitespace clears back to the auto-title', () => {
    tabStore.setTabUserTitle('tt-tab-1', 'build watch');
    tabStore.setTabUserTitle('tt-tab-1', '   ');
    expect(tabStore.tabs[0].userTitle).toBeUndefined();
    expect(tabDisplayTitle(tabStore.tabs[0])).toBe('Terminal');
  });

  it('persistence carries userTitle only when set (old payload shape preserved)', () => {
    const before = tabStore.getTabsForPersistence();
    expect('userTitle' in before.tabs[0]).toBe(false);

    tabStore.setTabUserTitle('tt-tab-1', 'build watch');
    const after = tabStore.getTabsForPersistence();
    expect(after.tabs[0].userTitle).toBe('build watch');
  });

  it('hydrating tabs with userTitle restores it (restart shape)', () => {
    tabStore.hydrateTabs(
      [{ id: 'tt-tab-2', title: 'Terminal', userTitle: 'agent log', ptyPid: null, isAlive: true }],
      'tt-tab-2'
    );
    expect(tabDisplayTitle(tabStore.tabs[0])).toBe('agent log');
  });

  it('bumps persistenceVersion so the rename schedules a save', () => {
    const before = tabStore.persistenceVersion();
    tabStore.setTabUserTitle('tt-tab-1', 'named');
    expect(tabStore.persistenceVersion()).toBeGreaterThan(before);
  });
});
