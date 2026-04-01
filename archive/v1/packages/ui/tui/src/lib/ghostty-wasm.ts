/**
 * Plain text terminal buffer for split-pane agent output.
 *
 * Koi agents produce structured AG-UI events, not raw PTY bytes.
 * A full VT terminal emulator (libghostty-vt, xterm.js) is not needed
 * today — all output flows through the AG-UI JSON protocol.
 *
 * If raw PTY streaming is added in the future (engine-external stops
 * stripping ANSI and pipes raw bytes through PtyOutputDashboardEvent),
 * swap this module for `ghostty-opentui` (npm package with prebuilt
 * libghostty-vt N-API bindings) — don't build WASM from source.
 */

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MAX_SCROLLBACK = 500;

/** Terminal instance — manages text state for one agent pane. */
export interface TerminalInstance {
  readonly write: (data: Uint8Array) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly scroll: (delta: number) => void;
  readonly render: () => readonly string[];
  readonly dimensions: () => { readonly cols: number; readonly rows: number };
  readonly destroy: () => void;
}

export interface TerminalConfig {
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
  readonly maxScrollback?: number | undefined;
}

const decoder = new TextDecoder();

/** Create a plain text terminal buffer with scrollback. */
export function createTerminal(config?: TerminalConfig): TerminalInstance {
  let cols = config?.cols ?? DEFAULT_COLS;
  let rows = config?.rows ?? DEFAULT_ROWS;
  const maxScrollback = config?.maxScrollback ?? DEFAULT_MAX_SCROLLBACK;
  let lines: string[] = [];
  let scrollOffset = 0;
  let destroyed = false;

  const trimBuffer = (): void => {
    const limit = rows + maxScrollback;
    if (lines.length > limit) {
      lines = lines.slice(lines.length - limit);
    }
  };

  return {
    write(data: Uint8Array): void {
      if (destroyed) return;
      const incoming = decoder.decode(data, { stream: true }).split("\n");
      const firstChunk = incoming[0];
      if (lines.length > 0 && firstChunk !== undefined) {
        const lastIdx = lines.length - 1;
        const lastLine = lines[lastIdx];
        if (lastLine !== undefined) {
          lines[lastIdx] = lastLine + firstChunk;
        }
        for (let i = 1; i < incoming.length; i++) {
          lines.push(incoming[i] ?? "");
        }
      } else {
        for (const line of incoming) {
          lines.push(line);
        }
      }
      trimBuffer();
      scrollOffset = 0;
    },

    resize(newCols: number, newRows: number): void {
      if (destroyed) return;
      cols = newCols;
      rows = newRows;
      trimBuffer();
    },

    scroll(delta: number): void {
      if (destroyed) return;
      const maxOffset = Math.max(0, lines.length - rows);
      scrollOffset = Math.min(maxOffset, Math.max(0, scrollOffset - delta));
    },

    render(): readonly string[] {
      if (destroyed) return [];
      const end = Math.max(0, lines.length - scrollOffset);
      const start = Math.max(0, end - rows);
      const visible = lines.slice(start, end);
      while (visible.length < rows) {
        visible.push("");
      }
      return visible;
    },

    dimensions(): { readonly cols: number; readonly rows: number } {
      return { cols, rows };
    },

    destroy(): void {
      destroyed = true;
      lines = [];
    },
  };
}
