/**
 * Context hydrator middleware — pre-loads context at session start
 * and prepends it as a system message on every model call.
 *
 * Supports:
 * - Custom source resolvers via registry
 * - Freeze-on-first-hydrate (single hydration per session)
 * - Periodic refresh of refreshable sources
 * - Context compaction for oversized sources
 * - Parallel token estimation
 */

import type {
  Agent,
  CapabilityFragment,
  ContextCompactor,
  InboundMessage,
  KoiMiddleware,
  TokenEstimator,
  TurnContext,
} from "@koi/core";
import { CHARS_PER_TOKEN, heuristicTokenEstimator } from "./estimator.js";
import { resolveFileSource } from "./sources/file.js";
import { resolveMemorySource } from "./sources/memory.js";
import { resolveSkillSource } from "./sources/skill.js";
import { resolveTextSource } from "./sources/text.js";
import { resolveToolSchemaSource } from "./sources/tool-schema.js";
import type {
  ContextManifestConfig,
  ContextSource,
  HydrationResult,
  SourceResolver,
  SourceResult,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_PRIORITY = 100;

/**
 * Dispatches to a built-in resolver using the discriminated union's `kind`.
 * The switch narrows `ContextSource` to the specific type each resolver expects.
 */
function resolveBuiltIn(source: ContextSource, agent: Agent): SourceResult | Promise<SourceResult> {
  switch (source.kind) {
    case "text":
      return resolveTextSource(source);
    case "file":
      return resolveFileSource(source);
    case "memory":
      return resolveMemorySource(source, agent);
    case "skill":
      return resolveSkillSource(source, agent);
    case "tool_schema":
      return resolveToolSchemaSource(source, agent);
  }
}

/** Built-in source kinds handled by the discriminated union switch. */
const BUILT_IN_KINDS = new Set(["text", "file", "memory", "skill", "tool_schema"]);

export interface ContextHydratorOptions {
  readonly config: ContextManifestConfig;
  readonly agent: Agent;
  readonly estimator?: TokenEstimator;
  /** Custom source resolvers. Keys are source `kind` strings. Overrides built-in resolvers. */
  readonly resolvers?: ReadonlyMap<string, SourceResolver>;
  /** Optional compactor to shrink oversized sources before dropping them. */
  readonly compactor?: ContextCompactor;
}

/**
 * Extended middleware type returned by `createContextHydrator`.
 * Adds a `getHydrationResult()` accessor for observability/telemetry.
 */
export interface ContextHydratorMiddleware extends KoiMiddleware {
  /** Returns the current hydration result, or undefined if not yet hydrated. */
  readonly getHydrationResult: () => HydrationResult | undefined;
}

/** Frozen cache of hydration results and the pre-built system message. */
interface HydrationCache {
  readonly result: HydrationResult;
  readonly systemMessage: InboundMessage | undefined;
}

/**
 * Resolves a single source. Custom resolvers override built-in ones.
 * Always returns a Promise so throws are auto-wrapped as rejected promises
 * for use with Promise.allSettled.
 */
async function resolveSource(
  source: ContextSource,
  agent: Agent,
  customResolvers: ReadonlyMap<string, SourceResolver> | undefined,
): Promise<SourceResult> {
  // Custom resolver takes priority
  const custom = customResolvers?.get(source.kind);
  if (custom !== undefined) {
    return custom(source, agent);
  }

  // Built-in dispatch via discriminated union switch (no type assertions)
  if (BUILT_IN_KINDS.has(source.kind)) {
    return resolveBuiltIn(source, agent);
  }

  throw new Error(`No resolver registered for source kind: ${source.kind}`);
}

const TRUNCATION_NOTICE = "\n\n[Content truncated — source exceeded per-source token limit]";
const DROP_NOTICE_PREFIX =
  "\n\n---\n\n> **Note:** The following context sources were dropped due to token budget constraints:";

/**
 * Truncates content to fit within a token budget using the heuristic estimator.
 * Appends a truncation notice so the agent knows content was cut.
 */
function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, maxChars) + TRUNCATION_NOTICE;
}

