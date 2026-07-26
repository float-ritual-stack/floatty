import { describe, it, expect, beforeEach, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('./tauriTypes', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { injectCustomCss, loadCustomCss } from './customCss';

const STYLE_ID = 'floatty-custom-css';

beforeEach(() => {
  document.head.innerHTML = '';
  invokeMock.mockReset();
});

describe('injectCustomCss', () => {
  it('creates a single <style> with the css and keeps it last in head', () => {
    const bundled = document.createElement('style');
    bundled.textContent = '.x{}';
    document.head.appendChild(bundled);

    injectCustomCss('.md-bold { color: red; }');

    const el = document.getElementById(STYLE_ID) as HTMLStyleElement;
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('.md-bold { color: red; }');
    // Must be the LAST node in head so it wins the cascade at equal specificity.
    expect(document.head.lastElementChild).toBe(el);
  });

  it('replaces content on re-inject without creating a second element', () => {
    injectCustomCss('a{}');
    injectCustomCss('b{}');
    const all = document.querySelectorAll(`#${STYLE_ID}`);
    expect(all.length).toBe(1);
    expect(all[0].textContent).toBe('b{}');
  });

  it('re-appends to stay last even if other styles were added after it', () => {
    injectCustomCss('a{}');
    const later = document.createElement('style');
    document.head.appendChild(later);
    injectCustomCss('a2{}');
    expect(document.head.lastElementChild?.id).toBe(STYLE_ID);
  });
});

describe('loadCustomCss', () => {
  it('injects what the backend returns', async () => {
    invokeMock.mockResolvedValue('.body { color: blue; }');
    await loadCustomCss();
    expect(invokeMock).toHaveBeenCalledWith('read_custom_css');
    expect(document.getElementById(STYLE_ID)?.textContent).toBe('.body { color: blue; }');
  });

  it('injects empty string when there is no override (no crash)', async () => {
    invokeMock.mockResolvedValue('');
    await loadCustomCss();
    expect(document.getElementById(STYLE_ID)?.textContent).toBe('');
  });

  it('swallows a backend error and injects nothing', async () => {
    invokeMock.mockRejectedValue(new Error('command failed'));
    await expect(loadCustomCss()).resolves.toBeUndefined();
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });
});
