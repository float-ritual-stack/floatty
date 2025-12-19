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
  ptyPid: number | null;
  title: string;
  container: HTMLElement | null;
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

  /**
   * Get or create a terminal for the given ID.
   * Called from ref callback - runs synchronously when DOM mounts.
   */
  attach(id: string, container: HTMLElement, cwd?: string): TerminalInstance {
    let instance = this.instances.get(id);

    if (instance) {
      // Already exists - just reattach to new container if needed
      if (instance.container !== container) {
        // xterm doesn't support re-parenting, so we keep the existing attachment
        // This happens during React re-renders; container should be stable
        console.warn(`[TerminalManager] Terminal ${id} already attached to different container`);
      }
      return instance;
    }

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

    // Optional addons (fail gracefully)
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn(`[TerminalManager] WebGL addon failed for ${id}:`, e);
    }

    try {
      term.loadAddon(new LigaturesAddon());
    } catch (e) {
      console.warn(`[TerminalManager] Ligatures addon failed for ${id}:`, e);
    }

    fitAddon.fit();

    instance = { term, fitAddon, ptyPid: null, title: 'Terminal', container };
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
      const os = await platform();
      const shell = os === 'macos' ? '/bin/zsh' : os === 'windows' ? 'powershell.exe' : '/bin/bash';
      const args = os === 'windows' ? [] : ['-l'];
      const defaultCwd = os === 'windows' ? undefined : (cwd || '/Users/evan');

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

      const pid = await invoke<number>('plugin:pty|spawn', {
        file: shell,
        args,
        cols: term.cols,
        rows: term.rows,
        cwd: defaultCwd,
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        onData,
      });

      instance.ptyPid = pid;
      this.callbacks.get(id)?.onPtySpawn?.(pid);

      term.onData((data: string) => {
        invoke('plugin:pty|write', { pid, data }).catch(console.error);
      });

      term.onResize(({ cols, rows }) => {
        invoke('plugin:pty|resize', { pid, cols, rows }).catch(console.error);
      });

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

    if (instance.ptyPid !== null) {
      try {
        await invoke('plugin:pty|kill', { pid: instance.ptyPid });
        this.callbacks.get(id)?.onPtyExit?.(0);
      } catch {
        this.callbacks.get(id)?.onPtyExit?.(-1);
      }
    }

    instance.term.dispose();
    this.instances.delete(id);
    this.callbacks.delete(id);
    this.seenMarkers.delete(id);
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
