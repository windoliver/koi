/**
 * Type definitions for the external process engine adapter.
 */

import type { EngineAdapter, EngineEvent } from "@koi/core";

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Result of parsing a stdout chunk. Events are emitted immediately;
 * `turnComplete` signals end-of-response in long-lived mode.
 */
export interface OutputParseResult {
  readonly events: readonly EngineEvent[];
  /** If true, the adapter treats this as end-of-response (long-lived mode). */
  readonly turnComplete?: boolean | undefined;
}

/**
 * Stateful parser for a single stream() call. Created fresh per invocation
 * to avoid cross-call state leaking.
 */
export interface OutputParser {
  /** Parse a chunk of stdout data. Return EngineEvents + whether turn is complete. */
  readonly parseStdout: (chunk: string) => OutputParseResult;
  /** Parse a chunk of stderr data. */
  readonly parseStderr: (chunk: string) => readonly EngineEvent[];
  /** Called when process exits or turn ends. Return any buffered events. */
  readonly flush: () => readonly EngineEvent[];
}

/** Factory that creates a fresh OutputParser per stream() call. */
export type OutputParserFactory = () => OutputParser;

// ---------------------------------------------------------------------------
// Environment strategy
// ---------------------------------------------------------------------------

/** Controls which environment variables are passed to the child process. */
export type EnvStrategy =
  | { readonly kind: "inherit" }
  | { readonly kind: "allowlist"; readonly keys: readonly string[] }
  | { readonly kind: "explicit"; readonly env: Readonly<Record<string, string>> };

// ---------------------------------------------------------------------------
// Shutdown config
// ---------------------------------------------------------------------------

export interface ShutdownConfig {
  /** Signal to send first. Default: 15 (SIGTERM). */
  readonly signal?: number | undefined;
  /** Milliseconds to wait before SIGKILL. Default: 5000. */
  readonly gracePeriodMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Adapter config
// ---------------------------------------------------------------------------

export interface ExternalAdapterConfig {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: EnvStrategy | undefined;
  readonly parser?: OutputParserFactory | undefined;
  /** Total wall-clock timeout per stream() call. Default: 300_000 (5 min). 0 = none. */
  readonly timeoutMs?: number | undefined;
  /** Kill process if no stdout/stderr output for this many ms. Default: 0 (disabled). */
  readonly noOutputTimeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly shutdown?: ShutdownConfig | undefined;
  /** Process lifecycle mode. Default: "pty" (interactive CLI agents). */
  readonly mode?: "single-shot" | "long-lived" | "pty" | undefined;
  /** PTY-specific configuration. Used when mode is "pty" (the default). */
  readonly pty?: PtyConfig | undefined;
}

// ---------------------------------------------------------------------------
// Extended adapter interface
// ---------------------------------------------------------------------------

/** Engine adapter with additional methods for external process interaction. */
export interface ExternalEngineAdapter extends EngineAdapter {
  /** Write data to the running process's stdin (long-lived mode). */
  readonly write: (data: string) => void;
  /** Whether a child process is currently running. */
  readonly isRunning: () => boolean;
}

// ---------------------------------------------------------------------------
// Serializable state for saveState/loadState
// ---------------------------------------------------------------------------

export interface ExternalProcessState {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly outputHistory: readonly string[];
}

// ---------------------------------------------------------------------------
// PTY config
// ---------------------------------------------------------------------------

export interface PtyConfig {
  /** Silence threshold before idle detector fires. Default: 30_000 ms. */
  readonly idleThresholdMs?: number | undefined;
  /** Strip ANSI escape sequences from output. Default: true. */
  readonly ansiStrip?: boolean | undefined;
  /** PTY column count. Default: 120. */
  readonly cols?: number | undefined;
  /** PTY row count. Default: 40. */
  readonly rows?: number | undefined;
  /** Optional regex pattern for prompt-based turn completion (fast path). */
  readonly promptPattern?: string | undefined;
}

// ---------------------------------------------------------------------------
// Managed process (internal abstraction over Bun.spawn result)
// ---------------------------------------------------------------------------

/** Standard piped-IO process (single-shot and long-lived modes). */
export interface PipedProcess {
  readonly kind: "piped";
  readonly pid: number;
  readonly stdin: { write(data: string | Uint8Array): number | Promise<number>; end(): void };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number) => void;
}

/** PTY-based process for interactive CLI agents. */
export interface PtyProcess {
  readonly kind: "pty";
  readonly pid: number;
  readonly terminal: {
    readonly write: (data: string | Uint8Array) => number;
    readonly resize: (cols: number, rows: number) => void;
    readonly close: () => void;
    readonly closed: boolean;
  };
  readonly exited: Promise<number>;
  readonly kill: (signal?: number) => void;
}

export type ManagedProcess = PipedProcess | PtyProcess;
