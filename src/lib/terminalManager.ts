/**
 * Terminal Manager - owns xterm lifecycle OUTSIDE SolidJS
 *
 * This avoids reactive pitfalls by:
 * 1. Terminals live in a plain Map, not reactive state
 * 2. Initialization happens via ref callback (sync, predictable)
 * 3. Cleanup is explicit via dispose(), not effect cleanup
 * 4. SolidJS just renders containers; manager owns the terminals
 */

import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke, Channel } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { homeDir } from '@tauri-apps/api/path';
import { readText, readImageBase64, readFiles, writeText as clipboardWriteText } from 'tauri-plugin-clipboard-api';

// Batched clipboard info from Rust (replaces 3 sequential IPC calls)
interface ClipboardInfo {
  has_files: boolean;
  has_image: boolean;
  has_text: boolean;
}
/** Custom clipboard provider using Tauri's clipboard plugin instead of navigator.clipboard */
const tauriClipboardProvider: IClipboardProvider = {
  async readText() {
    try {
      return await readText() ?? '';
    } catch {
      return '';
    }
  },
  async writeText(_selection, text) {
    try {
      await clipboardWriteText(text);
    } catch (e) {
      console.warn('[ClipboardProvider] Failed to write to clipboard:', e);
    }
  },
};

import { defaultTheme, toXtermTheme } from './themes';

// Terminal font config from ~/.floatty/config.toml
interface TerminalConfig {
  font_size: number;
  font_weight: number;
  font_weight_bold: number;
  line_height: number;
}

const defaultConfig: TerminalConfig = {
  font_size: 13,
  font_weight: 300,
  font_weight_bold: 500,
  line_height: 1.2,
};

/** Semantic shell state from OSC 133/1337 sequences */
export interface SemanticState {
  cwd: string;
  lastCommand: string;
  lastExitCode: number;
  lastDuration: number;  // ms
  commandStartTime: number | null;
  hooksActive: boolean;
  tmuxSession?: string;  // tmux session name (for auto-reattach on restart)
}

export interface TerminalInstance {
  term: XTerm;
  fitAddon: FitAddon;
  webglAddon: WebglAddon | null;
  ptyPid: number | null;
  title: string;
  container: HTMLElement | null;
  exitedNaturally: boolean;  // Guards against double onPtyExit calls
  semanticState: SemanticState;
  stickyBottom: boolean;  // FLO-220: Follow output when true, stay put when false
  wheelHandler?: (e: WheelEvent) => void;  // FLO-220: Stored for cleanup
}

export interface TerminalCallbacks {
  onPtySpawn?: (pid: number) => void;
  onPtyExit?: (code: number) => void;
  onTitleChange?: (title: string) => void;
  onCtxMarker?: (marker: CtxMarker) => void;
  onSemanticStateChange?: (state: SemanticState) => void;
  onStickyChange?: (sticky: boolean) => void;  // FLO-220: Notify UI of scroll state changes
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
  // Font config loaded from ~/.floatty/config.toml
  private config: TerminalConfig = defaultConfig;
  private configLoaded = false;

  /**
   * Load terminal config from Tauri backend
   */
  async loadConfig(): Promise<void> {
    if (this.configLoaded) return;
    try {
      const fullConfig = await invoke<TerminalConfig & Record<string, unknown>>('get_ctx_config');
      this.config = {
        font_size: fullConfig.font_size ?? defaultConfig.font_size,
        font_weight: fullConfig.font_weight ?? defaultConfig.font_weight,
        font_weight_bold: fullConfig.font_weight_bold ?? defaultConfig.font_weight_bold,
        line_height: fullConfig.line_height ?? defaultConfig.line_height,
      };
      this.configLoaded = true;
      console.log('[TerminalManager] Loaded config:', this.config);
    } catch (err) {
      console.warn('[TerminalManager] Failed to load config, using defaults:', err);
    }
  }

