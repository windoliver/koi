/**
 * @koi/harness — type contracts.
 *
 * All types use L0 (`@koi/core`) definitions only — no L1 imports.
 * The engine runtime is injected structurally via HarnessRuntime.
 */

import type { ChannelAdapter, EngineEvent, EngineInput, EngineOutput, TuiAdapter } from "@koi/core";

// ---------------------------------------------------------------------------
// HarnessRuntime — structural interface for injected engine runtime.
// KoiRuntime from @koi/engine satisfies this via structural typing.
// ---------------------------------------------------------------------------

export interface HarnessRuntime {
  /** Run one agent turn, returning an async iterable of engine events. */
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
  /** Release resources. Called during harness shutdown. */
  readonly dispose?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// CliHarnessConfig — inputs to createCliHarness()
// ---------------------------------------------------------------------------

export interface CliHarnessConfig {
  /** Pre-built engine runtime (KoiRuntime satisfies this structurally). */
  readonly runtime: HarnessRuntime;
  /** Channel adapter for user I/O. */
  readonly channel: ChannelAdapter;
  /**
   * Optional TUI adapter. When null or omitted, engine events render to
   * the `output` stream (raw-stdout fallback). Both code paths are tested.
   */
  readonly tui?: TuiAdapter | null;
  /** Show internal engine events (tool calls, thinking, etc.) on stdout. */
  readonly verbose?: boolean;
  /**
   * Maximum number of REPL turns before the session is closed gracefully.
   * Enforced at the harness level as a backstop even if the engine adapter
   * does not enforce its own limit. Defaults to Number.MAX_SAFE_INTEGER.
   */
  readonly maxTurns?: number;
  /**
   * AbortSignal for graceful shutdown. Wire SIGINT → AbortController.abort()
   * in the L3 command layer. The signal is forwarded into every engine turn.
   */
  readonly signal?: AbortSignal;
  /** Stream for raw-stdout event rendering when tui is null. Defaults to process.stdout. */
  readonly output?: NodeJS.WritableStream;
}

// ---------------------------------------------------------------------------
// CliHarness — returned by createCliHarness()
// ---------------------------------------------------------------------------

export interface CliHarness {
  /**
   * Execute one agent turn with a fixed text prompt. Returns the engine output.
   * The channel is NOT connected — caller is responsible for it if needed.
   * Cleans up (dispose, channel) before returning.
   */
  readonly runSinglePrompt: (text: string) => Promise<EngineOutput>;
  /**
   * Enter interactive REPL mode. Connects the channel, loops until the
   * abort signal fires or maxTurns is reached, then disconnects and disposes.
   */
  readonly runInteractive: () => Promise<void>;
}
