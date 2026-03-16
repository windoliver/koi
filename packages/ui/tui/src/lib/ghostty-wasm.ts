/**
 * WASM wrapper for libghostty-vt terminal emulation.
 * Provides terminal state management per agent pane with a plain text
 * fallback when the WASM module is unavailable.
 */

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MAX_SCROLLBACK = 500;

/** Terminal instance — manages VT state for one agent pane. */
export interface TerminalInstance {
  /** Feed raw PTY bytes from agent subprocess. */
  readonly write: (data: Uint8Array) => void;
  /** Resize terminal grid (e.g., when pane layout changes). */
  readonly resize: (cols: number, rows: number) => void;
  /** Scroll viewport by delta lines (negative = up). */
  readonly scroll: (delta: number) => void;
  /** Render current visible screen as plain text lines. */
  readonly render: () => readonly string[];
  /** Get current dimensions. */
  readonly dimensions: () => { readonly cols: number; readonly rows: number };
  /** Free resources. */
  readonly destroy: () => void;
}

export interface TerminalConfig {
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
  readonly maxScrollback?: number | undefined;
}

// WASM loader (lazy, one-shot)

let wasmModule: WebAssembly.Module | null = null;
let wasmLoadAttempted = false;

async function loadWasm(): Promise<boolean> {
  if (wasmLoadAttempted) return wasmModule !== null;
  wasmLoadAttempted = true;
  try {
    const wasmPath = new URL("./ghostty_vt.wasm", import.meta.url);
    const wasmBytes = await Bun.file(wasmPath.pathname).arrayBuffer();
    wasmModule = await WebAssembly.compile(wasmBytes);
    return true;
  } catch {
    return false;
  }
}

/** Whether the WASM backend is available. */
export function isWasmAvailable(): boolean {
  return wasmModule !== null;
}

// Plain text fallback

const decoder = new TextDecoder();

function createPlainTextTerminal(config: TerminalConfig): TerminalInstance {
  let cols = config.cols ?? DEFAULT_COLS;
  let rows = config.rows ?? DEFAULT_ROWS;
  const maxScrollback = config.maxScrollback ?? DEFAULT_MAX_SCROLLBACK;
  let lines: string[] = []; // mutable internal buffer
  let scrollOffset = 0;
  let destroyed = false;

  const trimBuffer = (): void => {
    const limit = rows + maxScrollback;
    if (lines.length > limit) {
      lines = lines.slice(lines.length - limit);
    }
  };

  const write = (data: Uint8Array): void => {
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
    scrollOffset = 0; // auto-scroll to bottom on new data
  };

  const resize = (newCols: number, newRows: number): void => {
    if (destroyed) return;
    cols = newCols;
    rows = newRows;
    trimBuffer();
  };

  const scroll = (delta: number): void => {
    if (destroyed) return;
    const maxOffset = Math.max(0, lines.length - rows);
    scrollOffset = Math.min(maxOffset, Math.max(0, scrollOffset - delta));
  };

  const render = (): readonly string[] => {
    if (destroyed) return [];
    const end = Math.max(0, lines.length - scrollOffset);
    const start = Math.max(0, end - rows);
    const visible = lines.slice(start, end);
    // Pad to full screen height so caller always gets `rows` lines.
    while (visible.length < rows) {
      visible.push("");
    }
    return visible;
  };

  const dimensions = (): { readonly cols: number; readonly rows: number } => ({
    cols,
    rows,
  });

  const destroy = (): void => {
    destroyed = true;
    lines = [];
  };

  return { write, resize, scroll, render, dimensions, destroy };
}

// Public factory

/**
 * Create a terminal instance. Attempts WASM on first call; falls back to
 * plain text if unavailable.
 */
export function createTerminal(config?: TerminalConfig): TerminalInstance {
  // Kick off WASM loading (fire-and-forget for future calls).
  if (!wasmLoadAttempted) {
    void loadWasm();
  }
  // TODO: when WASM is loaded, return a WASM-backed instance.
  return createPlainTextTerminal(config ?? {});
}
