import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { invoke, Channel } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import '@xterm/xterm/css/xterm.css';

// Parsed context marker
interface CtxMarker {
  id: string;
  timestamp: string;
  time: string;
  project?: string;
  mode?: string;
  message: string;
  raw: string;
}

// Parse a ctx:: line into structured data
function parseCtxLine(line: string): CtxMarker | null {
  // Pattern: ctx::YYYY-MM-DD @ HH:MM AM/PM [project::xxx] [mode::xxx] message
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

// Context Sidebar Component
function ContextSidebar({ markers, onMarkerClick }: {
  markers: CtxMarker[];
  onMarkerClick?: (marker: CtxMarker) => void;
}) {
  if (markers.length === 0) {
    return (
      <div className="ctx-sidebar ctx-sidebar-empty">
        <div className="ctx-sidebar-header">Context Stream</div>
        <div className="ctx-empty-state">
          No ctx:: markers yet
        </div>
      </div>
    );
  }

  return (
    <div className="ctx-sidebar">
      <div className="ctx-sidebar-header">
        Context Stream ({markers.length})
      </div>
      <div className="ctx-markers-list">
        {markers.map((marker) => (
          <div
            key={marker.id}
            className="ctx-marker"
            onClick={() => onMarkerClick?.(marker)}
          >
            <div className="ctx-marker-time">{marker.time}</div>
            <div className="ctx-marker-tags">
              {marker.project && (
                <span className="ctx-tag ctx-tag-project">{marker.project}</span>
              )}
              {marker.mode && (
                <span className="ctx-tag ctx-tag-mode">{marker.mode}</span>
              )}
            </div>
            <div className="ctx-marker-message">{marker.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Terminal() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const ptyPidRef = useRef<number | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [ctxMarkers, setCtxMarkers] = useState<CtxMarker[]>([]);
  const [sidebarVisible, setSidebarVisible] = useState(true);

  // Text buffer for detecting ctx:: across chunk boundaries
  const textBufferRef = useRef<string>('');
  // Dedupe set to prevent duplicate markers from rapid redraws
  const seenMarkersRef = useRef<Set<string>>(new Set());

  // Keyboard interception
  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      // Toggle sidebar with Ctrl+Shift+C
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setSidebarVisible(v => !v);
        return;
      }
      // Prevent browser defaults for terminal keys
      if (e.ctrlKey && ['w', 'r', 't', 'n'].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
      if (['F5', 'F11', 'F12'].includes(e.key)) {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  }, []);

  // Resize handler
  const handleResize = useCallback(async () => {
    if (fitAddonRef.current && xtermRef.current && ptyPidRef.current !== null) {
      fitAddonRef.current.fit();
      const { cols, rows } = xtermRef.current;
      try {
        await invoke('plugin:pty|resize', { pid: ptyPidRef.current, cols, rows });
      } catch (e) {
        console.error('Resize failed:', e);
      }
    }
  }, []);

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current) return;

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

    xtermRef.current = term;

    // Load addons
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = '11';

    term.open(terminalRef.current);

    // Cmd+Enter for multi-line input (inserts literal newline)
    term.attachCustomKeyEventHandler((event) => {
      // Cmd+Enter (Mac) or Ctrl+Enter (other) = insert newline
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        if (event.type === 'keydown') {
          // Send literal newline to PTY (escaped for shell continuation)
          // Using \n directly - shell will handle it
          if (ptyPidRef.current !== null) {
            invoke('plugin:pty|write', { pid: ptyPidRef.current, data: '\n' });
          }
        }
        return false; // Prevent default terminal handling
      }
      return true; // Let other keys through
    });

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn('WebGL addon failed:', e);
    }

    try {
      const ligaturesAddon = new LigaturesAddon();
      term.loadAddon(ligaturesAddon);
    } catch (e) {
      console.warn('Ligatures addon failed:', e);
    }

    fitAddon.fit();

    // Spawn PTY with IPC Channel
    const initPty = async () => {
      const os = await platform();
      let shell: string;
      let args: string[];

      if (os === 'macos') {
        shell = '/bin/zsh';
        args = ['-l'];
      } else if (os === 'windows') {
        shell = 'powershell.exe';
        args = [];
      } else {
        shell = '/bin/bash';
        args = ['-l'];
      }

      // Create IPC Channel for PTY data streaming
      const onData = new Channel<string>();
      onData.onmessage = (base64Data: string) => {
        // Decode base64 to binary
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Write to xterm
        term.write(bytes);

        // Detect ctx:: markers in the output
        const text = new TextDecoder().decode(bytes);
        textBufferRef.current += text;

        // Look for complete ctx:: lines
        const lines = textBufferRef.current.split('\n');
        // Keep incomplete last line in buffer
        textBufferRef.current = lines.pop() || '';

        for (const line of lines) {
          // Check for ctx:: pattern
          if (line.includes('ctx::')) {
            const marker = parseCtxLine(line);
            if (marker) {
              // Dedupe: skip if we've seen this exact content before
              const contentKey = `${marker.timestamp}|${marker.time}|${marker.message}`;
              if (!seenMarkersRef.current.has(contentKey)) {
                seenMarkersRef.current.add(contentKey);
                setCtxMarkers(prev => [...prev, marker]);

                // TODO: Fire to evna automatically
                // invoke('plugin:evna|capture_context', { line: marker.raw });

                console.log('[ctx:: captured]', marker);
              }
            }
          }

          // Check for OSC sequences (format: ESC ] code ; data BEL)
          // OSC 1337 is iTerm2's custom protocol
          // We could define our own: OSC 7337 for float-pty
          const oscMatch = line.match(/\x1b\]7337;([^\x07]+)\x07/);
          if (oscMatch) {
            try {
              const oscData = JSON.parse(oscMatch[1]);
              console.log('[OSC 7337 received]', oscData);
              // Handle custom OSC commands here
              if (oscData.type === 'ctx') {
                const marker = parseCtxLine(oscData.line);
                if (marker) {
                  setCtxMarkers(prev => [...prev, marker]);
                }
              }
            } catch {
              // Not JSON, treat as plain text
            }
          }
        }
      };

      const pid = await invoke<number>('plugin:pty|spawn', {
        file: shell,
        args,
        cols: term.cols,
        rows: term.rows,
        cwd: os === 'windows' ? undefined : '/Users/evan',
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
        onData,
      });

      ptyPidRef.current = pid;

      term.onData((data: string) => {
        invoke('plugin:pty|write', { pid, data }).catch(console.error);
      });

      term.onResize(({ cols, rows }) => {
        invoke('plugin:pty|resize', { pid, cols, rows }).catch(console.error);
      });
    };

    initPty().catch((e) => {
      console.error('PTY init failed:', e);
      term.write(`\r\n[PTY Error: ${e}]\r\n`);
    });

    window.addEventListener('resize', handleResize);
    term.focus();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (ptyPidRef.current !== null) {
        invoke('plugin:pty|kill', { pid: ptyPidRef.current }).catch(() => {});
      }
      term.dispose();
    };
  }, [handleResize]);

  // Refit terminal when sidebar visibility changes
  useEffect(() => {
    // Skip initial render
    if (!fitAddonRef.current || !xtermRef.current) return;

    // Force layout recalculation then fit
    requestAnimationFrame(() => {
      // Dispatch resize event to trigger any listeners
      window.dispatchEvent(new Event('resize'));

      setTimeout(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          console.log('[sidebar toggle] refit triggered');
        }
        // Notify PTY of new size
        if (xtermRef.current && ptyPidRef.current !== null) {
          const { cols, rows } = xtermRef.current;
          console.log('[sidebar toggle] new size:', cols, 'x', rows);
          invoke('plugin:pty|resize', { pid: ptyPidRef.current, cols, rows }).catch(() => {});
        }
      }, 100);
    });
  }, [sidebarVisible]);

  return (
    <div className="terminal-wrapper">
      <div
        ref={terminalRef}
        className="terminal-container"
      />
      {sidebarVisible && (
        <ContextSidebar
          markers={ctxMarkers}
          onMarkerClick={(marker) => {
            console.log('Clicked marker:', marker);
            // Could scroll to that point in terminal history
          }}
        />
      )}
    </div>
  );
}
