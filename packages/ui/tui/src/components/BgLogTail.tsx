/**
 * BgLogTail — rotation-aware, ENOENT-tolerant log tail component (#1944).
 *
 * Architecture: thin Solid component over a pure `startTailer` engine.
 * The engine is injected with fs primitives so it can be tested without
 * a real filesystem.
 */

import { For, Show, onCleanup, onMount, createSignal } from "solid-js";
import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { BgSessionRow } from "../state/types.js";
import { COLORS } from "../theme.js";

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export interface FsStats {
  readonly size: number;
  readonly ino: number;
  readonly dev: number;
}

export interface TailerFs {
  readonly open: (p: string) => Promise<FileHandle>;
  readonly stat: (p: string) => Promise<FsStats>;
  readonly watch: (p: string) => FSWatcher;
}

export interface TailerIntervalHandle {
  readonly clear: () => void;
}

export interface TailerInput {
  readonly logPath: string;
  readonly maxLines: number;
  readonly fs: TailerFs;
  readonly setInterval: (fn: () => void, ms: number) => TailerIntervalHandle;
  readonly onLines: (lines: readonly string[]) => void;
  readonly onBanner: (text: string) => void;
}

export interface TailerHandle {
  readonly stop: () => Promise<void>;
  readonly updateLogPath: (newPath: string) => void;
}

export interface BgLogTailProps {
  readonly row: BgSessionRow;
  readonly maxLines?: number | undefined;
  readonly fs?: TailerFs | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LINES = 1000;
const WATCHDOG_INTERVAL_MS = 1000;
const ENOENT_POLL_INTERVAL_MS = 250;
// Chunk size for reverse-tail scan (reads from end of file)
const REVERSE_CHUNK_SIZE = 65536;

// ---------------------------------------------------------------------------
// Tailer engine — pure, injectable, no Solid dependency
// ---------------------------------------------------------------------------

/** Reads up to maxLines from the end of the file via reverse chunked scan. */
async function readLastLines(
  fh: FileHandle,
  fileSize: number,
  maxLines: number,
): Promise<readonly string[]> {
  if (fileSize === 0) return [];

  // Accumulate raw bytes scanning backward
  const chunks: Uint8Array[] = [];
  let remaining = fileSize;
  let lineCount = 0;

  while (remaining > 0 && lineCount < maxLines) {
    const chunkSize = Math.min(REVERSE_CHUNK_SIZE, remaining);
    const offset = remaining - chunkSize;
    const buf = new Uint8Array(chunkSize);
    await fh.read(buf, 0, chunkSize, offset);
    chunks.unshift(buf);
    // Count newlines in this chunk
    for (let i = chunkSize - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) {
        lineCount++;
        if (lineCount > maxLines) break;
      }
    }
    remaining = offset;
  }

  // Merge chunks into a single buffer for decoding
  const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
  const merged = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  const lines = text.split("\n");
  // Remove trailing empty string from trailing newline
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines);
}

