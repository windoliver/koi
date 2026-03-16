/**
 * AgentTerminal — ghostty-web terminal emulator for raw PTY output.
 *
 * Renders a WASM-powered terminal (Ghostty's VT100 parser) for agents that
 * produce raw terminal output (external engine subprocesses). Receives
 * base64-encoded PTY chunks and writes decoded bytes to the terminal.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal, init as initGhostty } from "ghostty-web";

/** Singleton WASM init promise — loaded once, reused across mounts. */
let ghosttyReady: Promise<void> | null = null;

function ensureGhosttyInit(): Promise<void> {
  if (ghosttyReady === null) {
    ghosttyReady = initGhostty();
  }
  return ghosttyReady;
}

export interface AgentTerminalProps {
  readonly agentId: string;
  /** Base64-encoded PTY chunks from the terminal store. */
  readonly ptyData: readonly string[];
  readonly className?: string;
}

/** Dark theme matching dashboard CSS variables. */
const TERMINAL_THEME = {
  background: "#0a0a0a",
  foreground: "#ededed",
  cursor: "#3b82f6",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#3b82f640",
  black: "#1a1a2e",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e2e8f0",
  brightBlack: "#64748b",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#f8fafc",
} as const;

export const AgentTerminal = memo(function AgentTerminal({
  agentId,
  ptyData,
  className,
}: AgentTerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const processedCountRef = useRef(0);
  const [initError, setInitError] = useState<string | null>(null);

  // Stable resize handler using ResizeObserver
  const handleResize = useCallback(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (terminal === null || container === null) return;

    // Compute approximate columns/rows from container size.
    // ghostty-web uses a canvas renderer, so we estimate from font metrics.
    // Default font is ~8px wide, ~16px tall at fontSize 14.
    const charWidth = 8;
    const charHeight = 16;
    const cols = Math.max(10, Math.floor(container.clientWidth / charWidth));
    const rows = Math.max(2, Math.floor(container.clientHeight / charHeight));
    terminal.resize(cols, rows);
  }, []);

  // Initialize terminal on mount (async because WASM must load first)
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let disposed = false;
    let terminal: Terminal | null = null;

    void ensureGhosttyInit()
      .then(() => {
        if (disposed) return;

        terminal = new Terminal({
          rows: 24,
          cols: 80,
          cursorBlink: true,
          cursorStyle: "block",
          fontSize: 14,
          fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, monospace",
          scrollback: 1000,
          disableStdin: true,
          theme: TERMINAL_THEME,
        });
        terminal.open(container);
        terminalRef.current = terminal;
        processedCountRef.current = 0;
        setInitError(null);

        // Trigger initial fit
        handleResize();
      })
      .catch((err: unknown) => {
        if (!disposed) {
          const message = err instanceof Error ? err.message : "Failed to initialize terminal";
          setInitError(message);
        }
      });

    // Observe container resizes
    const observer = new ResizeObserver(handleResize);
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      if (terminal !== null) {
        terminal.dispose();
      }
      terminalRef.current = null;
    };
  }, [agentId, handleResize]);

  // Write new PTY data as it arrives
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null) return;

    // Only process new chunks since last render
    for (let i = processedCountRef.current; i < ptyData.length; i++) {
      const chunk = ptyData[i];
      if (chunk !== undefined) {
        // Decode base64 to string and write to terminal
        const decoded = atob(chunk);
        terminal.write(decoded);
      }
    }
    processedCountRef.current = ptyData.length;
  }, [ptyData]);

  if (initError !== null) {
    return (
      <div className={`flex items-center justify-center p-4 text-sm text-red-500 ${className ?? ""}`}>
        Terminal initialization failed: {initError}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`min-h-0 flex-1 font-mono ${className ?? ""}`}
      style={{ width: "100%", height: "100%" }}
    />
  );
});
