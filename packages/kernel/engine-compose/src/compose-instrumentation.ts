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

export type VisibilityTier = "critical" | "secondary" | "all";

export interface ResolverSpan {
  readonly toolId: string;
  readonly source: "forged" | "entity" | "miss";
  readonly durationMs: number;
}

export interface ChannelIOSpan {
  readonly direction: "in" | "out";
  readonly kind: "model_call" | "tool_call" | "model_stream";
  readonly durationMs: number;
}

export interface ForgeRefreshSpan {
  readonly descriptorsChanged: boolean;
  readonly descriptorCount: number;
  readonly middlewareRecomposed: boolean;
  readonly timestamp: number;
}

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
  readonly tier?: VisibilityTier | undefined;
}

export interface DebugTurnTrace {
  readonly turnIndex: number;
  readonly totalDurationMs: number;
  readonly spans: readonly DebugSpan[];
  readonly timestamp: number;
  readonly resolverSpans?: readonly ResolverSpan[] | undefined;
  readonly channelSpans?: readonly ChannelIOSpan[] | undefined;
  readonly forgeSpans?: readonly ForgeRefreshSpan[] | undefined;
}

export interface DebugInventoryItem {
  readonly name: string;
  readonly category: "middleware" | "tool" | "skill" | "channel" | "engine" | "subsystem";
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
  readonly tier?: VisibilityTier | undefined;
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
  /** Record a resolver span (tool resolution timing). */
  readonly recordResolve: (event: ResolverSpan & { readonly turnIndex: number }) => void;
  /** Record a channel I/O span (model/tool call timing). */
  readonly recordChannelIO: (event: ChannelIOSpan & { readonly turnIndex: number }) => void;
  /** Record a forge refresh span (descriptor/middleware refresh timing). */
  readonly recordForgeRefresh: (event: ForgeRefreshSpan & { readonly turnIndex: number }) => void;
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
// Span tree builder — groups flat spans by hook into a hierarchy
// ---------------------------------------------------------------------------

/**
 * Group raw spans by their hook label to create parent/child nesting.
 *
 * Each unique hook (e.g., "wrapModelCall", "wrapToolCall") becomes a parent
 * span whose children are the individual middleware spans for that hook.
 */
function buildSpanTree(rawSpans: readonly RawSpan[]): readonly DebugSpan[] {
  // Group by hook label, preserving insertion order
  const groups = new Map<string, RawSpan[]>();
  for (const span of rawSpans) {
    const list = groups.get(span.hook);
    if (list !== undefined) {
      list.push(span);
    } else {
      groups.set(span.hook, [span]);
    }
  }

  const result: DebugSpan[] = [];

  for (const [hookLabel, spans] of groups) {
    const children: readonly DebugSpan[] = spans.map((s) => ({
      name: s.name,
      hook: s.hook,
      durationMs: s.durationMs,
      source: s.source,
      phase: s.phase,
      priority: s.priority,
      nextCalled: s.nextCalled,
      ...(s.error !== undefined ? { error: s.error } : {}),
      ...(s.tier !== undefined ? { tier: s.tier } : {}),
    }));

    const totalMs = spans.reduce((sum, s) => sum + s.durationMs, 0);

    // Create parent span that groups all middleware for this hook
    result.push({
      name: hookLabel,
      hook: hookLabel,
      durationMs: totalMs,
      source: "static",
      phase: "resolve",
      priority: 0,
      nextCalled: true,
      tier: "critical",
      children,
    });
  }

  return result;
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
  const resolverAccumulators = new Map<number, ResolverSpan[]>();
  const channelAccumulators = new Map<number, ChannelIOSpan[]>();
  const forgeAccumulators = new Map<number, ForgeRefreshSpan[]>();
  const provenanceMap = new Map<string, MiddlewareSource>();
  /** Tracks which middleware name was last used on which turn. */
  const lastUsedTurnMap = new Map<string, number>();
  /** Tracks which middleware names belong to concurrent observe phase. */
  const concurrentSet = new Set<string>();
  /** Tracks phase per middleware name (for inventory). */
  const phaseTracker = new Map<string, string>();
  /** Tracks priority per middleware name (for inventory). */
  const priorityTracker = new Map<string, number>();
  /** Tracks which hooks each middleware implements (for inventory). */
  const hooksTracker = new Map<string, Set<string>>();

  function wrapEntries<Req, Res>(
    entries: readonly InstrumentableEntry<Req, Res>[],
    hookLabel: string,
    provMap: ReadonlyMap<string, MiddlewareSource>,
    phaseMap: ReadonlyMap<string, string>,
    priorityMap: ReadonlyMap<string, number>,
  ): readonly InstrumentableEntry<Req, Res>[] {
    // Populate the shared tracking maps
    for (const [name, source] of provMap) {
      provenanceMap.set(name, source);
    }
    for (const [name, phase] of phaseMap) {
      phaseTracker.set(name, phase);
    }
    for (const [name, prio] of priorityMap) {
      priorityTracker.set(name, prio);
    }

    return entries.map((entry) => {
      const source = provMap.get(entry.name) ?? "static";
      const phase = phaseMap.get(entry.name) ?? "resolve";
      const priority = priorityMap.get(entry.name) ?? 500;
      // Track hooks per middleware
      const hookSet = hooksTracker.get(entry.name) ?? new Set<string>();
      hookSet.add(hookLabel);
      hooksTracker.set(entry.name, hookSet);
      // Concurrent observers get "secondary" tier, everything else is "critical"
      const isConcurrent = phase === "observe" && priority >= 900;
      if (isConcurrent) concurrentSet.add(entry.name);
      const tier: VisibilityTier = isConcurrent ? "secondary" : "critical";

      const wrappedHook = (ctx: TurnContext, req: Req, next: (r: Req) => Res): Res => {
        const start = performance.now();
        // let justified: mutable flag toggled by next() call tracking
        let nextCalled = false;
        const trackedNext = (r: Req): Res => {
          nextCalled = true;
          return next(r);
        };

        // Track last used turn for lifecycle badges
        lastUsedTurnMap.set(entry.name, ctx.turnIndex);

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
                  tier,
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
                  tier,
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
            tier,
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
            tier,
          });
          throw e;
        }
      };

      return { name: entry.name, hook: wrappedHook };
    });
  }

  function recordResolve(event: ResolverSpan & { readonly turnIndex: number }): void {
    const { turnIndex, ...span } = event;
    const existing = resolverAccumulators.get(turnIndex);
    if (existing !== undefined) {
      existing.push(span);
    } else {
      resolverAccumulators.set(turnIndex, [span]);
    }
  }

  function recordChannelIO(event: ChannelIOSpan & { readonly turnIndex: number }): void {
    const { turnIndex, ...span } = event;
    const existing = channelAccumulators.get(turnIndex);
    if (existing !== undefined) {
      existing.push(span);
    } else {
      channelAccumulators.set(turnIndex, [span]);
    }
  }

  function recordForgeRefresh(event: ForgeRefreshSpan & { readonly turnIndex: number }): void {
    const { turnIndex, ...span } = event;
    const existing = forgeAccumulators.get(turnIndex);
    if (existing !== undefined) {
      existing.push(span);
    } else {
      forgeAccumulators.set(turnIndex, [span]);
    }
  }

  function onTurnEnd(turnIndex: number): void {
    const rawSpans = spanAccumulators.get(turnIndex);
    spanAccumulators.delete(turnIndex);

    const resolverSpans = resolverAccumulators.get(turnIndex);
    resolverAccumulators.delete(turnIndex);

    const channelSpans = channelAccumulators.get(turnIndex);
    channelAccumulators.delete(turnIndex);

    const forgeSpans = forgeAccumulators.get(turnIndex);
    forgeAccumulators.delete(turnIndex);

    const spans = buildSpanTree(rawSpans ?? []);

    const totalDurationMs = spans.reduce((sum, s) => sum + s.durationMs, 0);

    traceBuffer.push({
      turnIndex,
      totalDurationMs,
      spans,
      timestamp: Date.now(),
      ...(resolverSpans !== undefined && resolverSpans.length > 0 ? { resolverSpans } : {}),
      ...(channelSpans !== undefined && channelSpans.length > 0 ? { channelSpans } : {}),
      ...(forgeSpans !== undefined && forgeSpans.length > 0 ? { forgeSpans } : {}),
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
      ...(phaseTracker.has(name) ? { phase: phaseTracker.get(name) } : {}),
      ...(priorityTracker.has(name) ? { priority: priorityTracker.get(name) } : {}),
      ...(hooksTracker.has(name) ? { hooks: [...(hooksTracker.get(name) ?? [])] } : {}),
      ...(lastUsedTurnMap.has(name) ? { lastUsedTurn: lastUsedTurnMap.get(name) } : {}),
      ...(concurrentSet.has(name) ? { concurrent: true } : {}),
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
    recordResolve,
    recordChannelIO,
    recordForgeRefresh,
  };
}