/**
 * Assembles resolved sources into a formatted system message.
 * Uses section labels to separate content blocks.
 * Appends drop notice if any sources were excluded.
 */
function assembleContent(
  sources: readonly SourceResult[],
  droppedLabels: readonly string[],
): string {
  const sections = sources.map((s) => `## ${s.label}\n\n${s.content}`).join("\n\n---\n\n");

  if (droppedLabels.length === 0) {
    return sections;
  }

  const dropList = droppedLabels.map((l) => `> - ${l}`).join("\n");
  return `${sections + DROP_NOTICE_PREFIX}\n${dropList}`;
}

/** Immutable accumulator for budget accumulation. */
interface BudgetAccumulator {
  readonly included: readonly SourceResult[];
  readonly warnings: readonly string[];
  readonly droppedLabels: readonly string[];
  readonly totalTokens: number;
}

/**
 * Attempts to compact an oversized source to fit within remaining budget.
 * Returns the compacted source result if it fits, undefined otherwise.
 */
async function tryCompactSource(
  result: SourceResult,
  remaining: number,
  compactor: ContextCompactor,
  estimator: TokenEstimator,
): Promise<SourceResult | undefined> {
  const compactionResult = await compactor.compact(
    [
      {
        content: [{ kind: "text", text: result.content }],
        senderId: "system:context",
        timestamp: Date.now(),
      },
    ],
    remaining,
  );
  if (compactionResult.messages.length === 0) {
    return undefined;
  }
  const compactedText = compactionResult.messages
    .flatMap((m) => m.content)
    .filter((b) => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
  const compactedTokens = await estimator.estimateText(compactedText);
  if (compactedTokens > remaining) {
    return undefined;
  }
  return { ...result, content: compactedText, tokens: compactedTokens };
}

/**
 * Accumulates sources into budget, handling single-source truncation and compaction.
 */
async function accumulateWithinBudget(
  estimated: readonly SourceResult[],
  globalBudget: number,
  estimator: TokenEstimator,
  compactor: ContextCompactor | undefined,
): Promise<BudgetAccumulator> {
  let acc: BudgetAccumulator = { included: [], warnings: [], droppedLabels: [], totalTokens: 0 };

  for (const result of estimated) {
    if (acc.totalTokens + result.tokens <= globalBudget) {
      acc = {
        ...acc,
        included: [...acc.included, result],
        totalTokens: acc.totalTokens + result.tokens,
      };
      continue;
    }

    // Single-source fix: if nothing included yet, truncate first source to fill budget
    if (acc.included.length === 0) {
      const truncatedContent = truncateToTokens(result.content, globalBudget);
      const truncatedTokens = await estimator.estimateText(truncatedContent);
      acc = {
        ...acc,
        included: [{ ...result, content: truncatedContent, tokens: truncatedTokens }],
        totalTokens: truncatedTokens,
        warnings: [
          ...acc.warnings,
          `Source "${result.label}" truncated to fit token budget (${result.tokens}→${truncatedTokens}/${globalBudget})`,
        ],
      };
      continue;
    }

    // Compaction fallback
    if (compactor !== undefined) {
      const compacted = await tryCompactSource(
        result,
        globalBudget - acc.totalTokens,
        compactor,
        estimator,
      );
      if (compacted !== undefined) {
        acc = {
          ...acc,
          included: [...acc.included, compacted],
          totalTokens: acc.totalTokens + compacted.tokens,
        };
        continue;
      }
    }

    // Drop the source
    acc = {
      ...acc,
      warnings: [
        ...acc.warnings,
        `Source "${result.label}" dropped — would exceed token budget (${acc.totalTokens + result.tokens}/${globalBudget})`,
      ],
      droppedLabels: [...acc.droppedLabels, result.label],
    };
  }

  return acc;
}

/**
 * Sorts and truncates sources, then estimates tokens in parallel.
 */
async function prepareEstimatedSources(
  resolved: readonly SourceResult[],
  estimator: TokenEstimator,
): Promise<readonly SourceResult[]> {
  const sorted = [...resolved].sort(
    (a, b) => (a.source.priority ?? DEFAULT_PRIORITY) - (b.source.priority ?? DEFAULT_PRIORITY),
  );
  const truncated = sorted.map((result) => {
    if (result.source.maxTokens === undefined) {
      return result;
    }
    return { ...result, content: truncateToTokens(result.content, result.source.maxTokens) };
  });
  const tokenCounts = await Promise.all(
    truncated.map((result) => estimator.estimateText(result.content)),
  );
  return truncated.map((result, i) => ({ ...result, tokens: tokenCounts[i] ?? 0 }));
}

/**
 * Assembles resolved sources into a budgeted HydrationResult.
 *
 * Pipeline: sort → truncate → estimate → accumulate → assemble.
 */
async function assembleBudgetedContent(
  resolved: readonly SourceResult[],
  estimator: TokenEstimator,
  globalBudget: number,
  compactor: ContextCompactor | undefined,
): Promise<HydrationResult> {
  const estimated = await prepareEstimatedSources(resolved, estimator);
  const { included, warnings, droppedLabels, totalTokens } = await accumulateWithinBudget(
    estimated,
    globalBudget,
    estimator,
    compactor,
  );
  const content = included.length > 0 ? assembleContent(included, droppedLabels) : "";
  return { content, totalTokens, sources: included, warnings };
}

/**
 * Runs the full hydration pipeline:
 * 1. Resolve all sources in parallel
 * 2. Handle failures per required flag
 * 3. Delegate to assembleBudgetedContent for budgeting + assembly
 */
async function hydrate(
  config: ContextManifestConfig,
  agent: Agent,
  estimator: TokenEstimator,
  resolvers: ReadonlyMap<string, SourceResolver> | undefined,
  compactor: ContextCompactor | undefined,
): Promise<HydrationResult> {
  const globalBudget = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  // 1. Resolve all sources in parallel
  const settlements = await Promise.allSettled(
    config.sources.map((source) => resolveSource(source, agent, resolvers)),
  );

  // 2. Handle failures per required flag
  let resolved: readonly SourceResult[] = [];
  let warnings: readonly string[] = [];

  for (let i = 0; i < settlements.length; i++) {
    const settlement = settlements[i];
    const source = config.sources[i];

    if (settlement === undefined || source === undefined) {
      continue;
    }

    if (settlement.status === "fulfilled") {
      resolved = [...resolved, settlement.value];
    } else {
      const reason =
        settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);

      if (source.required === true) {
        throw new Error(
          `Required context source failed: ${source.label ?? source.kind} — ${reason}`,
        );
      }

      warnings = [
        ...warnings,
        `Optional source "${source.label ?? source.kind}" failed: ${reason}`,
      ];
    }
  }

  // 3. Budget + assemble
  const budgeted = await assembleBudgetedContent(resolved, estimator, globalBudget, compactor);

  return {
    ...budgeted,
    warnings: [...warnings, ...budgeted.warnings],
  };
}

