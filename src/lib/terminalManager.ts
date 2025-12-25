/**
 * Terminal Manager - owns xterm lifecycle OUTSIDE React
 *
 * This avoids useEffect pitfalls by:
 * 1. Terminals live in a plain Map, not React state
 * 2. Initialization happens via ref callback (sync, predictable)
 * 3. Cleanup is explicit via dispose(), not effect cleanup
 * 4. React just renders containers; manager owns the terminals
 */

import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { invoke, Channel } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';

export interface TerminalInstance {
  term: XTerm;
  fitAddon: FitAddon;
  webglAddon: WebglAddon | null;
  ptyPid: number | null;
  title: string;
  container: HTMLElement | null;
  exitedNaturally: boolean;  // Guards against double onPtyExit calls
}

export interface TerminalCallbacks {
  onPtySpawn?: (pid: number) => void;
  onPtyExit?: (code: number) => void;
  onTitleChange?: (title: string) => void;
  onCtxMarker?: (marker: CtxMarker) => void;
}

interface CtxMarker {
  id: string;
  timestamp: string;
  time: string;
  project?: string;
  mode?: string;
  message: string;
  raw: string;
}

function parseCtxLine(line: string): CtxMarker | null {
  const match = line.match(
    /ctx::(\d{4}-\d{2}-\d{2})\s*@\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*(?:\[project::([^\]]+)\])?\s*(?:\[mode::([^\]]+)\])?\s*(.+)?/i
  );
  if (!match) return null;
  return {
    id: crypto.randomUUID(),
    timestamp: match[1],
    time: match[2].trim(),
    project: match[3],
    mode: match[4],
    message: match[5]?.trim() || '',
    raw: line,
  };
}

class TerminalManager {
  private instances = new Map<string, TerminalInstance>();
  private callbacks = new Map<string, TerminalCallbacks>();
  private seenMarkers = new Map<string, Set<string>>();
  // Guards against race: keyboard dispose() calls kill → PTY exit fires → onPtyExit callback
  // When disposing is set, onPtyExit callback should NOT trigger closePane
  private disposing = new Set<string>();