  /**
   * Get or create a terminal for the given ID.
   * Ensures config is loaded before creating terminals.
   */
  async attach(id: string, container: HTMLElement, cwd?: string, tmuxSession?: string): Promise<TerminalInstance> {
    // Ensure config is loaded before creating any terminal
    await this.loadConfig();

    let instance = this.instances.get(id);

    if (instance) {
      // Already exists - check if container changed (happens on layout tree changes)
      if (instance.container !== container) {
        console.log(`[TerminalManager] Re-parenting terminal ${id} to new container`);

        // Save scroll state before re-parenting (FLO-88)
        const buffer = instance.term.buffer.active;
        const savedViewportY = buffer.viewportY;
        const wasAtBottom = buffer.viewportY >= buffer.baseY;

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

        // Restore scroll position if user was NOT at bottom (FLO-88)
        if (!wasAtBottom) {
          instance.term.scrollToLine(savedViewportY);
        }
        // Notify PTY of new size
        if (instance.ptyPid !== null && instance.ptyPid > 0) {
          invoke('plugin:pty|resize', {
            pid: instance.ptyPid,
            cols: instance.term.cols,
            rows: instance.term.rows,
          }).catch((e) => {
            console.error(`[TerminalManager] Resize failed for ${id}:`, e);
            // PTY may have died - don't write error to terminal here, it's noisy during normal exit
          });
        }
      } else {
        console.log(`[TerminalManager] Terminal ${id} already attached to same container`);
      }
      return instance;
    }

    console.log(`[TerminalManager] Creating new terminal ${id}`);

    // Create new terminal with config values
    const term = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      fontSize: this.config.font_size,
      fontWeight: String(this.config.font_weight),
      fontWeightBold: String(this.config.font_weight_bold),
      lineHeight: this.config.line_height,
      theme: toXtermTheme(defaultTheme),
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

    // OSC 52 clipboard support (tmux copy → system clipboard)
    try {
      term.loadAddon(new ClipboardAddon(undefined, tauriClipboardProvider));
    } catch (e) {
      console.warn(`[TerminalManager] Clipboard addon failed for ${id}:`, e);
    }

    // Clickable URLs in terminal output (custom handler for Tauri — window.open() is dead in webview)
    try {
      term.loadAddon(new WebLinksAddon((_event, uri) => {
        invoke('open_url', { url: uri }).catch((e) => {
          console.warn('[WebLinks] Failed to open URL:', e);
        });
      }));
    } catch (e) {
      console.warn(`[TerminalManager] WebLinks addon failed for ${id}:`, e);
    }

    fitAddon.fit();

    instance = {
      term,
      fitAddon,
      webglAddon,
      ptyPid: null,
      title: 'Terminal',
      container,
      exitedNaturally: false,
      semanticState: {
        cwd: '',
        lastCommand: '',
        lastExitCode: 0,
        lastDuration: 0,
        commandStartTime: null,
        hooksActive: false,
      },
      stickyBottom: true,  // FLO-220: Default to following output
    };
    this.instances.set(id, instance);
    this.seenMarkers.set(id, new Set());

    // OSC 133 handler - Semantic Prompts (FLO-54)
    // Sequences: A=prompt start, B=command start, C=command exec, D;code=command done
    term.parser.registerOscHandler(133, (data: string) => {
      console.log(`[TerminalManager] OSC 133 received: "${data}"`);
      const inst = this.instances.get(id);
      if (!inst) return true;

      // Mark hooks as active on first OSC 133 received
      if (!inst.semanticState.hooksActive) {
        inst.semanticState.hooksActive = true;
        console.log(`[TerminalManager] OSC 133 hooks detected for ${id}`);
      }

      const code = data.charAt(0);
      switch (code) {
        case 'A': // Prompt start
          // Nothing to do here yet
          break;
        case 'C': // Command executing
          inst.semanticState.commandStartTime = Date.now();
          break;
        case 'D': { // Command done
          const exitCode = parseInt(data.substring(2) || '0', 10);
          const startTime = inst.semanticState.commandStartTime;
          inst.semanticState.lastExitCode = exitCode;
          inst.semanticState.lastDuration = startTime ? Date.now() - startTime : 0;
          inst.semanticState.commandStartTime = null;
          // Clear tmux session when user returns to outer shell after tmux exit/detach.
          // While inside tmux, no OSC 133 D fires (tmux consumes it). When the user
          // detaches or exits, the outer shell resumes and D fires for the tmux command.
          // lastCommand still holds the tmux command that started the session.
          if (inst.semanticState.tmuxSession && /^tmux\s/.test(inst.semanticState.lastCommand)) {
            console.log(`[TerminalManager] Clearing tmux session (user returned to outer shell)`);
            inst.semanticState.tmuxSession = undefined;
          }
          this.callbacks.get(id)?.onSemanticStateChange?.(inst.semanticState);
          break;
        }
      }
      return true; // Allow sequence to continue to terminal
    });

    // OSC 1337 handler - iTerm2 custom sequences (CurrentDir)
    term.parser.registerOscHandler(1337, (data: string) => {
      console.log(`[TerminalManager] OSC 1337 received: "${data}"`);
      const inst = this.instances.get(id);
      if (!inst) return true;

      // Parse key=value format
      const eqIdx = data.indexOf('=');
      if (eqIdx === -1) return true;

      const key = data.substring(0, eqIdx);
      const value = data.substring(eqIdx + 1);

      if (key === 'CurrentDir') {
        inst.semanticState.cwd = value;
        inst.semanticState.hooksActive = true;
        this.callbacks.get(id)?.onSemanticStateChange?.(inst.semanticState);
        console.log(`[TerminalManager] cwd updated: ${value}`);
      } else if (key === 'Command') {
        // Unescape semicolons that were escaped in shell hooks
        const cmd = value.replace(/\\;/g, ';');
        inst.semanticState.lastCommand = cmd;

        // Detect tmux session commands for auto-reattach
        // OSC from inside tmux doesn't pass through, so we parse the command
        // before the user enters tmux. Handles: tmux new -s NAME, tmux attach -t NAME,
        // combined flags like -ds NAME, -As NAME, and shorthand `tmux at`
        const tmuxMatch = cmd.match(
          /^tmux\s+(?:new(?:-session)?|at(?:tach(?:-session)?)?|a)\s+.*?-[a-zA-Z]*[st]\s+(\S+)/
        );
        if (tmuxMatch) {
          const sessionName = tmuxMatch[1];
          // Validate against tmux's allowed session name characters to prevent
          // shell injection when interpolated into spawn args (persisted in SQLite)
          if (/^[a-zA-Z0-9_.-]+$/.test(sessionName)) {
            inst.semanticState.tmuxSession = sessionName;
            console.log(`[TerminalManager] tmux session from command: ${sessionName}`);
          } else {
            console.warn(`[TerminalManager] Rejected tmux session name (invalid chars): ${sessionName}`);
          }
        }

        this.callbacks.get(id)?.onSemanticStateChange?.(inst.semanticState);
      } else if (key === 'TmuxSession') {
        // Direct emission (e.g. if tmux allow-passthrough is enabled)
        if (!value) {
          inst.semanticState.tmuxSession = undefined;
          console.log(`[TerminalManager] tmux session (direct): (cleared)`);
        } else if (/^[a-zA-Z0-9_.-]+$/.test(value)) {
          inst.semanticState.tmuxSession = value;
          console.log(`[TerminalManager] tmux session (direct): ${value}`);
        } else {
          inst.semanticState.tmuxSession = undefined;
          console.warn(`[TerminalManager] Rejected TmuxSession OSC value (invalid chars): ${value}`);
        }
        this.callbacks.get(id)?.onSemanticStateChange?.(inst.semanticState);
      }
      return true;
    });

    // Title change handler
    term.onTitleChange((title) => {
      instance!.title = title;
      this.callbacks.get(id)?.onTitleChange?.(title);
    });

    // Spawn PTY and wait for key handler to be attached
    // Critical: spawnPty attaches the custom key handler, must await before returning
    await this.spawnPty(id, term, cwd, tmuxSession);

    return instance;
  }

