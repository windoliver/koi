import type {
  KoiError,
  Result,
  SessionId,
  SkippedTranscriptEntry,
  TranscriptEntry,
} from "@koi/core";
import { cacheKey, createMemoryCache } from "./cache.js";
import { parseOutput } from "./parse.js";
import { buildPrompt, PROMPT_VERSION } from "./prompt.js";
import { groupTurns, turnsToEntryRange } from "./turns.js";
import {
  type AgentSummary,
  type AgentSummaryDeps,
  DEFAULT_FOCUS,
  DEFAULT_TOKEN_BUDGETS,
  type Focus,
  type Granularity,
  type ModelHint,
  type SessionSummary,
  type SummaryEvent,
  type SummaryOk,
  type SummaryRangeOptions,
  type SummarySessionOptions,
} from "./types.js";
import { validateCachedEnvelope } from "./validate.js";

interface Resolved {
  readonly granularity: Granularity;
  readonly focus: Required<Focus>;
  readonly maxTokens: number;
  readonly modelHint: ModelHint;
  readonly schemaVersion: 1;
}

function resolveCommon(opts: SummarySessionOptions | SummaryRangeOptions | undefined): Resolved {
  const granularity = opts?.granularity ?? "medium";
  return {
    granularity,
    focus: { ...DEFAULT_FOCUS, ...(opts?.focus ?? {}) },
    maxTokens: opts?.maxTokens ?? DEFAULT_TOKEN_BUDGETS[granularity],
    modelHint: opts?.modelHint ?? "cheap",
    schemaVersion: 1,
  };
}

interface PipelineArgs {
  readonly sessionId: SessionId;
  readonly fromTurn: number;
  readonly toTurn: number;
  readonly entries: readonly TranscriptEntry[];
  readonly hasCompactionPrefix: boolean;
  readonly compactionEntryCount: number;
  readonly degraded: boolean;
  readonly skipped: readonly SkippedTranscriptEntry[];
  readonly droppedTailTurns: number;
  readonly resolved: Resolved;
}