/** Reads bytes from offset to size and returns new lines. */
async function readAppendedBytes(
  fh: FileHandle,
  offset: number,
  newSize: number,
): Promise<readonly string[]> {
  const len = newSize - offset;
  if (len <= 0) return [];
  const buf = new Uint8Array(len);
  await fh.read(buf, 0, len, offset);
  const text = new TextDecoder().decode(buf);
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Caps a line buffer at maxLines (removes oldest). */
function capBuffer(
  existing: readonly string[],
  newLines: readonly string[],
  maxLines: number,
): readonly string[] {
  const combined = [...existing, ...newLines];
  if (combined.length <= maxLines) return combined;
  return combined.slice(combined.length - maxLines);
}

export function startTailer(input: TailerInput): TailerHandle {
  const { maxLines, fs, onLines, onBanner } = input;

  // Mutable tailer state — justified: these are bookkeeping vars that track
  // fs state across async events; wrapping them in a reactive store would
  // add unnecessary overhead since they're not rendered directly.
  let logPath = input.logPath;
  let ino: number | null = null;
  let dev: number | null = null;
  let readOffset = 0;
  // lineBuffer is the accumulated display lines; only mutated atomically
  // via onLines callback which replaces the signal value
  let lineBuffer: readonly string[] = [];
  let fh: FileHandle | null = null;
  let watcher: FSWatcher | null = null;
  let watchdogHandle: TailerIntervalHandle | null = null;
  let enoentPollHandle: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function emitLines(lines: readonly string[]): void {
    lineBuffer = capBuffer(lineBuffer, lines, maxLines);
    onLines(lineBuffer);
  }

  function emitBanner(text: string): void {
    lineBuffer = capBuffer(lineBuffer, [text], maxLines);
    onBanner(text);
    onLines(lineBuffer);
  }

  function clearEnoentPoll(): void {
    if (enoentPollHandle !== null) {
      clearInterval(enoentPollHandle);
      enoentPollHandle = null;
    }
  }

  function closeWatcher(): void {
    if (watcher !== null) {
      watcher.close();
      watcher = null;
    }
  }

  async function closeFd(): Promise<void> {
    if (fh !== null) {
      try {
        await fh.close();
      } catch (e: unknown) {
        // Ignore close errors on cleanup — file may already be gone
        void e;
      }
      fh = null;
    }
  }

  async function handleStatResult(stats: FsStats): Promise<void> {
    if (stopped) return;

    const sameInode = ino === stats.ino && dev === stats.dev;

    if (!sameInode) {
      // Rotation — new inode
      await closeFd();
      closeWatcher();
      emitBanner("--- log rotated ---");
      ino = stats.ino;
      dev = stats.dev;
      readOffset = 0;
      try {
        fh = await fs.open(logPath);
        const newLines = await readLastLines(fh, stats.size, maxLines);
        readOffset = stats.size;
        emitLines(newLines);
      } catch (e: unknown) {
        void e;
      }
      bindWatcher();
      return;
    }

    if (stats.size < readOffset) {
      // Truncation
      emitBanner("--- log truncated ---");
      readOffset = 0;
    }

    if (stats.size > readOffset) {
      if (fh === null) {
        try {
          fh = await fs.open(logPath);
        } catch (e: unknown) {
          void e;
          return;
        }
      }
      const newLines = await readAppendedBytes(fh, readOffset, stats.size);
      readOffset = stats.size;
      if (newLines.length > 0) emitLines(newLines);
    }
  }

  async function onFsEvent(): Promise<void> {
    if (stopped) return;
    try {
      const stats = await fs.stat(logPath);
      await handleStatResult(stats);
    } catch (e: unknown) {
      // ENOENT during watch = file deleted; start ENOENT poll
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        startEnoentPoll();
      }
    }
  }

  function bindWatcher(): void {
    closeWatcher();
    if (stopped) return;
    try {
      watcher = fs.watch(logPath);
      watcher.on("change", () => {
        void onFsEvent();
      });
      watcher.on("error", () => {
        // Watcher died — watchdog will compensate
      });
    } catch (e: unknown) {
      void e;
    }
  }

  function startEnoentPoll(): void {
    clearEnoentPoll();
    enoentPollHandle = setInterval(() => {
      void (async () => {
        if (stopped) return;
        try {
          const stats = await fs.stat(logPath);
          clearEnoentPoll();
          emitBanner("--- log opened ---");
          ino = stats.ino;
          dev = stats.dev;
          readOffset = 0;
          fh = await fs.open(logPath);
          const lines = await readLastLines(fh, stats.size, maxLines);
          readOffset = stats.size;
          emitLines(lines);
          bindWatcher();
          startWatchdog();
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException;
          if (err.code !== "ENOENT") throw e;
        }
      })();
    }, ENOENT_POLL_INTERVAL_MS);
  }

  function startWatchdog(): void {
    if (watchdogHandle !== null) watchdogHandle.clear();
    watchdogHandle = input.setInterval(() => {
      void onFsEvent();
    }, WATCHDOG_INTERVAL_MS);
  }

  async function initialOpen(): Promise<void> {
    if (logPath === "") return;
    try {
      const stats = await fs.stat(logPath);
      ino = stats.ino;
      dev = stats.dev;
      readOffset = 0;
      fh = await fs.open(logPath);
      const lines = await readLastLines(fh, stats.size, maxLines);
      readOffset = stats.size;
      emitLines(lines);
      bindWatcher();
      startWatchdog();
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        emitBanner("--- waiting for log ---");
        startEnoentPoll();
      } else {
        throw e;
      }
    }
  }

  function updateLogPath(newPath: string): void {
    if (newPath === logPath) return;
    logPath = newPath;
    // Fire-and-forget teardown + re-open
    void (async () => {
      clearEnoentPoll();
      closeWatcher();
      if (watchdogHandle !== null) {
        watchdogHandle.clear();
        watchdogHandle = null;
      }
      await closeFd();
      ino = null;
      dev = null;
      readOffset = 0;
      emitBanner("--- log path changed ---");
      await initialOpen();
    })();
  }

  async function stop(): Promise<void> {
    stopped = true;
    clearEnoentPoll();
    closeWatcher();
    if (watchdogHandle !== null) {
      watchdogHandle.clear();
      watchdogHandle = null;
    }
    await closeFd();
  }

  // Kick off — empty logPath is a no-op (safety guard)
  if (logPath !== "") {
    void initialOpen();
  }

  return { stop, updateLogPath };
}