/**
 * Builds a system message from hydrated content.
 * Uses hydration timestamp (not call-time) since the content is static.
 */
function buildSystemMessage(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "system:context",
    timestamp: Date.now(),
  };
}

/** Builds a HydrationCache from a HydrationResult. */
function toCache(result: HydrationResult): HydrationCache {
  const systemMessage = result.content !== "" ? buildSystemMessage(result.content) : undefined;
  return { result, systemMessage };
}

/** Returns true when a refresh should be triggered on this turn. */
function shouldRefresh(refreshInterval: number | undefined, turnIndex: number): boolean {
  return refreshInterval !== undefined && turnIndex > 0 && turnIndex % refreshInterval === 0;
}

/**
 * Collects fresh settlements into a results map and warnings for failures.
 */
function collectRefreshResults(
  settlements: readonly PromiseSettledResult<SourceResult>[],
  sources: readonly ContextSource[],
): {
  readonly freshResults: ReadonlyMap<string, SourceResult>;
  readonly warnings: readonly string[];
} {
  const freshResults = new Map<string, SourceResult>();
  let warnings: readonly string[] = [];

  for (let i = 0; i < settlements.length; i++) {
    const settlement = settlements[i];
    const source = sources[i];
    if (settlement === undefined || source === undefined) {
      continue;
    }
    if (settlement.status === "fulfilled") {
      const fresh = settlement.value;
      freshResults.set(`${fresh.source.kind}:${fresh.label}`, fresh);
    } else {
      const reason =
        settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
      warnings = [
        ...warnings,
        `Refresh failed for "${source.label ?? source.kind}" (stale cached version kept): ${reason}`,
      ];
    }
  }

  return { freshResults, warnings };
}