export function createAgentSummary(deps: AgentSummaryDeps): AgentSummary {
  const cache = deps.cache ?? createMemoryCache();
  const clock = deps.clock ?? Date.now;
  const emit = (e: SummaryEvent): void => {
    deps.onEvent?.(e);
  };

  const runPipeline = async (args: PipelineArgs): Promise<Result<SummaryOk, KoiError>> => {
    const {
      sessionId,
      fromTurn,
      toTurn,
      entries,
      hasCompactionPrefix,
      compactionEntryCount,
      degraded,
      skipped,
      droppedTailTurns,
      resolved,
    } = args;

    const hash = cacheKey({
      sessionId,
      fromTurn,
      toTurn,
      entries,
      granularity: resolved.granularity,
      focus: resolved.focus,
      maxTokens: resolved.maxTokens,
      modelHint: resolved.modelHint,
      schemaVersion: 1,
      promptVersion: PROMPT_VERSION,
      degraded,
      skipped,
      hasCompactionPrefix,
      compactionEntryCount,
      droppedTailTurns,
    });

    if (degraded) {
      emit({
        kind: "transcript.skipped",
        hash,
        skippedCount: skipped.length,
      });
    }

    const expectedKind: SummaryOk["kind"] = hasCompactionPrefix
      ? "compacted"
      : degraded
        ? "degraded"
        : "clean";

    let cached: SummaryOk | undefined;
    try {
      cached = await cache.get(hash);
    } catch (err) {
      emit({
        kind: "cache.read_fail",
        hash,
        error: asKoiError("cache_get_threw", err),
      });
      cached = undefined;
    }
    if (cached !== undefined) {
      const valid = validateCachedEnvelope(cached, {
        expectedHash: hash,
        expectedSessionId: sessionId,
        expectedFromTurn: fromTurn,
        expectedToTurn: toTurn,
        expectedKind,
        expectedHasCompactionPrefix: hasCompactionPrefix,
        expectedRangeOrigin: hasCompactionPrefix ? "post-compaction" : "raw",
        expectedSkipped: skipped,
        expectedDroppedTailTurns: droppedTailTurns,
        expectedCompactionEntryCount: compactionEntryCount,
      });
      if (valid.ok) {
        emit({ kind: "cache.hit", hash });
        return { ok: true, value: valid.value };
      }
      emit({ kind: "cache.corrupt", hash, reason: valid.error.reason });
    }
    emit({ kind: "cache.miss", hash });

    const { system, user } = buildPrompt(entries, {
      granularity: resolved.granularity,
      focus: resolved.focus,
      maxTokens: resolved.maxTokens,
      hasCompactionPrefix,
    });

    const callOnce = async (strict: boolean): Promise<string> => {
      const systemMsg = strict
        ? buildPrompt(entries, {
            granularity: resolved.granularity,
            focus: resolved.focus,
            maxTokens: resolved.maxTokens,
            hasCompactionPrefix,
            strictRetry: true,
          }).system
        : system;
      emit({ kind: "model.start", hash, maxTokens: resolved.maxTokens });
      const start = clock();
      const resp = await deps.modelCall({
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: user },
        ],
        maxTokens: resolved.maxTokens,
        responseFormat: "json",
        metadata: {
          summaryMode: resolved.granularity,
          modelHint: resolved.modelHint,
        },
      });
      emit({ kind: "model.end", hash, elapsedMs: clock() - start });
      return resp.text;
    };

    let text: string;
    try {
      text = await callOnce(false);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "modelCall rejected",
          retryable: true,
          context: { cause: String(err) },
        },
      };
    }

    let parsed = parseOutput(text);
    if (!parsed.ok) {
      emit({ kind: "parse.retry", hash });
      try {
        text = await callOnce(true);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: "modelCall rejected on retry",
            retryable: true,
            context: { cause: String(err) },
          },
        };
      }
      parsed = parseOutput(text);
      if (!parsed.ok) {
        emit({ kind: "parse.fail", hash });
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: parsed.error.reason,
            retryable: false,
          },
        };
      }
    }

    const body: SessionSummary = {
      sessionId,
      range: { fromTurn, toTurn, entryCount: entries.length },
      goal: parsed.value.goal,
      status: parsed.value.status,
      actions: parsed.value.actions.map((a) => ({
        kind: a.kind,
        name: a.name,
        ...(a.paths !== undefined && a.paths !== null ? { paths: a.paths } : {}),
        ...(a.detail !== undefined && a.detail !== null ? { detail: a.detail } : {}),
      })),
      outcomes: parsed.value.outcomes,
      errors: parsed.value.errors,
      learnings: parsed.value.learnings,
      meta: {
        granularity: resolved.granularity,
        modelHint: resolved.modelHint,
        hash,
        generatedAt: clock(),
        schemaVersion: 1,
        hasCompactionPrefix,
        rangeOrigin: hasCompactionPrefix ? "post-compaction" : "raw",
      },
    };

    const envelope: SummaryOk = hasCompactionPrefix
      ? {
          kind: "compacted",
          derived: body,
          compactionEntryCount,
          skipped,
          droppedTailTurns,
        }
      : degraded
        ? { kind: "degraded", partial: body, skipped, droppedTailTurns }
        : { kind: "clean", summary: body };

    try {
      await cache.set(hash, envelope);
    } catch (err) {
      emit({
        kind: "cache.write_fail",
        hash,
        error: asKoiError("cache_set_threw", err),
      });
    }
    return { ok: true, value: envelope };
  };

  const summarizeSession = async (
    sessionId: SessionId,
    options?: SummarySessionOptions,
  ): Promise<Result<SummaryOk, KoiError>> => {
    const loadResult = await deps.transcript.load(sessionId);
    if (!loadResult.ok) return loadResult;
    const { entries, skipped } = loadResult.value;

    // §1.5 empty-vs-corrupt guard
    if (entries.length === 0 && skipped.length === 0) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "empty session",
          retryable: false,
          context: { reason: "session-empty" },
        },
      };
    }
    if (entries.length === 0 && skipped.length > 0) {
      emit({
        kind: "transcript.skipped",
        hash: null,
        skippedCount: skipped.length,
      });
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "every line failed to parse",
          retryable: false,
          context: { skipped, reason: "session-all-skipped" },
        },
      };
    }

    // §2a compaction check
    const compactionEntryCount = entries.filter((e) => e.role === "compaction").length;
    const hasCompactionPrefix = compactionEntryCount > 0;
    if (hasCompactionPrefix && options?.allowCompacted !== true) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "compacted transcript",
          retryable: false,
          context: {
            reason: "session-compacted",
            compactionEntryCount,
          },
        },
      };
    }

    // §2b skip integrity check
    const degraded = skipped.length > 0;
    let droppedTailTurns = 0;
    let workingEntries: readonly TranscriptEntry[] = entries;
    const strategy = options?.crashTailStrategy ?? "reject";
    if (degraded) {
      if (skipped.some((s) => s.reason === "parse_error")) {
        emit({
          kind: "transcript.skipped",
          hash: null,
          skippedCount: skipped.length,
        });
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "mid-file parse_error",
            retryable: false,
            context: { skipped, reason: "session-parse-error" },
          },
        };
      }
      if (strategy === "reject") {
        emit({
          kind: "transcript.skipped",
          hash: null,
          skippedCount: skipped.length,
        });
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "crash_artifact tail",
            retryable: false,
            context: { skipped, reason: "session-strict" },
          },
        };
      }
      if (strategy === "drop_last_turn") {
        const turns = groupTurns(entries);
        if (turns.length <= 1) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "no safe prefix",
              retryable: false,
              context: { reason: "session-crash-only-turn" },
            },
          };
        }
        droppedTailTurns = 1;
        workingEntries = turnsToEntryRange(turns, 0, turns.length - 2);
      }
      // strategy === "include_all" → workingEntries unchanged; droppedTailTurns stays 0
    }

    const resolved = resolveCommon(options);
    const turns = groupTurns(workingEntries);
    const toTurn = turns.length - 1;
    return runPipeline({
      sessionId,
      fromTurn: 0,
      toTurn,
      entries: workingEntries,
      hasCompactionPrefix,
      compactionEntryCount,
      degraded,
      skipped: degraded ? skipped : [],
      droppedTailTurns,
      resolved,
    });
  };

  const summarizeRange = async (
    sessionId: SessionId,
    fromTurn: number,
    toTurn: number,
    options?: SummaryRangeOptions,
  ): Promise<Result<SummaryOk, KoiError>> => {
    if (fromTurn < 0 || toTurn < fromTurn) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "invalid range",
          retryable: false,
          context: { fromTurn, toTurn },
        },
      };
    }
    const loadResult = await deps.transcript.load(sessionId);
    if (!loadResult.ok) return loadResult;
    const { entries, skipped } = loadResult.value;

    // §6.3.1 compaction reject
    if (entries.some((e) => e.role === "compaction")) {
      emit({ kind: "transcript.skipped", hash: null, skippedCount: 0 });
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "range cannot summarize compacted transcripts",
          retryable: false,
          context: { reason: "range-compacted" },
        },
      };
    }

    // §6.3.2 / §6.3.3 skip integrity check
    let degraded = false;
    if (skipped.length > 0) {
      if (skipped.some((s) => s.reason === "parse_error")) {
        emit({
          kind: "transcript.skipped",
          hash: null,
          skippedCount: skipped.length,
        });
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "mid-file parse_error",
            retryable: false,
            context: { skipped, reason: "range-strict" },
          },
        };
      }
      const peek = groupTurns(entries);
      if (peek.length <= 1) {
        emit({
          kind: "transcript.skipped",
          hash: null,
          skippedCount: skipped.length,
        });
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "no safe prefix",
            retryable: false,
            context: { skipped, reason: "range-crash-no-prefix" },
          },
        };
      }
      const lastIdx = peek.length - 1;
      if (toTurn >= lastIdx) {
        emit({
          kind: "transcript.skipped",
          hash: null,
          skippedCount: skipped.length,
        });
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "toTurn touches crash-truncated tail",
            retryable: false,
            context: {
              skipped,
              reason: "range-tail-crash",
              lastSafeToTurn: lastIdx - 1,
            },
          },
        };
      }
      degraded = true;
    }

    const turns = groupTurns(entries);
    if (toTurn >= turns.length) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "toTurn out of range",
          retryable: false,
          context: { toTurn, available: turns.length },
        },
      };
    }
    const slice = turnsToEntryRange(turns, fromTurn, toTurn);
    if (slice.length === 0) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "empty range",
          retryable: false,
        },
      };
    }
    const resolved = resolveCommon(options);
    return runPipeline({
      sessionId,
      fromTurn,
      toTurn,
      entries: slice,
      hasCompactionPrefix: false,
      compactionEntryCount: 0,
      degraded,
      skipped: degraded ? skipped : [],
      droppedTailTurns: 0,
      resolved,
    });
  };

  return { summarizeSession, summarizeRange };
}

function asKoiError(prefix: string, cause: unknown): KoiError {
  return {
    code: "INTERNAL",
    message: `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`,
    retryable: false,
  };
}
