/**
 * WASM wrapper for libghostty-vt terminal emulation.
 *
 * Loads ghostty_vt.wasm at runtime via Bun.file() and provides a
 * TerminalInstance API backed by real VT emulation. Falls back to
 * plain text accumulation if the WASM module is unavailable.
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

// ─── WASM loader (lazy, one-shot) ──────────────────────────────────────

interface GhosttyExports {
  readonly memory: WebAssembly.Memory;
  readonly ghostty_wasm_alloc_opaque: () => number;
  readonly ghostty_wasm_free_opaque: (ptr: number) => void;
  readonly ghostty_wasm_alloc_u8_array: (len: number) => number;
  readonly ghostty_wasm_free_u8_array: (ptr: number, len: number) => void;
  readonly ghostty_wasm_alloc_usize: () => number;
  readonly ghostty_wasm_free_usize: (ptr: number) => void;
  readonly ghostty_terminal_new: (allocator: number, outPtr: number, opts: number) => number;
  readonly ghostty_terminal_free: (terminal: number) => void;
  readonly ghostty_terminal_vt_write: (terminal: number, data: number, len: number) => void;
  readonly ghostty_terminal_resize: (terminal: number, cols: number, rows: number) => number;
  readonly ghostty_terminal_scroll_viewport: (terminal: number, tag: number, value: number) => void;
  readonly ghostty_formatter_terminal_new: (
    allocator: number,
    outPtr: number,
    terminal: number,
    opts: number,
  ) => number;
  readonly ghostty_formatter_format_alloc: (
    formatter: number,
    allocator: number,
    bufPtr: number,
    lenPtr: number,
  ) => number;
  readonly ghostty_formatter_free: (formatter: number) => void;
}

let wasmInstance: WebAssembly.Instance | null = null;
let wasmLoadAttempted = false;

async function loadWasm(): Promise<boolean> {
  if (wasmLoadAttempted) return wasmInstance !== null;
  wasmLoadAttempted = true;
  try {
    const wasmPath = new URL("./ghostty_vt.wasm", import.meta.url);
    const wasmBytes = await Bun.file(wasmPath.pathname).arrayBuffer();
    const module = await WebAssembly.compile(wasmBytes);
    wasmInstance = await WebAssembly.instantiate(module, {});
    return true;
  } catch {
    return false;
  }
}

/** Whether the WASM backend is available. */
export function isWasmAvailable(): boolean {
  return wasmInstance !== null;
}

// ─── WASM-backed terminal ───────────────────────────────────────────────

