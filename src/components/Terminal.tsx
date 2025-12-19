import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { invoke, Channel } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { ContextSidebar } from './ContextSidebar';
import '@xterm/xterm/css/xterm.css';

export function Terminal() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const ptyPidRef = useRef<number | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);

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
      // Note: ctx:: markers are now captured by the JSONL watcher in the Rust backend
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
      <ContextSidebar visible={sidebarVisible} />
    </div>
  );
}
