/**
 * Debug instrumentation for middleware composition.
 *
 * Provides per-middleware timing spans, turn-level trace collection,
 * and inventory snapshots for the debug dashboard.
 */

import type { TurnContext } from "@koi/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MiddlewareSource = "static" | "forged" | "dynamic";

export interface DebugSpan {
  readonly name: string;
  readonly hook: string;
  readonly durationMs: number;
  readonly source: MiddlewareSource;
  readonly phase: string;
  readonly priority: number;
  readonly nextCalled: boolean;
  readonly error?: string | undefined;
  readonly children?: readonly DebugSpan[] | undefined;
}

export interface DebugTurnTrace {
  readonly turnIndex: number;
  readonly totalDurationMs: number;
  readonly spans: readonly DebugSpan[];
  readonly timestamp: number;
}

export interface DebugInventoryItem {
  readonly name: string;
  readonly category: "middleware" | "tool" | "skill" | "channel" | "engine";
  readonly enabled: boolean;
  readonly source: MiddlewareSource | "operator" | "manifest";
  readonly hooks?: readonly string[] | undefined;
  readonly phase?: string | undefined;
  readonly priority?: number | undefined;
  readonly concurrent?: boolean | undefined;
  readonly lastUsedTurn?: number | undefined;
}

export interface DebugInventory {
  readonly agentId: string;
  readonly items: readonly DebugInventoryItem[];
  readonly timestamp: number;
}

export interface DebugInstrumentationConfig {
  readonly enabled: boolean;
  readonly bufferSize?: number | undefined;
}

// ---------------------------------------------------------------------------
// Internal raw span (mutable accumulation before freeze)
// ---------------------------------------------------------------------------

interface RawSpan {
  readonly name: string;
  readonly hook: string;
  readonly durationMs: number;
  readonly source: MiddlewareSource;
  readonly phase: string;
  readonly priority: number;
  readonly nextCalled: boolean;
  readonly error?: string | undefined;
}

// ---------------------------------------------------------------------------
// OnionEntry shape (matches compose.ts OnionEntry)
// ---------------------------------------------------------------------------

interface InstrumentableEntry<Req, Res> {
  readonly name: string;
  readonly hook: (ctx: TurnContext, req: Req, next: (r: Req) => Res) => Res;
}

// ---------------------------------------------------------------------------
// Debug instrumentation interface
// ---------------------------------------------------------------------------

export interface DebugInstrumentation {
  /** Wraps a middleware's hooks with timing decorators. Returns wrapped entries. */
  readonly wrapEntries: <Req, Res>(
    entries: readonly InstrumentableEntry<Req, Res>[],
    hookLabel: string,
    provenanceMap: ReadonlyMap<string, MiddlewareSource>,
    phaseMap: ReadonlyMap<string, string>,
    priorityMap: ReadonlyMap<string, number>,
  ) => readonly InstrumentableEntry<Req, Res>[];
  /** Call after each turn to build and store the span tree. */
  readonly onTurnEnd: (turnIndex: number) => void;
  /** Get the pre-built trace for a turn. */
  readonly getTrace: (turnIndex: number) => DebugTurnTrace | undefined;
  /** Build an inventory snapshot from middleware + other items. */
  readonly buildInventory: (
    agentId: string,
    extraItems: readonly DebugInventoryItem[],
  ) => DebugInventory;
  /** Get the provenance map (populated during wrapEntries). */
  readonly provenanceMap: Map<string, MiddlewareSource>;
}

// ---------------------------------------------------------------------------
// Ring buffer — ephemeral debug data with O(1) lookup
// ---------------------------------------------------------------------------

interface DebugRingBuffer<T extends { readonly turnIndex: number }> {
  readonly push: (entry: T) => void;
  readonly get: (turnIndex: number) => T | undefined;
  readonly clear: () => void;
}

