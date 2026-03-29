/**
 * AsyncLocalStorage-based span recorder for tool child spans.
 *
 * The engine sets a SpanRecorder before tool.execute(). Tool-internal packages
 * (sandbox-wasm, subprocess-executor, etc.) call getSpanRecorder()?.record()
 * to report timing. Collected spans surface in the debug waterfall as children
 * of the tool call.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A child span recorded during tool execution. */
export interface ChildSpanRecord {
  /** Human-readable label, e.g. "sandbox-wasm", "subprocess-executor". */
  readonly label: string;
  readonly durationMs: number;
  readonly error?: string | undefined;
  /** Arbitrary metadata surfaced in the waterfall (e.g. memoryUsedBytes). */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** Accumulates child spans for a single tool execution. */
export interface SpanRecorder {
  readonly record: (span: ChildSpanRecord) => void;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage store
// ---------------------------------------------------------------------------

const storage = new AsyncLocalStorage<SpanRecorder>();

/** Get the current span recorder, or undefined if not in a tool execution scope. */
export function getSpanRecorder(): SpanRecorder | undefined {
  return storage.getStore();
}

/** Run a function within a span recorder scope. */
export function runWithSpanRecorder<T>(recorder: SpanRecorder, fn: () => T): T {
  return storage.run(recorder, fn);
}
