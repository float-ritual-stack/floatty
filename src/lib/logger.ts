/**
 * Logger - Forwards JS logs to Rust (written to ~/.floatty/logs/)
 *
 * Usage:
 *   import { log } from './logger';
 *   log.info('TerminalManager', 'Picker spawned');
 *   log.debug('KeyNav', 'Key pressed', { key: 'Enter' });
 *
 * Also intercepts console.log/warn/error when INTERCEPT_CONSOLE is true.
 */

import { invoke } from '@tauri-apps/api/core';

// Set to true to intercept all console.* calls
const INTERCEPT_CONSOLE = true;

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

interface LogData {
  [key: string]: unknown;
}

function formatMessage(message: string, data?: LogData): string {
  if (!data || Object.keys(data).length === 0) {
    return message;
  }
  return `${message} ${JSON.stringify(data)}`;
}

async function logToRust(level: LogLevel, target: string, message: string): Promise<void> {
  try {
    await invoke('log_js', { level, target, message });
  } catch (e) {
    // Fallback to native console if Rust invoke fails
    // (e.g., during early startup before Tauri is ready)
    originalConsole.error('[logger] Failed to invoke log_js:', e);
  }
}

// Store original console methods before intercepting
const originalConsole = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/**
 * Logger API - use these for structured logging
 */
export const log = {
  trace: (target: string, message: string, data?: LogData) => {
    const formatted = formatMessage(message, data);
    originalConsole.debug(`[${target}]`, formatted);
    logToRust('trace', target, formatted);
  },
  debug: (target: string, message: string, data?: LogData) => {
    const formatted = formatMessage(message, data);
    originalConsole.debug(`[${target}]`, formatted);
    logToRust('debug', target, formatted);
  },
  info: (target: string, message: string, data?: LogData) => {
    const formatted = formatMessage(message, data);
    originalConsole.info(`[${target}]`, formatted);
    logToRust('info', target, formatted);
  },
  warn: (target: string, message: string, data?: LogData) => {
    const formatted = formatMessage(message, data);
    originalConsole.warn(`[${target}]`, formatted);
    logToRust('warn', target, formatted);
  },
  error: (target: string, message: string, data?: LogData) => {
    const formatted = formatMessage(message, data);
    originalConsole.error(`[${target}]`, formatted);
    logToRust('error', target, formatted);
  },
};

/**
 * Intercept console.* calls and forward to Rust
 * Only active when INTERCEPT_CONSOLE is true
 */
if (INTERCEPT_CONSOLE) {
  const parseConsoleArgs = (args: unknown[]): { target: string; message: string } => {
    // Try to extract target from [Target] prefix in first string arg
    const firstArg = args[0];
    if (typeof firstArg === 'string') {
      const match = firstArg.match(/^\[([^\]]+)\]\s*(.*)/);
      if (match) {
        const target = match[1];
        const rest = match[2];
        const remaining = args.slice(1).map(a =>
          typeof a === 'string' ? a : JSON.stringify(a)
        ).join(' ');
        return { target, message: rest ? `${rest} ${remaining}`.trim() : remaining };
      }
    }
    // No target prefix - use 'console' as target
    const message = args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ');
    return { target: 'console', message };
  };

  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    const { target, message } = parseConsoleArgs(args);
    logToRust('info', target, message);
  };

  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...args);
    const { target, message } = parseConsoleArgs(args);
    logToRust('debug', target, message);
  };

  console.info = (...args: unknown[]) => {
    originalConsole.info(...args);
    const { target, message } = parseConsoleArgs(args);
    logToRust('info', target, message);
  };

  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    const { target, message } = parseConsoleArgs(args);
    logToRust('warn', target, message);
  };

  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    const { target, message } = parseConsoleArgs(args);
    logToRust('error', target, message);
  };
}
