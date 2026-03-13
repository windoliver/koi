/**
 * Terminal capability detection — color level and stream properties.
 *
 * Priority: FORCE_COLOR > NO_COLOR > TTY detection > COLORTERM > TERM
 * Follows the NO_COLOR standard (https://no-color.org/).
 * NO_COLOR: any defined value (including empty) disables colors per spec.
 */

/** Color support level for terminal output. */
export type ColorLevel = "none" | "ansi-16" | "ansi-256" | "ansi-16m";

/**
 * Detects color support for a given writable stream.
 *
 * Priority: FORCE_COLOR > NO_COLOR > NODE_DISABLE_COLORS > TTY > COLORTERM > TERM
 */
export function detectColorLevel(stream?: NodeJS.WriteStream): ColorLevel {
  // 1. Explicit force — overrides everything
  const forceColor = process.env.FORCE_COLOR;
  if (forceColor === "0") return "none";
  if (forceColor !== undefined && forceColor !== "") {
    if (forceColor === "3") return "ansi-16m";
    if (forceColor === "2") return "ansi-256";
    return "ansi-16";
  }

  // 2. NO_COLOR — any defined value (including empty) disables colors per spec
  if (process.env.NO_COLOR !== undefined) return "none";

  // 3. NODE_DISABLE_COLORS
  if (process.env.NODE_DISABLE_COLORS !== undefined) return "none";

  // 4. TTY check — no colors when piped or when no stream provided
  if (stream === undefined) return "none";
  if (stream.isTTY !== true) return "none";

  // 5. Terminal capability detection
  const colorterm = process.env.COLORTERM;
  if (colorterm === "truecolor" || colorterm === "24bit") return "ansi-16m";

  const term = process.env.TERM;
  if (term?.includes("256color")) return "ansi-256";

  return "ansi-16";
}

/** Simple boolean for most use cases. */
export function isColorEnabled(stream?: NodeJS.WriteStream): boolean {
  return detectColorLevel(stream) !== "none";
}

export interface StreamCapabilities {
  /** Whether the stream is connected to a TTY. */
  readonly isTTY: boolean;
  /** Terminal column width (80 default for non-TTY). */
  readonly columns: number;
  /** Whether colors are supported on this specific stream. */
  readonly colorLevel: ColorLevel;
}

export function detectStreamCapabilities(stream: NodeJS.WritableStream): StreamCapabilities {
  const writeStream = stream as NodeJS.WriteStream;
  const isTTY = writeStream.isTTY === true;
  const columns = isTTY && typeof writeStream.columns === "number" ? writeStream.columns : 80;
  const colorLevel = detectColorLevel(isTTY ? writeStream : undefined);

  return { isTTY, columns, colorLevel } as const;
}

/** Detect capabilities for both output streams. */
export function detectTerminal(): {
  readonly stdout: StreamCapabilities;
  readonly stderr: StreamCapabilities;
} {
  return {
    stdout: detectStreamCapabilities(process.stdout),
    stderr: detectStreamCapabilities(process.stderr),
  } as const;
}
