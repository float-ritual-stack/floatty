/**
 * Daily Plugin
 *
 * Extracts structured data from daily notes (ctx:: markers parsed by Ollama)
 * and renders as a timeline view with stats, tags, and PR chips.
 *
 * Usage: Type `daily::today` or `daily::2026-01-03` and press Enter.
 *
 * This is floatty's first extracted plugin — the reference implementation
 * for the plugin system architecture.
 */

import type { FloattyPlugin } from '../../lib/plugins/types';
import { dailyHandler } from './dailyHandler';
import { DailyView, DailyErrorView } from './DailyView';
import { dailyStyles } from './styles';

export const plugin: FloattyPlugin = {
  id: 'daily',
  name: 'Daily Notes',
  version: '1.0.0',

  handlers: [dailyHandler],

  views: {
    'daily-view': DailyView,
    'daily-error': DailyErrorView,
  },

  styles: dailyStyles,
};
