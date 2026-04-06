/**
 * ConfigContext - Centralized configuration from Rust backend
 *
 * Single IPC call on mount, three access layers:
 *   - useConfig()     → reactive accessor for components
 *   - getConfig()     → sync module-level read for non-component code
 *   - waitForConfig() → async await for code that needs config before proceeding
 *
 * Test injection: <ConfigProvider config={mockConfig}>
 *
 * FLO-559: replaces 7 independent invoke("get_ctx_config") calls
 */
import { createContext, useContext, createSignal, onCleanup } from 'solid-js';
import type { JSX, Accessor } from 'solid-js';
import { invoke } from '../lib/tauriTypes';
import { createLogger } from '../lib/logger';
import type { AggregatorConfig } from '../lib/tauriTypes';

const logger = createLogger('ConfigContext');

// ═══════════════════════════════════════════════════════════════
// MODULE-LEVEL CACHE (non-component access)
// ═══════════════════════════════════════════════════════════════

let _configCache: AggregatorConfig | null = null;
let _configReadyResolve: ((c: AggregatorConfig) => void) | undefined;

/** Synchronous config access for non-component code. Returns null before IPC resolves. */
export function getConfig(): AggregatorConfig | null {
  return _configCache;
}

/** Async config access — resolves when IPC completes. For code that must wait. */
export const configReady: Promise<AggregatorConfig> = new Promise(
  (resolve) => { _configReadyResolve = resolve; }
);

// ═══════════════════════════════════════════════════════════════
// SOLIDJS CONTEXT (reactive component access)
// ═══════════════════════════════════════════════════════════════

const ConfigContext = createContext<Accessor<AggregatorConfig | null>>();

interface ConfigProviderProps {
  config?: AggregatorConfig;
  children: JSX.Element;
}

export function ConfigProvider(props: ConfigProviderProps) {
  const [config, setConfig] = createSignal<AggregatorConfig | null>(props.config ?? null);
  let mounted = true;
  onCleanup(() => { mounted = false; });

  if (props.config) {
    _configCache = props.config;
    _configReadyResolve?.(props.config);
  } else {
    invoke<AggregatorConfig>('get_ctx_config', {}).then((c) => {
      if (!mounted) return;
      _configCache = c;
      setConfig(c);
      _configReadyResolve?.(c);
    }).catch((err) => {
      logger.warn(`Failed to load config: ${err}`);
    });
  }

  return (
    <ConfigContext.Provider value={config}>
      {props.children}
    </ConfigContext.Provider>
  );
}

export function useConfig(): Accessor<AggregatorConfig | null> {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig() must be used within <ConfigProvider>');
  return ctx;
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _configCache = null;
  });
}