  /**
   * Get or create a terminal for the given ID.
   * Called from ref callback - runs synchronously when DOM mounts.
   */
  attach(id: string, container: HTMLElement, cwd?: string): TerminalInstance {
    let instance = this.instances.get(id);

    if (instance) {
      // Already exists - check if container changed (happens on layout tree changes)
      if (instance.container !== container) {
        console.log(`[TerminalManager] Re-parenting terminal ${id} to new container`);

        // CRITICAL: Dispose WebGL addon BEFORE re-opening to prevent context exhaustion
        if (instance.webglAddon) {
          try {
            instance.webglAddon.dispose();
          } catch (e) {
            console.warn(`[TerminalManager] WebGL dispose failed for ${id}:`, e);
          }
          instance.webglAddon = null;
        }

        // Re-open xterm to new container
        instance.term.open(container);
        instance.container = container;

        // Re-add WebGL addon after re-opening
        try {
          const webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            console.warn(`[TerminalManager] WebGL context lost for ${id}, falling back to canvas`);
            webglAddon.dispose();
            instance.webglAddon = null;
          });
          instance.term.loadAddon(webglAddon);
          instance.webglAddon = webglAddon;
        } catch (e) {
          console.warn(`[TerminalManager] WebGL re-add failed for ${id}:`, e);
        }

        instance.fitAddon.fit();
        // Notify PTY of new size
        if (instance.ptyPid !== null) {
          invoke('plugin:pty|resize', {
            pid: instance.ptyPid,
            cols: instance.term.cols,
            rows: instance.term.rows,
          }).catch(console.error);
        }
      } else {
        console.log(`[TerminalManager] Terminal ${id} already attached to same container`);
      }
      return instance;
    }

    console.log(`[TerminalManager] Creating new terminal ${id}`);

    // Create new terminal
    const term = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: '#1a1a2e',
        foreground: '#eaeaea',
        cursor: '#eaeaea',
        cursorAccent: '#1a1a2e',
        selectionBackground: '#4a4a7a',
        black: '#1a1a2e',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#7c3aed',
        cyan: '#06b6d4',
        white: '#eaeaea',
        brightBlack: '#8b8b8b',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#60a5fa',
        brightMagenta: '#a78bfa',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = '11';

    term.open(container);

    // Track webgl addon for proper disposal during re-parenting
    let webglAddon: WebglAddon | null = null;

    // Optional addons (fail gracefully)
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        console.warn(`[TerminalManager] WebGL context lost for ${id}, falling back to canvas`);
        webglAddon?.dispose();
        // Fetch instance from map at callback time to avoid stale closure
        const inst = this.instances.get(id);
        if (inst) inst.webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn(`[TerminalManager] WebGL addon failed for ${id}:`, e);
      webglAddon = null;
    }

    try {
      term.loadAddon(new LigaturesAddon());
    } catch (e) {
      console.warn(`[TerminalManager] Ligatures addon failed for ${id}:`, e);
    }

    fitAddon.fit();

    instance = { term, fitAddon, webglAddon, ptyPid: null, title: 'Terminal', container, exitedNaturally: false };
    this.instances.set(id, instance);
    this.seenMarkers.set(id, new Set());

    // Title change handler
    term.onTitleChange((title) => {
      instance!.title = title;
      this.callbacks.get(id)?.onTitleChange?.(title);
    });

    // Spawn PTY
    this.spawnPty(id, term, cwd);

    return instance;
  }

  private async spawnPty(id: string, term: XTerm, cwd?: string) {
    const instance = this.instances.get(id);
    if (!instance) return;

    try {
      // Check if we are in Tauri environment (Tauri 2 uses 'isTauri' or '__TAURI_INTERNALS__')
      const isTauri = typeof window !== 'undefined' && ('isTauri' in window || '__TAURI_INTERNALS__' in window);
      if (isTauri) {
        const os = await platform();
        const shell = os === 'macos' ? '/bin/zsh' : os === 'windows' ? 'powershell.exe' : '/bin/bash';
        const args = os === 'windows' ? [] : ['-l'];
        // Use provided cwd, or let the shell determine its default (usually $HOME)
        const defaultCwd = cwd || undefined;

        // Text buffer for ctx:: detection
        let textBuffer = '';
        const seenSet = this.seenMarkers.get(id)!;

        const onData = new Channel<string>();
        onData.onmessage = (base64Data: string) => {
          const binaryString = atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          term.write(bytes);

          // ctx:: detection
          const text = new TextDecoder().decode(bytes);
          textBuffer += text;
          const lines = textBuffer.split('\n');
          textBuffer = lines.pop() || '';

          for (const line of lines) {
            if (line.includes('ctx::')) {
              const marker = parseCtxLine(line);
              if (marker) {
                const contentKey = `${marker.timestamp}|${marker.time}|${marker.message}`;
                if (!seenSet.has(contentKey)) {
                  seenSet.add(contentKey);
                  this.callbacks.get(id)?.onCtxMarker?.(marker);
                }
              }
            }
          }
        };

        // Exit channel - notified when PTY closes (shell exits)
        const onExit = new Channel<number>();
        onExit.onmessage = (exitCode: number) => {
          console.log(`[TerminalManager] PTY ${id} exited with code ${exitCode}`);

          // Check if this exit was triggered by dispose() (keyboard-initiated close)
          // In that case, skip onPtyExit callback - dispose() already handled cleanup
          if (this.disposing.has(id)) {
            console.debug(`[TerminalManager] Skipping onPtyExit for ${id} - disposal in progress`);
            return;
          }

          // Mark as naturally exited to prevent double callback in dispose()
          const inst = this.instances.get(id);
          if (inst) {
            inst.exitedNaturally = true;
          }
          this.callbacks.get(id)?.onPtyExit?.(exitCode);
        };

        const pid = await invoke<number>('plugin:pty|spawn', {
          file: shell,
          args,
          cols: term.cols,
          rows: term.rows,
          cwd: defaultCwd,
          env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
          onData,
          onExit,
        });

        instance.ptyPid = pid;
        this.callbacks.get(id)?.onPtySpawn?.(pid);

        term.onData((data: string) => {
          invoke('plugin:pty|write', { pid, data }).catch(console.error);
        });

        term.onResize(({ cols, rows }) => {
          invoke('plugin:pty|resize', { pid, cols, rows }).catch(console.error);
        });
      } else {
        console.warn('Tauri environment not found. PTY not spawned.');
        term.write('\r\n[Warning: Running in browser mode. PTY not available.]\r\n');
        // Mock PTY for testing UI
        instance.ptyPid = 12345;
        this.callbacks.get(id)?.onPtySpawn?.(12345);
        term.onData((data) => {
           term.write(data); // Echo back
        });
      }

    } catch (e) {
      console.error(`[TerminalManager] PTY spawn failed for ${id}:`, e);
      term.write(`\r\n[PTY Error: ${e}]\r\n`);
    }
  }

  /**
   * Set callbacks for a terminal. Can be updated anytime.
   */
  setCallbacks(id: string, callbacks: TerminalCallbacks) {
    this.callbacks.set(id, callbacks);
  }

  /**
   * Focus a terminal
   */
  focus(id: string) {
    this.instances.get(id)?.term.focus();
  }

  /**
   * Fit terminal to container
   */
  fit(id: string) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.fitAddon.fit();
      if (instance.ptyPid !== null) {
        invoke('plugin:pty|resize', {
          pid: instance.ptyPid,
          cols: instance.term.cols,
          rows: instance.term.rows,
        }).catch(console.error);
      }
    }
  }

  /**
   * Refresh terminal display
   */
  refresh(id: string) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.term.refresh(0, instance.term.rows - 1);
    }
  }

  /**
   * Get terminal title
   */
  getTitle(id: string): string {
    return this.instances.get(id)?.title || 'Terminal';
  }

  /**
   * Get PTY pid
   */
  getPtyPid(id: string): number | null {
    return this.instances.get(id)?.ptyPid ?? null;
  }

  /**
   * Dispose terminal and kill PTY
   */
  async dispose(id: string) {
    const instance = this.instances.get(id);
    if (!instance) return;

    // Mark as disposing BEFORE kill - prevents onExit callback from triggering closePane
    this.disposing.add(id);

    if (instance.ptyPid !== null) {
      if (instance.exitedNaturally) {
        // PTY already exited - just clean up Rust session map
        try {
          await invoke('plugin:pty|dispose', { pid: instance.ptyPid });
        } catch (e) {
          console.warn(`[TerminalManager] PTY dispose failed for ${id}:`, e);
        }
      } else {
        // PTY still running - kill it (onExit callback will fire but check disposing flag)
        try {
          await invoke('plugin:pty|kill', { pid: instance.ptyPid });
        } catch (e) {
          console.error(`[TerminalManager] PTY kill failed for ${id} (pid=${instance.ptyPid}):`, e);
        }
      }
    }

    // Dispose WebGL addon first to free context
    if (instance.webglAddon) {
      try {
        instance.webglAddon.dispose();
      } catch (e) {
        console.warn(`[TerminalManager] WebGL dispose failed during cleanup for ${id}:`, e);
      }
    }

    instance.term.dispose();
    this.instances.delete(id);
    this.callbacks.delete(id);
    this.seenMarkers.delete(id);
    this.disposing.delete(id);
  }

  /**
   * Check if terminal exists
   */
  has(id: string): boolean {
    return this.instances.has(id);
  }
}

// Singleton - lives outside React
export const terminalManager = new TerminalManager();