  private async spawnPty(id: string, term: XTerm, cwd?: string, tmuxSession?: string) {
    const instance = this.instances.get(id);
    if (!instance) return;

    try {
      // Check if we are in Tauri environment (Tauri 2 uses 'isTauri' or '__TAURI_INTERNALS__')
      const isTauri = typeof window !== 'undefined' && ('isTauri' in window || '__TAURI_INTERNALS__' in window);
      if (isTauri) {
        const os = await platform();
        const shell = os === 'macos' ? '/bin/zsh' : os === 'windows' ? 'powershell.exe' : '/bin/bash';
        // When restoring a tmux session, use -c to attempt reattach with login shell fallback
        const args = os === 'windows' ? []
          : tmuxSession
            ? ['-c', `unset TMUX; tmux attach-session -t ${tmuxSession} 2>/dev/null; exec ${shell} -l`]
            : ['-l'];  // login shell (PTY provides TTY for interactive mode)

        console.log(`[TerminalManager] spawnPty ${id}: tmuxSession=${tmuxSession ?? '(none)'}, args=${JSON.stringify(args)}`);

        // Text buffer for ctx:: detection
        let textBuffer = '';
        const seenSet = this.seenMarkers.get(id)!;

        const onData = new Channel<string>();
        onData.onmessage = (base64Data: string) => {
          const inst = this.instances.get(id);
          if (!inst) return;

          const binaryString = atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          // FLO-220: Auto-scroll if sticky (wheel events handle detach)
          term.write(bytes, () => {
            if (inst.stickyBottom) {
              term.scrollToBottom();
            }
          });

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

        // FLO-220 v3: Use wheel event for user scroll detection
        // Key insight: xterm's onScroll doesn't fire on user scroll (only on content changes)
        // See: https://github.com/xtermjs/xterm.js/issues/3201
        // Solution: Listen to actual wheel events for user intent

        const setStickyBottom = (value: boolean, source: string) => {
          const inst = this.instances.get(id);
          if (!inst || inst.stickyBottom === value) return;
          console.log(`[FLO-220] stickyBottom: ${inst.stickyBottom} → ${value} (${source})`);
          inst.stickyBottom = value;
          // Emit event for UI indicator
          this.callbacks.get(id)?.onStickyChange?.(value);
        };

        // Wheel event = actual user scroll
        // Store handler for cleanup in dispose()
        const wheelHandler = (e: WheelEvent) => {
          if (e.deltaY < 0) {
            // User scrolling UP → detach
            setStickyBottom(false, 'wheel-up');
          } else if (e.deltaY > 0) {
            // User scrolling DOWN → check if at bottom to reattach
            const buffer = term.buffer.active;
            const viewportY = buffer.viewportY;
            const atBottom = viewportY >= buffer.baseY;
            if (atBottom) {
              setStickyBottom(true, 'wheel-down-at-bottom');
            }
          }
        };
        term.element?.addEventListener('wheel', wheelHandler, { passive: true });
        // Store for cleanup in dispose()
        const inst = this.instances.get(id);
        if (inst) inst.wheelHandler = wheelHandler;

        // Exit channel - notified when PTY closes (shell exits)
        // Exit event contains exit_code and optional captured output
        interface PtyExitEvent {
          exit_code: number;
          output?: string;
        }
        const onExit = new Channel<PtyExitEvent>();
        onExit.onmessage = (event: PtyExitEvent) => {
          console.log(`[TerminalManager] PTY ${id} exited with code ${event.exit_code}`);

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
          this.callbacks.get(id)?.onPtyExit?.(event.exit_code);
        };

        const pid = await invoke<number>('plugin:pty|spawn', {
          file: shell,
          args,
          cols: term.cols,
          rows: term.rows,
          cwd,
          env: {
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FLOATTY_HOOKS_ACTIVE: '',  // Clear to allow fresh hook registration
          },
          onData,
          onExit,
        });

        instance.ptyPid = pid;
        this.callbacks.get(id)?.onPtySpawn?.(pid);

        // Custom key handlers for special input behavior
        // - Shift+Enter: multiline input (ESC+CR for Claude Code)
        // - Cmd+V (macOS) / Ctrl+V: clipboard paste
        term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
          // Shift+Enter: Send ESC + CR for multiline input
          // Wezterm uses: SendString="\x1b\r" (ESC + carriage return)
          // Must block ALL event types to prevent xterm sending regular \r
          if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            if (event.type === 'keydown') {
              console.log('[TerminalManager] Sending ESC+CR for multiline');
              invoke('plugin:pty|write', { pid, data: '\x1b\r' }).catch(console.error);
            }
            return false;
          }

          // Cmd+V (macOS) or Ctrl+V (other platforms): Paste from clipboard
          // Priority: files > images > text (files from Finder Cmd+C)
          const isMac = os === 'macos';
          const isPaste = event.key === 'v' && (isMac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey;
          if (isPaste) {
            // CRITICAL: Prevent browser's native paste immediately, before async work
            event.preventDefault();
            event.stopPropagation();
            if (event.type === 'keydown') {
              // Check clipboard content type and paste appropriately
              // Priority: files > images > text (files from Finder Cmd+C)
              // Uses batched IPC call (1 call vs 3 sequential)
              (async () => {
                try {
                  const info = await invoke<ClipboardInfo>('get_clipboard_info');

                  if (info.has_files) {
                    // Files in clipboard (Finder Cmd+C) - paste paths
                    const files = await readFiles();
                    if (files && files.length > 0) {
                      const formatted = files.map(p => p.includes(' ') ? `"${p}"` : p).join(' ');
                      invoke('plugin:pty|write', { pid, data: formatted }).catch(console.error);
                    }
                  } else if (info.has_image) {
                    // Image in clipboard - save to temp file, paste path
                    const base64 = await readImageBase64();
                    if (base64) {
                      console.log('[TerminalManager] Pasting image:', base64.length, 'bytes base64');
                      const tempPath = await invoke<string>('save_clipboard_image', { base64 });
                      // Quote path for shell safety (spaces, parens, etc.)
                      const quotedPath = tempPath.includes(' ') ? `"${tempPath.replace(/"/g, '\\"')}"` : tempPath;
                      invoke('plugin:pty|write', { pid, data: quotedPath }).catch((err) => {
                        console.error('[TerminalManager] Image paste write failed:', err);
                        term.write('\r\n\x1b[33m[Paste failed: could not write image path]\x1b[0m');
                      });
                    } else {
                      console.warn('[TerminalManager] Image paste: readImageBase64 returned empty');
                      term.write('\r\n\x1b[33m[Paste failed: could not read image from clipboard]\x1b[0m');
                    }
                  } else if (info.has_text) {
                    // Text in clipboard - wrap in bracketed paste if terminal app expects it
                    const text = await readText();
                    if (text) {
                      const data = term.modes.bracketedPasteMode
                        ? `\x1b[200~${text}\x1b[201~`
                        : text;
                      invoke('plugin:pty|write', { pid, data }).catch(console.error);
                    }
                  } else {
                    console.warn('[TerminalManager] Clipboard empty or unsupported format:', info);
                  }
                } catch (err) {
                  console.error('[TerminalManager] Clipboard paste failed:', err);
                  term.write(`\r\n\x1b[33m[Paste failed: ${String(err)}]\x1b[0m`);
                }
              })();
            }
            return false; // Block default browser paste behavior
          }

          // FLO-220: Scroll to bottom + reattach
          // Cmd+End or Cmd+Down (macOS) / Ctrl+End or Ctrl+Down (other)
          // Cmd+Down added for compact keyboards without End key
          const modifier = isMac ? event.metaKey : event.ctrlKey;
          const isScrollToBottom = modifier && (event.key === 'End' || event.key === 'ArrowDown');
          if (isScrollToBottom && event.type === 'keydown') {
            term.scrollToBottom();
            setStickyBottom(true, 'cmd-down');
            return false;
          }

          return true; // Let xterm handle normally
        });

        term.onData((data: string) => {
          invoke('plugin:pty|write', { pid, data }).catch((e) => {
            console.error(`[TerminalManager] PTY write failed for ${id}:`, e);
            // PTY may have died - notify user
            const inst = this.instances.get(id);
            if (inst && !inst.exitedNaturally) {
              inst.term.write('\r\n\x1b[31m[PTY Error: Write failed. Shell may have exited.]\x1b[0m\r\n');
              // Trigger exit handling
              this.callbacks.get(id)?.onPtyExit?.(-1);
            }
          });
        });

        term.onResize(({ cols, rows }) => {
          invoke('plugin:pty|resize', { pid, cols, rows }).catch((e) => {
            // Resize failures are common during exit - only log, don't notify user
            console.warn(`[TerminalManager] PTY resize failed for ${id}:`, e);
          });
        });
      } else {
        // Non-Tauri environment (browser dev mode)
        const isDev = import.meta.env?.DEV ?? false;
        if (isDev) {
          console.warn('[TerminalManager] Browser dev mode: PTY not available, using echo mock.');
          term.write('\r\n\x1b[33m[Dev Mode: PTY unavailable. Echo mode active.]\x1b[0m\r\n');
          instance.ptyPid = -999; // Sentinel value for mock mode
          this.callbacks.get(id)?.onPtySpawn?.(-999);
          term.onData((data) => {
            term.write(data); // Echo back for UI testing
          });
        } else {
          // Production without Tauri - this is a fatal misconfiguration
          const errorMsg = 'Tauri environment not detected. This app requires the desktop runtime.';
          console.error(`[TerminalManager] FATAL: ${errorMsg}`);
          term.write(`\r\n\x1b[31m[Error: ${errorMsg}]\x1b[0m\r\n`);
          term.write('\r\n\x1b[31m[Press Cmd+W to close this pane]\x1b[0m\r\n');
          instance.ptyPid = -1; // Sentinel for spawn failure
          // Don't call onPtySpawn - this terminal is broken
        }
      }

    } catch (e) {
      console.error(`[TerminalManager] PTY spawn failed for ${id}:`, e);
      term.write(`\r\n\x1b[31m[PTY Spawn Error: ${e}]\x1b[0m\r\n`);
      term.write('\r\n\x1b[33m[Press Cmd+W to close this pane, or wait for auto-recovery...]\x1b[0m\r\n');
      instance.ptyPid = -1; // Sentinel for spawn failure
      // Notify parent that spawn failed - they can decide to close or retry
      // Wrapped in try/catch to prevent callback errors from leaving instance in bad state
      try {
        this.callbacks.get(id)?.onPtyExit?.(-1);
      } catch (callbackErr) {
        console.error(`[TerminalManager] onPtyExit callback threw during spawn failure:`, callbackErr);
      }
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

  // Track whether ANY drag is in progress (set by ResizeOverlay via setDragging)
  private isDragging = false;
  // Saved scroll positions when drag started - Map<paneId, viewportY>
  private savedScrollPositions = new Map<string, number>();

  // Pending restoration timeout - used to delay isDragging=false and batch fit() calls
  private restorationTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Set drag state - called by ResizeOverlay to suppress fit() during resize drag
   * When drag starts, we save scroll positions; when it ends, we delay restoration
   * to let all resize events settle before doing one clean fit().
   */
  setDragging(dragging: boolean) {
    // Clear any pending restoration (handles rapid drag cycles - FLO-88 race condition fix)
    if (this.restorationTimeout) {
      clearTimeout(this.restorationTimeout);
      this.restorationTimeout = null;
    }

    if (dragging) {
      // Drag starting - save all scroll positions NOW
      // Always refresh positions even if already dragging (handles rapid drag cycles)
      for (const [id, instance] of this.instances) {
        const buffer = instance.term.buffer.active;
        this.savedScrollPositions.set(id, buffer.viewportY);
      }
      this.isDragging = true;
    } else if (this.isDragging) {
      // Drag ending - delay isDragging=false to let resize events settle
      // Must be longer than TerminalPane's 50ms debounce + some buffer
      this.restorationTimeout = setTimeout(() => {
        this.restorationTimeout = null;

        // Do one clean fit() for each terminal with saved position
        for (const [id, savedY] of this.savedScrollPositions) {
          const instance = this.instances.get(id);
          if (!instance) continue;

          instance.fitAddon.fit();

          // Restore after fit, with double-rAF for xterm internal sync
          const target = savedY;
          const terminalId = id; // Capture for closure
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              // Re-fetch instance to avoid stale closure if disposed during rAF delay
              const inst = this.instances.get(terminalId);
              if (!inst || this.disposing.has(terminalId)) return;
              const maxScroll = inst.term.buffer.active.baseY;
              inst.term.scrollToLine(Math.min(target, maxScroll));
            });
          });

          // Notify PTY of new size
          if (instance.ptyPid !== null && instance.ptyPid > 0) {
            invoke('plugin:pty|resize', {
              pid: instance.ptyPid,
              cols: instance.term.cols,
              rows: instance.term.rows,
            }).catch(() => { /* Resize failures during exit are expected */ });
          }
        }

        // Clear saved positions and re-enable normal fit() calls
        this.savedScrollPositions.clear();
        this.isDragging = false;
      }, 150);
    }
  }

  /**
   * Fit terminal to container
   * Preserves scroll position using double-rAF to let xterm's internal viewport settle (FLO-88)
   * Skips during drag - setDragging(false) handles final fit with restoration
   */
  fit(id: string) {
    // Skip fit during drag - restoration happens in setDragging(false) timeout
    if (this.isDragging) return;

    const instance = this.instances.get(id);
    if (!instance) return;

    const term = instance.term;
    const savedViewportY = term.buffer.active.viewportY;

    instance.fitAddon.fit();

    // Use double-rAF to restore scroll after xterm's internal viewport sync
    // Only restore if scroll decreased significantly (indicates xterm bug, not user scrolling)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Defensive check: terminal may have been disposed during rAF delay (FLO-88)
        if (!this.instances.has(id) || this.disposing.has(id)) return;

        const currentViewportY = term.buffer.active.viewportY;
        const scrollDelta = savedViewportY - currentViewportY;

        // Restore if scroll dropped significantly AND user had scrollback position
        // (don't restore if user was already at top - nothing to preserve)
        if (scrollDelta > term.rows && savedViewportY > 0) {
          const maxScroll = term.buffer.active.baseY;
          term.scrollToLine(Math.min(savedViewportY, maxScroll));
        }
      });
    });

    if (instance.ptyPid !== null && instance.ptyPid > 0) {
      invoke('plugin:pty|resize', {
        pid: instance.ptyPid,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => { /* Resize failures during exit are expected */ });
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
   * Get semantic shell state (from OSC 133/1337)
   */
  getSemanticState(id: string): SemanticState | null {
    return this.instances.get(id)?.semanticState ?? null;
  }

  /**
   * Dispose terminal and kill PTY
   */
  async dispose(id: string) {
    // Guard against double-disposal race: if dispose() called twice rapidly,
    // both could pass instances.get() before either sets disposing flag
    if (this.disposing.has(id)) {
      console.log(`[TerminalManager] dispose(${id}) - already disposing, skipping`);
      return;
    }

    const instance = this.instances.get(id);
    if (!instance) {
      console.log(`[TerminalManager] dispose(${id}) - no instance found`);
      return;
    }
    console.log(`[TerminalManager] dispose(${id}) - ptyPid=${instance.ptyPid}, exitedNaturally=${instance.exitedNaturally}`);

    // Clear any pending restoration timeout to prevent post-disposal access (FLO-88)
    if (this.restorationTimeout) {
      clearTimeout(this.restorationTimeout);
      this.restorationTimeout = null;
    }
    // Remove this terminal's saved scroll position
    this.savedScrollPositions.delete(id);

    // Mark as disposing BEFORE kill - prevents onExit callback from triggering closePane
    this.disposing.add(id);

    try {
      // Guard: Only attempt PTY operations for valid PIDs (excludes sentinels: -1, -999)
      if (instance.ptyPid !== null && instance.ptyPid > 0) {
        if (instance.exitedNaturally) {
          // PTY already exited - just clean up Rust session map
          try {
            await invoke('plugin:pty|dispose', { pid: instance.ptyPid });
          } catch (e) {
            console.warn(`[TerminalManager] PTY dispose failed for ${id}:`, e);
          }
        } else {
          // PTY still running - kill it (onExit callback will fire but check disposing flag)
          console.log(`[TerminalManager] About to invoke plugin:pty|kill for ${id} (pid=${instance.ptyPid})`);
          try {
            await invoke('plugin:pty|kill', { pid: instance.ptyPid });
            console.log(`[TerminalManager] plugin:pty|kill completed successfully for ${id}`);
          } catch (e) {
            console.error(`[TerminalManager] PTY kill failed for ${id} (pid=${instance.ptyPid}):`, e);
          }
        }
      }

      // FLO-220: Remove wheel event listener before disposing terminal
      if (instance.wheelHandler && instance.term.element) {
        instance.term.element.removeEventListener('wheel', instance.wheelHandler);
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
      // Note: savedScrollPositions already cleared at line 731
    } finally {
      // Always clear disposing flag, even if cleanup threw
      this.disposing.delete(id);
    }
  }

  /**
   * Check if terminal exists
   */
  has(id: string): boolean {
    return this.instances.has(id);
  }

  /**
   * Spawn an interactive picker command (tv, fzf, etc.) and wait for completion.
   *
   * Unlike attach(), this is for temporary pickers that:
   * 1. Run a single command
   * 2. Wait for user interaction
   * 3. Capture stdout
   * 4. Clean up on exit
   *
   * @param id - Unique identifier for this picker instance
   * @param container - DOM element to render xterm into
   * @param command - Full command to execute (e.g., 'tv files --no-remote')
   * @param _onData - DEPRECATED: Capture now happens in Rust. Kept for API compat.
   * @param cwd - Working directory for the command
   * @param extraEnv - Additional environment variables to pass to the command
   * @returns Promise that resolves with exit code and captured output when command completes
   */
  async spawnInteractivePicker(
    id: string,
    container: HTMLElement,
    command: string,
    _onData?: (data: string) => void,
    cwd?: string,
    extraEnv?: Record<string, string>
  ): Promise<{ exitCode: number; output?: string }> {
    // Ensure config is loaded
    await this.loadConfig();

    // Create minimal xterm for picker
    const term = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      fontSize: this.config.font_size,
      fontWeight: String(this.config.font_weight),
      fontWeightBold: String(this.config.font_weight_bold),
      lineHeight: this.config.line_height,
      theme: toXtermTheme(defaultTheme),
      rows: 18, // Fixed height for picker mode
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = '11';

    term.open(container);

    // Skip WebGL for picker terminals - we already have many terminals and
    // WebGL contexts are limited. Canvas renderer is fine for short-lived pickers.
    console.log('[TerminalManager] Picker using canvas renderer (skipping WebGL)');

    // Wait for CSS layout to stabilize before fitting
    // The picker-block uses display:none → display:flex via :has() selector
    // which needs a repaint cycle before container has proper dimensions
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAddon.fit();
          console.log('[TerminalManager] Picker fit after layout:', { cols: term.cols, rows: term.rows });
          resolve();
        });
      });
    });

    // ResizeObserver for dynamic resizing (e.g., window resize while picker is open)
    // Debounce to avoid excessive PTY resize calls
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        fitAddon.fit();
        console.log('[TerminalManager] Picker resized:', { cols: term.cols, rows: term.rows });
      }, 50);
    });
    resizeObserver.observe(container);

    // Click-to-focus: if user clicks outside picker then back, refocus terminal
    // xterm uses an internal hidden textarea for keyboard input - we need to ensure it gets focused
    // Problem: xterm's internal handlers race with our focus call
    // Solution: multiple focus attempts at staggered intervals
    const focusTerminal = (attempt: number) => {
      if (document.activeElement === term.textarea) {
        console.log(`[TerminalManager] Picker already focused (attempt ${attempt})`);
        return;
      }
      if (term.textarea) {
        term.textarea.focus();
        console.log(`[TerminalManager] Picker textarea.focus() (attempt ${attempt})`);
      } else {
        term.focus();
        console.log(`[TerminalManager] Picker term.focus() fallback (attempt ${attempt})`);
      }
    };

    const handleContainerMousedown = (e: MouseEvent) => {
      // CRITICAL: Stop propagation so parent BlockItem doesn't steal focus
      // Without this, "## work notes" gets focus before tv picker
      e.stopPropagation();

      console.log('[TerminalManager] Picker mousedown:', {
        target: (e.target as HTMLElement)?.className,
        activeElement: document.activeElement?.tagName,
      });

      // Multiple focus attempts to win the race with xterm's handlers
      focusTerminal(1);                    // Immediate
      setTimeout(() => focusTerminal(2), 0);   // After current event handlers
      setTimeout(() => focusTerminal(3), 10);  // After microtasks
      setTimeout(() => focusTerminal(4), 50);  // Safety net
    };
    container.addEventListener('mousedown', handleContainerMousedown, { capture: true });

    // Get platform and home dir for shell selection (done outside Promise to avoid async executor)
    const os = await platform();
    const shell = os === 'macos' ? '/bin/zsh' : os === 'windows' ? 'powershell.exe' : '/bin/bash';
    const home = await homeDir();

    // Build PATH for non-interactive shell (picker runs with -c, doesn't source .zshrc)
    // Must include common tool locations for release builds where PATH is minimal
    const pickerPath = [
      `${home}/.cargo/bin`,      // Rust tools (tv might be here)
      `${home}/.local/bin`,      // User local
      `${home}/.bun/bin`,        // Bun
      '/opt/homebrew/bin',       // Apple Silicon homebrew
      '/opt/homebrew/sbin',
      '/usr/local/bin',          // Intel homebrew / manual installs
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':');

    return new Promise((resolve) => {
      // Data channel - for display only (capture happens in Rust)
      const onDataChannel = new Channel<string>();
      onDataChannel.onmessage = (base64Data: string) => {
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        term.write(bytes);
      };

      // Exit channel - receives exit code and captured output from Rust
      interface PtyExitEvent {
        exit_code: number;
        output?: string;
      }
      const onExitChannel = new Channel<PtyExitEvent>();
      onExitChannel.onmessage = (event: PtyExitEvent) => {
        console.log(`[TerminalManager] Picker ${id} exited with code ${event.exit_code}, output: ${event.output?.slice(0, 100) ?? '(none)'}`);

        // Cleanup
        resizeObserver.disconnect();
        if (resizeTimeout) clearTimeout(resizeTimeout);
        container.removeEventListener('mousedown', handleContainerMousedown, { capture: true });
        term.dispose();

        resolve({ exitCode: event.exit_code, output: event.output });
      };

      // Spawn PTY with the picker command
      // Use -c to run command directly, not interactive shell
      // capture_output: true tells Rust to buffer output and extract selection
      const args = os === 'windows' ? ['-Command', command] : ['-c', command];

      console.log('[TerminalManager] Spawning picker PTY:', { shell, args, cols: term.cols, rows: 18, cwd, captureOutput: true });

      // Track spawned pid for resize handler (set up before spawn so we don't miss events)
      let spawnedPid: number | null = null;

      // Set up resize handler BEFORE spawn to catch any resize events
      term.onResize(({ cols, rows }) => {
        if (spawnedPid !== null) {
          console.log('[TerminalManager] Picker resize:', { pid: spawnedPid, cols, rows });
          invoke('plugin:pty|resize', { pid: spawnedPid, cols, rows }).catch((err) => {
            console.error('[TerminalManager] Picker resize failed:', err);
          });
        }
      });

      invoke<number>('plugin:pty|spawn', {
        file: shell,
        args,
        cols: term.cols,
        rows: 18, // Fixed height for picker
        cwd,  // Pass through - Tauri PTY defaults to app cwd if undefined
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          PATH: pickerPath,
          HOME: home,
          ...extraEnv,  // Include any extra env vars (e.g., FLOATTY_API_KEY for search)
        },
        onData: onDataChannel,
        onExit: onExitChannel,
        captureOutput: true, // Enable Rust-side output capture
      }).then((pid) => {
        console.log('[TerminalManager] Picker PTY spawned with pid:', pid);
        spawnedPid = pid;  // Enable resize handler

        // Wire up input from xterm to PTY
        term.onData((data: string) => {
          invoke('plugin:pty|write', { pid, data }).catch(console.error);
        });

        term.focus();
      }).catch((err) => {
        console.error(`[TerminalManager] Picker spawn failed for ${id}:`, err);
        term.dispose();
        resolve({ exitCode: -1 });
      });
    });
  }

  /**
   * Update theme for all terminal instances (hot-swap)
   */
  updateAllThemes(theme: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  }) {
    for (const [id, instance] of this.instances) {
      console.log(`[TerminalManager] Updating theme for terminal ${id}`);
      instance.term.options.theme = theme;
    }
  }
}

// Singleton - lives outside SolidJS
export const terminalManager = new TerminalManager();

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    console.log('[terminalManager] HMR cleanup');
    // Clear pending restoration timeout (prevents stale callback after HMR)
    if (terminalManager['restorationTimeout']) {
      clearTimeout(terminalManager['restorationTimeout']);
      terminalManager['restorationTimeout'] = null;
    }
    // Dispose all terminal instances
    for (const [id] of terminalManager['instances']) {
      try {
        // Can't await in dispose callback, so just try sync cleanup
        terminalManager['instances'].get(id)?.term.dispose();
      } catch {
        // Ignore errors during HMR cleanup
      }
    }
    terminalManager['instances'].clear();
    terminalManager['disposing'].clear();
    terminalManager['callbacks'].clear();
    terminalManager['seenMarkers'].clear();
    terminalManager['savedScrollPositions'].clear();
  });
}