function createWasmTerminal(exports: GhosttyExports, config: TerminalConfig): TerminalInstance {
  const cols = config.cols ?? DEFAULT_COLS;
  const rows = config.rows ?? DEFAULT_ROWS;
  const maxScrollback = config.maxScrollback ?? DEFAULT_MAX_SCROLLBACK;
  const view = new DataView(exports.memory.buffer);
  let destroyed = false;

  // Allocate terminal
  const termOutPtr = exports.ghostty_wasm_alloc_opaque();
  // Write options struct: cols(u16) + rows(u16) + padding(4) + max_scrollback(usize=4 in wasm32)
  const optsPtr = exports.ghostty_wasm_alloc_u8_array(16);
  const optsView = new DataView(exports.memory.buffer);
  optsView.setUint16(optsPtr, cols, true);
  optsView.setUint16(optsPtr + 2, rows, true);
  optsView.setUint32(optsPtr + 8, maxScrollback, true);

  const result = exports.ghostty_terminal_new(0, termOutPtr, optsPtr);
  exports.ghostty_wasm_free_u8_array(optsPtr, 16);

  if (result !== 0) {
    exports.ghostty_wasm_free_opaque(termOutPtr);
    // Fall through to plain text
    throw new Error("ghostty_terminal_new failed");
  }
  const terminal = view.getUint32(termOutPtr, true);
  exports.ghostty_wasm_free_opaque(termOutPtr);

  const write = (data: Uint8Array): void => {
    if (destroyed) return;
    const dataPtr = exports.ghostty_wasm_alloc_u8_array(data.length);
    const mem = new Uint8Array(exports.memory.buffer);
    mem.set(data, dataPtr);
    exports.ghostty_terminal_vt_write(terminal, dataPtr, data.length);
    exports.ghostty_wasm_free_u8_array(dataPtr, data.length);
  };

  const resize = (newCols: number, newRows: number): void => {
    if (destroyed) return;
    exports.ghostty_terminal_resize(terminal, newCols, newRows);
  };

  // GHOSTTY_SCROLL_VIEWPORT_DELTA = 2
  const scroll = (delta: number): void => {
    if (destroyed) return;
    exports.ghostty_terminal_scroll_viewport(terminal, 2, delta);
  };

  const render = (): readonly string[] => {
    if (destroyed) return [];
    // Create formatter for plain text output
    const fmtOutPtr = exports.ghostty_wasm_alloc_opaque();
    // Formatter options: emit=PLAIN(0), trim=true(1), unwrap=true(1)
    const fmtOptsPtr = exports.ghostty_wasm_alloc_u8_array(8);
    const fmtView = new DataView(exports.memory.buffer);
    fmtView.setUint8(fmtOptsPtr, 0); // PLAIN
    fmtView.setUint8(fmtOptsPtr + 1, 1); // trim
    fmtView.setUint8(fmtOptsPtr + 2, 1); // unwrap

    const fmtResult = exports.ghostty_formatter_terminal_new(0, fmtOutPtr, terminal, fmtOptsPtr);
    exports.ghostty_wasm_free_u8_array(fmtOptsPtr, 8);
    if (fmtResult !== 0) {
      exports.ghostty_wasm_free_opaque(fmtOutPtr);
      return [];
    }
    const formatter = new DataView(exports.memory.buffer).getUint32(fmtOutPtr, true);
    exports.ghostty_wasm_free_opaque(fmtOutPtr);

    // Format to allocated buffer
    const bufPtrPtr = exports.ghostty_wasm_alloc_opaque();
    const lenPtr = exports.ghostty_wasm_alloc_usize();
    const allocResult = exports.ghostty_formatter_format_alloc(formatter, 0, bufPtrPtr, lenPtr);
    exports.ghostty_formatter_free(formatter);

    if (allocResult !== 0) {
      exports.ghostty_wasm_free_opaque(bufPtrPtr);
      exports.ghostty_wasm_free_usize(lenPtr);
      return [];
    }

    const bufPtr = new DataView(exports.memory.buffer).getUint32(bufPtrPtr, true);
    const bufLen = new DataView(exports.memory.buffer).getUint32(lenPtr, true);
    exports.ghostty_wasm_free_opaque(bufPtrPtr);
    exports.ghostty_wasm_free_usize(lenPtr);

    const text = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, bufPtr, bufLen));
    // Free the allocated format buffer
    exports.ghostty_wasm_free_u8_array(bufPtr, bufLen);
    return text.split("\n");
  };

  const dimensions = (): { readonly cols: number; readonly rows: number } => ({
    cols,
    rows,
  });

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    exports.ghostty_terminal_free(terminal);
  };

  return { write, resize, scroll, render, dimensions, destroy };
}

// ─── Plain text fallback ────────────────────────────────────────────────

const decoder = new TextDecoder();

function createPlainTextTerminal(config: TerminalConfig): TerminalInstance {
  let cols = config.cols ?? DEFAULT_COLS;
  let rows = config.rows ?? DEFAULT_ROWS;
  const maxScrollback = config.maxScrollback ?? DEFAULT_MAX_SCROLLBACK;
  let lines: string[] = [];
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
    scrollOffset = 0;
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

// ─── Public factory ─────────────────────────────────────────────────────

/**
 * Create a terminal instance. Attempts WASM on first call; falls back to
 * plain text if unavailable or if WASM initialization fails.
 */
export function createTerminal(config?: TerminalConfig): TerminalInstance {
  if (!wasmLoadAttempted) {
    void loadWasm();
  }

  if (wasmInstance !== null) {
    try {
      const exports = wasmInstance.exports as unknown as GhosttyExports;
      return createWasmTerminal(exports, config ?? {});
    } catch {
      // WASM terminal creation failed — fall back to plain text
    }
  }

  return createPlainTextTerminal(config ?? {});
}