function createDebugRingBuffer<T extends { readonly turnIndex: number }>(
  maxSize: number,
): DebugRingBuffer<T> {
  const buffer: (T | undefined)[] = [];
  const indexMap = new Map<number, number>();
  // let justified: mutable write cursor for ring buffer wrap-around
  let cursor = 0;

  return {
    push(entry: T): void {
      // Evict the oldest entry if the buffer is full
      const evicted = buffer[cursor];
      if (buffer.length >= maxSize && evicted !== undefined) {
        indexMap.delete(evicted.turnIndex);
      }
      buffer[cursor] = entry;
      indexMap.set(entry.turnIndex, cursor);
      cursor = (cursor + 1) % maxSize;
    },

    get(turnIndex: number): T | undefined {
      const idx = indexMap.get(turnIndex);
      if (idx === undefined) return undefined;
      return buffer[idx];
    },

    clear(): void {
      buffer.length = 0;
      indexMap.clear();
      cursor = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Promise detection type guard
// ---------------------------------------------------------------------------

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// ---------------------------------------------------------------------------
// Span recording helper
// ---------------------------------------------------------------------------

function recordSpan(accumulators: Map<number, RawSpan[]>, turnIndex: number, span: RawSpan): void {
  const existing = accumulators.get(turnIndex);
  if (existing !== undefined) {
    existing.push(span);
  } else {
    accumulators.set(turnIndex, [span]);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_BUFFER_SIZE = 500;

/** Create the debug instrumentation instance for middleware timing. */
export function createDebugInstrumentation(
  config: DebugInstrumentationConfig,
): DebugInstrumentation {
  const bufferSize = config.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const traceBuffer = createDebugRingBuffer<DebugTurnTrace>(bufferSize);
  const spanAccumulators = new Map<number, RawSpan[]>();
  const provenanceMap = new Map<string, MiddlewareSource>();

  function wrapEntries<Req, Res>(
    entries: readonly InstrumentableEntry<Req, Res>[],
    hookLabel: string,
    provMap: ReadonlyMap<string, MiddlewareSource>,
    phaseMap: ReadonlyMap<string, string>,
    priorityMap: ReadonlyMap<string, number>,
  ): readonly InstrumentableEntry<Req, Res>[] {
    // Populate the shared provenance map
    for (const [name, source] of provMap) {
      provenanceMap.set(name, source);
    }

    return entries.map((entry) => {
      const source = provMap.get(entry.name) ?? "static";
      const phase = phaseMap.get(entry.name) ?? "resolve";
      const priority = priorityMap.get(entry.name) ?? 500;

      const wrappedHook = (ctx: TurnContext, req: Req, next: (r: Req) => Res): Res => {
        const start = performance.now();
        // let justified: mutable flag toggled by next() call tracking
        let nextCalled = false;
        const trackedNext = (r: Req): Res => {
          nextCalled = true;
          return next(r);
        };
        try {
          const result = entry.hook(ctx, req, trackedNext);
          if (isPromiseLike(result)) {
            return (result as PromiseLike<unknown>).then(
              (resolved) => {
                recordSpan(spanAccumulators, ctx.turnIndex, {
                  name: entry.name,
                  hook: hookLabel,
                  durationMs: performance.now() - start,
                  source,
                  phase,
                  priority,
                  nextCalled,
                });
                return resolved;
              },
              (err: unknown) => {
                recordSpan(spanAccumulators, ctx.turnIndex, {
                  name: entry.name,
                  hook: hookLabel,
                  durationMs: performance.now() - start,
                  source,
                  phase,
                  priority,
                  nextCalled,
                  error: err instanceof Error ? err.message : String(err),
                });
                throw err;
              },
            ) as Res;
          }
          // Sync result
          recordSpan(spanAccumulators, ctx.turnIndex, {
            name: entry.name,
            hook: hookLabel,
            durationMs: performance.now() - start,
            source,
            phase,
            priority,
            nextCalled,
          });
          return result;
        } catch (e: unknown) {
          recordSpan(spanAccumulators, ctx.turnIndex, {
            name: entry.name,
            hook: hookLabel,
            durationMs: performance.now() - start,
            source,
            phase,
            priority,
            nextCalled,
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
      };

      return { name: entry.name, hook: wrappedHook };
    });
  }

  function onTurnEnd(turnIndex: number): void {
    const rawSpans = spanAccumulators.get(turnIndex);
    spanAccumulators.delete(turnIndex);

    const spans: readonly DebugSpan[] = (rawSpans ?? []).map((s) => ({
      name: s.name,
      hook: s.hook,
      durationMs: s.durationMs,
      source: s.source,
      phase: s.phase,
      priority: s.priority,
      nextCalled: s.nextCalled,
      ...(s.error !== undefined ? { error: s.error } : {}),
    }));

    const totalDurationMs = spans.reduce((sum, s) => sum + s.durationMs, 0);

    traceBuffer.push({
      turnIndex,
      totalDurationMs,
      spans,
      timestamp: Date.now(),
    });
  }

  function getTrace(turnIndex: number): DebugTurnTrace | undefined {
    return traceBuffer.get(turnIndex);
  }

  function buildInventory(
    agentId: string,
    extraItems: readonly DebugInventoryItem[],
  ): DebugInventory {
    const mwItems: readonly DebugInventoryItem[] = [...provenanceMap].map(([name, source]) => ({
      name,
      category: "middleware" as const,
      enabled: true,
      source,
    }));

    return {
      agentId,
      items: [...mwItems, ...extraItems],
      timestamp: Date.now(),
    };
  }

  return {
    wrapEntries,
    onTurnEnd,
    getTrace,
    buildInventory,
    provenanceMap,
  };
}
