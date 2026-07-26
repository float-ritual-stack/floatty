/**
 * User CSS override loader.
 *
 * Reads `{data_dir}/custom.css` via the backend and injects it as the LAST
 * <style> in <head>, so user rules win the cascade at equal specificity. Lets
 * colors/spacing be tweaked without rebuilding the app — edit custom.css,
 * reload (⌘R) or call reloadCustomCss(), done.
 *
 * Note: bundled selectors like `.block-display .md-bold` have specificity
 * (0,2,0); a bare `.md-bold` override (0,1,0) loses regardless of order, so
 * user rules may need matching specificity. Ordering-last is the most an
 * injector can do.
 */
import { invoke } from './tauriTypes';
import { createLogger } from './logger';

const logger = createLogger('customCss');
const STYLE_ID = 'floatty-custom-css';

/** Inject or replace the user-CSS <style>, kept last in <head> to win ties. */
export function injectCustomCss(css: string): void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
  }
  el.textContent = css;
  // Re-append so it stays after the bundled stylesheet even across HMR.
  document.head.appendChild(el);
}

/** Read custom.css from the data dir and inject it. No-op on failure/absence. */
export async function loadCustomCss(): Promise<void> {
  try {
    const css = await invoke<string>('read_custom_css');
    injectCustomCss(css ?? '');
    if (css) logger.info(`custom.css applied (${css.length} bytes)`);
  } catch (err) {
    logger.warn('Failed to load custom.css', { err });
  }
}

/** Re-read and re-apply custom.css without an app restart. */
export const reloadCustomCss = loadCustomCss;