/**
 * Merges fresh results into cached sources, replacing refreshable ones.
 */
function mergeFreshWithCached(
  cached: readonly SourceResult[],
  freshResults: ReadonlyMap<string, SourceResult>,
): readonly SourceResult[] {
  return cached.map((item) => {
    if (item.source.refreshable !== true) {
      return item;
    }
    const key = `${item.source.kind}:${item.label}`;
    return freshResults.get(key) ?? item;
  });
}

/**
 * Creates a context hydrator middleware.
 *
 * Hydrates context once on session start, then prepends it as a system
 * message on every model call (both streaming and non-streaming).
 *
 * Supports periodic refresh of refreshable sources via `config.refreshInterval`.
 *
 * @param options - Config, agent reference, and optional token estimator / resolvers / compactor
 * @returns ContextHydratorMiddleware with priority 300
 */
export function createContextHydrator(options: ContextHydratorOptions): ContextHydratorMiddleware {
  const { config, agent, estimator = heuristicTokenEstimator, compactor, resolvers } = options;

  // Frozen hydration state — set once in onSessionStart, refreshed on interval
  const state: { hydration: HydrationCache | undefined } = { hydration: undefined };

  const globalBudgetForDisplay = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    name: "context-hydrator",
    priority: 300,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => {
      const hydratedTokens = state.hydration?.result.totalTokens;
      return {
        label: "context",
        description:
          `Context: ${String(config.sources.length)} sources, ${String(hydratedTokens ?? 0)}/${String(globalBudgetForDisplay)} token budget` +
          (config.refreshInterval !== undefined
            ? `, refresh every ${String(config.refreshInterval)} turns`
            : ""),
      };
    },

    getHydrationResult(): HydrationResult | undefined {
      return state.hydration?.result;
    },

    async onSessionStart() {
      if (state.hydration !== undefined) {
        throw new Error("Context already hydrated — cannot re-hydrate in same session");
      }
      const result = await hydrate(config, agent, estimator, resolvers, compactor);
      state.hydration = toCache(result);
    },

    async onBeforeTurn(ctx) {
      const currentHydration = state.hydration;
      if (currentHydration === undefined || !shouldRefresh(config.refreshInterval, ctx.turnIndex)) {
        return;
      }
      const refreshableSources = config.sources.filter((s) => s.refreshable === true);
      if (refreshableSources.length === 0) {
        return;
      }

      const freshSettlements = await Promise.allSettled(
        refreshableSources.map((source) => resolveSource(source, agent, resolvers)),
      );
      const { freshResults, warnings } = collectRefreshResults(
        freshSettlements,
        refreshableSources,
      );
      const merged = mergeFreshWithCached(currentHydration.result.sources, freshResults);
      const globalBudget = config.maxTokens ?? DEFAULT_MAX_TOKENS;
      const budgeted = await assembleBudgetedContent(merged, estimator, globalBudget, compactor);
      state.hydration = toCache({ ...budgeted, warnings: [...warnings, ...budgeted.warnings] });
    },

    async wrapModelCall(_ctx, request, next) {
      if (state.hydration?.systemMessage === undefined) {
        return next(request);
      }
      return next({
        ...request,
        messages: [state.hydration.systemMessage, ...request.messages],
      });
    },

    async *wrapModelStream(_ctx, request, next) {
      if (state.hydration?.systemMessage === undefined) {
        yield* next(request);
        return;
      }
      yield* next({
        ...request,
        messages: [state.hydration.systemMessage, ...request.messages],
      });
    },
  };
}
