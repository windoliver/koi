/**
 * Context hydrator middleware — pre-loads context at session start
 * and prepends it as a system message on every model call.
 */

import type { Agent, InboundMessage, KoiMiddleware, TokenEstimator } from "@koi/core";
import { heuristicTokenEstimator } from "./estimator.js";
import { resolveFileSource } from "./sources/file.js";
import { resolveMemorySource } from "./sources/memory.js";
import { resolveSkillSource } from "./sources/skill.js";
import { resolveTextSource } from "./sources/text.js";
import { resolveToolSchemaSource } from "./sources/tool-schema.js";
import type {
  ContextManifestConfig,
  ContextSource,
  HydrationResult,
  SourceResult,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_PRIORITY = 100;
const CHARS_PER_TOKEN = 4;

export interface ContextHydratorOptions {
  readonly config: ContextManifestConfig;
  readonly agent: Agent;
  readonly estimator?: TokenEstimator;
}

/**
 * Resolves a single context source into a SourceResult.
 * Dispatches based on the source's `kind` discriminant.
 */
function resolveSource(source: ContextSource, agent: Agent): Promise<SourceResult> {
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

/**
 * Runs the full hydration pipeline:
 * 1. Resolve all sources in parallel
 * 2. Handle failures per required flag
 * 3. Sort by priority (lower = higher priority)
 * 4. Truncate per-source if maxTokens set
 * 5. Accumulate until global budget reached
 * 6. Assemble content
 */
async function hydrate(
  config: ContextManifestConfig,
  agent: Agent,
  estimator: TokenEstimator,
): Promise<HydrationResult> {
  const globalBudget = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const warnings: string[] = [];

  // 1. Resolve all sources in parallel
  const settlements = await Promise.allSettled(
    config.sources.map((source) => resolveSource(source, agent)),
  );

  // 2. Handle failures per required flag
  const resolved: SourceResult[] = [];
  for (let i = 0; i < settlements.length; i++) {
    const settlement = settlements[i];
    const source = config.sources[i];

    // Invariant: settlements and sources have the same length
    if (settlement === undefined || source === undefined) {
      continue;
    }

    if (settlement.status === "fulfilled") {
      resolved.push(settlement.value);
    } else {
      const reason =
        settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);

      if (source.required === true) {
        throw new Error(
          `Required context source failed: ${source.label ?? source.kind} — ${reason}`,
        );
      }
      warnings.push(`Optional source "${source.label ?? source.kind}" failed: ${reason}`);
    }
  }

  // 3. Sort by priority (lower = higher priority, default: 100)
  const sorted = [...resolved].sort(
    (a, b) => (a.source.priority ?? DEFAULT_PRIORITY) - (b.source.priority ?? DEFAULT_PRIORITY),
  );

  // 4. Estimate tokens and truncate per-source if maxTokens set
  const estimated: SourceResult[] = [];
  for (const result of sorted) {
    let { content } = result;

    // Per-source truncation
    if (result.source.maxTokens !== undefined) {
      content = truncateToTokens(content, result.source.maxTokens);
    }

    const tokens = await estimator.estimateText(content);
    estimated.push({ ...result, content, tokens });
  }

  // 5. Accumulate until global budget reached; drop lowest-priority (last)
  const included: SourceResult[] = [];
  const droppedLabels: string[] = [];
  let totalTokens = 0;

  for (const result of estimated) {
    if (totalTokens + result.tokens > globalBudget) {
      warnings.push(
        `Source "${result.label}" dropped — would exceed token budget (${totalTokens + result.tokens}/${globalBudget})`,
      );
      droppedLabels.push(result.label);
      continue;
    }
    included.push(result);
    totalTokens += result.tokens;
  }

  // 6. Assemble content (includes drop notice if sources were excluded)
  const content = included.length > 0 ? assembleContent(included, droppedLabels) : "";

  return { content, totalTokens, sources: included, warnings };
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

/**
 * Creates a context hydrator middleware.
 *
 * Hydrates context once on session start, then prepends it as a system
 * message on every model call (both streaming and non-streaming).
 *
 * @param options - Config, agent reference, and optional token estimator
 * @returns KoiMiddleware with priority 300
 */
export function createContextHydrator(options: ContextHydratorOptions): KoiMiddleware {
  const { config, agent, estimator = heuristicTokenEstimator } = options;

  // Cached hydration result and pre-built system message — populated once in onSessionStart
  let cached: HydrationResult | undefined;
  let systemMessage: InboundMessage | undefined;

  return {
    name: "context-hydrator",
    priority: 300,

    async onSessionStart() {
      cached = await hydrate(config, agent, estimator);
      if (cached.content !== "") {
        systemMessage = buildSystemMessage(cached.content);
      }
    },

    async wrapModelCall(_ctx, request, next) {
      if (systemMessage === undefined) {
        return next(request);
      }

      return next({
        ...request,
        messages: [systemMessage, ...request.messages],
      });
    },

    async *wrapModelStream(_ctx, request, next) {
      if (systemMessage === undefined) {
        yield* next(request);
        return;
      }

      yield* next({
        ...request,
        messages: [systemMessage, ...request.messages],
      });
    },
  };
}
