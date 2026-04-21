import type {
  BrickArtifact,
  BrickId,
  CollectiveMemory,
  CollectiveMemoryEntry,
  InboundMessage,
  KoiMiddleware,
  Result,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { brickId, COLLECTIVE_MEMORY_DEFAULTS, DEFAULT_COLLECTIVE_MEMORY } from "@koi/core";
import { createAllSecretPatterns, createRedactor } from "@koi/redaction";
import { CHARS_PER_TOKEN } from "@koi/token-estimator";
import { deduplicateEntries, selectEntriesWithinBudget } from "@koi/validation";
import { compactCollectiveMemory, shouldCompact } from "./compact.js";
import { createDefaultExtractor, isInstruction } from "./extract-learnings.js";
import { createExtractionPrompt, parseExtractionResponse } from "./extract-llm.js";
import { formatCollectiveMemory } from "./inject.js";
import type { CollectiveMemoryMiddlewareConfig } from "./types.js";

// Default spawn tool IDs matching the engine-compose runtime.
// Callers can override via config.spawnToolIds.
const DEFAULT_SPAWN_TOOL_IDS: readonly string[] = ["forge_agent", "Spawn", "agent_spawn"];
const MAX_SESSION_OUTPUTS = 20;
// Truncate worker output before persisting to bound memory usage.
const MAX_OUTPUT_BYTES = 8_192;

function outputToString(output: unknown): string {
  if (typeof output === "string") return output;
  if (output !== null && output !== undefined) {
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return "";
}

// Lazily initialized centralized redactor — compiled once, reused across calls.
// let justified: lazy singleton to avoid compiling patterns on module load
let _redactor: ReturnType<typeof createRedactor> | undefined;

function getRedactor(): ReturnType<typeof createRedactor> {
  if (_redactor === undefined) {
    _redactor = createRedactor({ patterns: createAllSecretPatterns() });
  }
  return _redactor;
}

function sanitizeOutput(text: string): string {
  const truncated = text.length > MAX_OUTPUT_BYTES ? text.slice(0, MAX_OUTPUT_BYTES) : text;
  const { text: redacted } = getRedactor().redactString(truncated);
  // Escape untrusted-data boundary tokens to prevent injection breakout.
  return redacted
    .replaceAll("</untrusted-data>", "&lt;/untrusted-data&gt;")
    .replaceAll("<untrusted-data>", "&lt;untrusted-data&gt;");
}

function generateEntryId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `cm_${ts}_${rand}`;
}

export function createCollectiveMemoryMiddleware(
  config: CollectiveMemoryMiddlewareConfig,
): KoiMiddleware {
  const extractor = config.extractor ?? createDefaultExtractor();
  const maxEntries = config.maxEntries ?? COLLECTIVE_MEMORY_DEFAULTS.maxEntries;
  const maxTokens = config.maxTokens ?? COLLECTIVE_MEMORY_DEFAULTS.maxTokens;
  const coldAgeDays = config.coldAgeDays ?? COLLECTIVE_MEMORY_DEFAULTS.coldAgeDays;
  const injectionBudget = config.injectionBudget ?? COLLECTIVE_MEMORY_DEFAULTS.injectionBudget;
  const dedupThreshold = config.dedupThreshold ?? COLLECTIVE_MEMORY_DEFAULTS.dedupThreshold;
  const autoCompact = config.autoCompact ?? true;
  const spawnToolIds = new Set<string>(config.spawnToolIds ?? DEFAULT_SPAWN_TOOL_IDS);
  // Default false: spawn-child outputs are NOT persisted to the parent's brick
  // to avoid cross-agent memory contamination. Per-child persistence requires
  // the middleware to run inside each child's session.
  const persistSpawnOutputs = config.persistSpawnOutputs ?? false;
  const validateLearning = config.validateLearning;

  function acceptLearning(content: string): boolean {
    if (isInstruction(content)) return false;
    if (validateLearning !== undefined && !validateLearning(content)) return false;
    return true;
  }

  // outputs is a mutable array ref so concurrent push() calls in the same session
  // don't race: JS is single-threaded, so push on a shared ref is atomic.
  // inFlightInjection serializes concurrent first-turn injections without
  // permanently disabling injection on transient load failures: callers await
  // the same promise; if it resolves with a successful injection, `injected`
  // becomes true; if it failed, the promise field is cleared so the next turn
  // can retry.
  type SessionState = {
    injected: boolean;
    outputs: string[];
    inFlightInjection?: Promise<void>;
  };
  // Per-session state keyed by sessionId — prevents concurrent sessions from
  // clobbering each other's injection flag or buffered outputs.
  const sessions = new Map<string, SessionState>();

  function getSession(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh: SessionState = { injected: false, outputs: [] };
    sessions.set(sessionId, fresh);
    return fresh;
  }

  /**
   * Build the tenant-scoped resolve context from a session, dropping undefined fields.
   *
   * SessionContext exposes userId/channelId/conversationId as top-level optional
   * fields in @koi/core L0, but some runtime adapters carry tenant identity
   * inside session.metadata instead. Read both locations so the partition keys
   * are populated regardless of which surface the runtime uses.
   */
  function resolveCtxFor(session: {
    readonly agentId: string;
    readonly userId?: string;
    readonly channelId?: string;
    readonly conversationId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): { readonly agentName: string } & Partial<{
    readonly userId: string;
    readonly channelId: string;
    readonly conversationId: string;
  }> {
    const meta = session.metadata;
    const fromMeta = (key: string): string | undefined => {
      if (meta === undefined) return undefined;
      const v = meta[key];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    const userId = session.userId ?? fromMeta("userId");
    const channelId = session.channelId ?? fromMeta("channelId");
    const conversationId = session.conversationId ?? fromMeta("conversationId");
    return {
      agentName: session.agentId,
      ...(userId !== undefined ? { userId } : {}),
      ...(channelId !== undefined ? { channelId } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
    };
  }

  return {
    name: "koi:collective-memory",
    priority: 305,

    describeCapabilities(_ctx: TurnContext): {
      readonly label: string;
      readonly description: string;
    } {
      return {
        label: "collective-memory",
        description: "Injects cross-run learnings from collective memory into agent context",
      };
    },

    async onSessionStart(ctx): Promise<void> {
      sessions.set(ctx.sessionId, { injected: false, outputs: [] as string[] });
    },

    async onSessionEnd(ctx): Promise<void> {
      const state = sessions.get(ctx.sessionId);

      // Fast path: nothing to extract. Safe to drop session state immediately.
      if (
        !persistSpawnOutputs ||
        config.modelCall === undefined ||
        state === undefined ||
        state.outputs.length === 0
      ) {
        sessions.delete(ctx.sessionId);
        return;
      }

      const outputs = state.outputs;

      // Keep the session state alive until extraction and persistence complete.
      // If any step fails, do NOT delete — the buffered outputs remain available
      // to a subsequent retry (e.g. a follow-up onSessionEnd dispatch from the
      // runtime, or operator-driven recovery). The session state is a small
      // bounded buffer (MAX_SESSION_OUTPUTS); leaking it on a hard failure is
      // preferable to silently losing learnings.
      try {
        const prompt = createExtractionPrompt(outputs);
        const response = await config.modelCall({
          messages: [
            {
              content: [{ kind: "text", text: prompt }],
              senderId: "system:collective-memory",
              timestamp: Date.now(),
            },
          ],
          ...(config.extractionModel !== undefined ? { model: config.extractionModel } : {}),
          maxTokens: config.extractionMaxTokens ?? 1024,
        });

        const candidates = parseExtractionResponse(response.content).filter((c) =>
          acceptLearning(c.content),
        );

        if (candidates.length > 0) {
          const rawId = config.resolveBrickId(resolveCtxFor(ctx));
          if (rawId !== undefined) {
            await persistLearnings(brickId(rawId), candidates, ctx.agentId, ctx.runId);
          }
        }

        // Successful extraction (including a legitimate empty-candidates result):
        // safe to clear the session buffer.
        sessions.delete(ctx.sessionId);
      } catch (_e: unknown) {
        // Extraction or persistence failed. Leave the session state in place
        // so a later retry can re-attempt. The runtime may invoke onSessionEnd
        // again, or operators can inspect the buffered outputs for diagnostics.
        // Do NOT swallow silently without preserving the buffer.
      }
    },

    async wrapToolCall(ctx, request: ToolRequest, next): Promise<ToolResponse> {
      const response: ToolResponse = await next(request);

      if (!spawnToolIds.has(request.toolId)) return response;
      // Spawn-child outputs are not persisted to the parent's brick by default —
      // attribution would contaminate the orchestrator's collective memory with
      // learnings from arbitrary child agent types. Per-child persistence happens
      // when the middleware runs inside the child's own session.
      if (!persistSpawnOutputs) return response;

      const outputStr = sanitizeOutput(outputToString(response.output));
      if (outputStr.length === 0) return response;

      const state = getSession(ctx.session.sessionId);
      if (config.modelCall !== undefined && state.outputs.length < MAX_SESSION_OUTPUTS) {
        // Mutate the shared array ref — safe in single-threaded JS;
        // avoids the read-spread-write race with concurrent spawn completions.
        state.outputs.push(outputStr);
      }

      const candidates = extractor.extract(outputStr).filter((c) => acceptLearning(c.content));
      if (candidates.length === 0) return response;

      const rawId = config.resolveBrickId(resolveCtxFor(ctx.session));
      if (rawId === undefined) return response;

      try {
        await persistLearnings(brickId(rawId), candidates, ctx.session.agentId, ctx.session.runId);
      } catch {
        // Fire-and-forget: don't break tool call chain on persistence failure
      }

      return response;
    },

    async wrapModelCall(ctx, request, next) {
      const state = getSession(ctx.session.sessionId);
      if (state.injected) return next(request);

      // Serialize concurrent first-turn injections via a shared in-flight promise.
      // If the in-flight load fails, the promise is cleared so the next turn retries.
      if (state.inFlightInjection !== undefined) {
        // Wait for the concurrent in-flight injection to complete; then proceed
        // with a plain (un-injected) call — the concurrent caller already injected.
        await state.inFlightInjection.catch(() => undefined);
        return next(request);
      }

      const rawId = config.resolveBrickId(resolveCtxFor(ctx.session));
      if (rawId === undefined) {
        // No brick to inject from; mark injected so we don't repeat the lookup.
        sessions.set(ctx.session.sessionId, { ...state, injected: true });
        return next(request);
      }

      // Build the memory block before dispatching. Any failure here (load/format)
      // clears the in-flight gate so a later turn can retry.
      const brick: BrickId = brickId(rawId);
      let injectedRequest: typeof request | undefined;
      let injectedIds: ReadonlySet<string> | undefined;

      // let justified: assigned via inFlightInjection promise resolution
      let resolveInFlight: (() => void) | undefined;
      // let justified: assigned via inFlightInjection promise rejection
      let rejectInFlight: ((err: unknown) => void) | undefined;
      const inFlight = new Promise<void>((resolve, reject) => {
        resolveInFlight = resolve;
        rejectInFlight = reject;
      });
      // Attach a no-op catch immediately so a rejection without concurrent
      // awaiters does not surface as an unhandled promise rejection.
      inFlight.catch(() => undefined);
      sessions.set(ctx.session.sessionId, { ...state, inFlightInjection: inFlight });

      // Helper: clear the in-flight gate without committing the one-shot flag,
      // so a later turn can retry injection after a transient failure.
      const clearGate = (err?: unknown): void => {
        const current = getSession(ctx.session.sessionId);
        sessions.set(ctx.session.sessionId, { ...current, inFlightInjection: undefined });
        if (err !== undefined) rejectInFlight?.(err);
        else resolveInFlight?.();
      };

      // Helper: commit injected=true and clear the in-flight gate.
      const commitInjected = (): void => {
        const current = getSession(ctx.session.sessionId);
        sessions.set(ctx.session.sessionId, {
          ...current,
          injected: true,
          inFlightInjection: undefined,
        });
        resolveInFlight?.();
      };

      // let justified: assigned in the load/format block
      let loadOk = false;
      try {
        const loadResult: Result<BrickArtifact, unknown> = await config.forgeStore.load(brick);
        if (!loadResult.ok) {
          // Result-shaped load failure is retryable, just like a thrown load error.
          clearGate();
          return next(request);
        }
        loadOk = true;
        const memory: CollectiveMemory =
          loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
        const selected = selectEntriesWithinBudget(
          memory.entries,
          injectionBudget,
          CHARS_PER_TOKEN,
        );
        if (selected.length > 0) {
          const formatted = formatCollectiveMemory(
            memory.entries,
            injectionBudget,
            CHARS_PER_TOKEN,
          );
          if (formatted.length > 0) {
            injectedIds = new Set(selected.map((e) => e.id));
            const systemMessage: InboundMessage = {
              content: [{ kind: "text", text: formatted }],
              senderId: "system:collective-memory",
              timestamp: Date.now(),
            };
            injectedRequest = { ...request, messages: [systemMessage, ...request.messages] };
          }
        }
      } catch (err) {
        // Pre-dispatch thrown failure: retry on next turn.
        clearGate(err);
        return next(request);
      }

      if (injectedRequest === undefined) {
        // Load succeeded but there is nothing to inject. Commit the one-shot
        // flag — we don't want to repeat the lookup every turn for an empty brick.
        if (loadOk) commitInjected();
        else clearGate();
        return next(request);
      }

      // Dispatch the injected request. If next() rejects (provider timeout,
      // cancellation, etc.) clear the gate WITHOUT committing the flag so the
      // next turn can retry injection. Propagate the error to the caller.
      // let justified: assigned in try/catch below; needed in outer scope
      let result: Awaited<ReturnType<typeof next>>;
      try {
        result = await next(injectedRequest);
      } catch (err) {
        clearGate(err);
        throw err;
      }

      // Successful injection AND successful dispatch — commit the one-shot flag.
      commitInjected();
      if (injectedIds !== undefined) {
        incrementAccessCounts(brick, injectedIds).catch(() => {
          // Swallow — observability only
        });
      }
      return result;
    },
  };

  async function persistLearnings(
    brick: BrickId,
    candidates: readonly { readonly content: string; readonly category: string }[],
    agentId: string,
    runId: string,
  ): Promise<void> {
    const nowMs = Date.now();

    const newEntries: readonly CollectiveMemoryEntry[] = candidates.map((c) => ({
      id: generateEntryId(),
      content: c.content,
      category: c.category as CollectiveMemoryEntry["category"],
      source: { agentId, runId, timestamp: nowMs },
      createdAt: nowMs,
      accessCount: 0,
      lastAccessedAt: nowMs,
    }));

    // Retry loop: re-read on CAS conflict so concurrent writers converge without data loss.
    // Uses exponential backoff with jitter to reduce thundering-herd under fan-out spawns.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // let justified: mutable delay for backoff jitter
        const delayMs = Math.min(50 * 2 ** (attempt - 1), 400) + Math.random() * 20;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }

      const loadResult = await config.forgeStore.load(brick);
      if (!loadResult.ok) return;

      const existing: CollectiveMemory =
        loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
      const storeVersion = loadResult.value.storeVersion;

      const merged = [...existing.entries, ...newEntries];
      const deduped = deduplicateEntries(merged, dedupThreshold, nowMs);
      const totalTokens = deduped.reduce(
        (sum, e) => sum + Math.ceil(e.content.length / CHARS_PER_TOKEN),
        0,
      );

      // let justified: mutable for conditional compaction
      let updated: CollectiveMemory = {
        entries: deduped,
        totalTokens,
        generation: existing.generation,
        lastCompactedAt: existing.lastCompactedAt,
      };

      if (autoCompact && shouldCompact(updated, maxEntries, maxTokens)) {
        updated = compactCollectiveMemory(updated, {
          maxEntries,
          maxTokens,
          coldAgeDays,
          dedupThreshold,
        });
      }

      const updateResult = await config.forgeStore.update(brick, {
        collectiveMemory: updated,
        ...(storeVersion !== undefined ? { expectedVersion: storeVersion } : {}),
      });

      if (updateResult.ok) return;
      // On conflict (CONFLICT error) retry with a fresh load; on other errors bail.
      const errCode = (updateResult.error as { code?: string } | undefined)?.code;
      if (errCode !== "CONFLICT") return;
    }
  }

  async function incrementAccessCounts(
    brick: BrickId,
    injectedIds: ReadonlySet<string>,
  ): Promise<void> {
    // Reload to avoid overwriting entries written by concurrent wrapToolCall calls.
    for (let attempt = 0; attempt < 3; attempt++) {
      const loadResult = await config.forgeStore.load(brick);
      if (!loadResult.ok) return;

      const memory: CollectiveMemory =
        loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
      const storeVersion = loadResult.value.storeVersion;
      const nowMs = Date.now();

      const updatedEntries = memory.entries.map((e) =>
        injectedIds.has(e.id) ? { ...e, accessCount: e.accessCount + 1, lastAccessedAt: nowMs } : e,
      );

      const updateResult = await config.forgeStore.update(brick, {
        collectiveMemory: { ...memory, entries: updatedEntries },
        ...(storeVersion !== undefined ? { expectedVersion: storeVersion } : {}),
      });

      if (updateResult.ok) return;
      const errCode = (updateResult.error as { code?: string } | undefined)?.code;
      if (errCode !== "CONFLICT") return;
    }
  }
}