// ---------------------------------------------------------------------------
// Default fs adapter (real node:fs)
// ---------------------------------------------------------------------------

const DEFAULT_FS: TailerFs = {
  open: (p: string): Promise<FileHandle> => fsOpen(p, "r"),
  stat: (p: string): Promise<FsStats> =>
    fsStat(p).then((s) => ({ size: s.size, ino: Number(s.ino), dev: Number(s.dev) })),
  watch: (p: string): FSWatcher => fsWatch(p),
};

// ---------------------------------------------------------------------------
// Solid component
// ---------------------------------------------------------------------------

export function BgLogTail(props: BgLogTailProps): unknown {
  // Safety guard — parent should gate this but we also guard here
  if (props.row.logPath === "") return null;

  const maxLines = props.maxLines ?? DEFAULT_MAX_LINES;
  const [lines, setLines] = createSignal<readonly string[]>([]);

  // tailerRef is a mutable ref — justified: the Solid component needs to
  // imperatively update the tailer when logPath changes (reactive effect).
  let tailerRef: TailerHandle | null = null;
  let prevLogPath = props.row.logPath;

  const setIntervalBridge = (fn: () => void, ms: number): TailerIntervalHandle => {
    const id = setInterval(fn, ms);
    return { clear: (): void => clearInterval(id) };
  };

  onMount(() => {
    tailerRef = startTailer({
      logPath: props.row.logPath,
      maxLines,
      fs: props.fs ?? DEFAULT_FS,
      setInterval: setIntervalBridge,
      onLines: (l: readonly string[]) => {
        setLines(l);
      },
      onBanner: (_text: string): void => {
        // banner already included in onLines — no extra action needed
      },
    });
    prevLogPath = props.row.logPath;

    onCleanup(() => {
      void tailerRef?.stop();
      tailerRef = null;
    });
  });

  // Detect logPath changes reactively (props are reactive in Solid)
  const checkPathChange = (): void => {
    const newPath = props.row.logPath;
    if (newPath !== prevLogPath && tailerRef !== null) {
      prevLogPath = newPath;
      tailerRef.updateLogPath(newPath);
    }
  };

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show when={lines().length === 0}>
        <text fg={COLORS.textMuted}>{"--- waiting for log ---"}</text>
      </Show>
      <Show when={lines().length > 0}>
        {/* Side-effect: check path change each render */}
        {checkPathChange()}
        <For each={lines()}>
          {(line: string): unknown => {
            const isBanner = line.startsWith("---") && line.endsWith("---");
            return (
              <text fg={isBanner ? COLORS.amber : COLORS.textSecondary}>{line}</text>
            );
          }}
        </For>
      </Show>
    </box>
  );
}
