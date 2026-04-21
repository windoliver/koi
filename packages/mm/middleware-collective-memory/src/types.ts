import type {
  CollectiveMemoryCategory,
  ForgeStore,
  ModelRequest,
  ModelResponse,
  TokenEstimator,
} from "@koi/core";

/** A candidate learning extracted from worker output. */
export interface LearningCandidate {
  readonly content: string;
  readonly category: CollectiveMemoryCategory;
  readonly confidence: number; // [0, 1]
}

/** Pluggable extractor interface for learning extraction strategies. */
export interface LearningExtractor {
  readonly extract: (output: string) => readonly LearningCandidate[];
}

/**
 * Context exposed to brick-id resolution. The middleware passes the agent name
 * plus optional tenant-scoping fields drawn from the session metadata so callers
 * can partition collective memory per user/channel/conversation when needed.
 */
export interface ResolveBrickContext {
  readonly agentName: string;
  /** Tenant/user identifier from session metadata, if present. */
  readonly userId?: string | undefined;
  /** Channel identifier from session metadata, if present. */
  readonly channelId?: string | undefined;
  /** Conversation identifier from session metadata, if present. */
  readonly conversationId?: string | undefined;
}

/** Configuration for the collective memory middleware factory. */
export interface CollectiveMemoryMiddlewareConfig {
  readonly forgeStore: ForgeStore;
  /**
   * Resolve the brick to read/write for a given agent.
   *
   * Called with either the agent name only (legacy signature) or a context
   * carrying tenant/user/channel/conversation fields drawn from session
   * metadata. To partition memory per tenant or user, derive the brick id from
   * the context fields rather than the agent name alone — otherwise all users
   * of the same agent share one collective-memory brick.
   */
  readonly resolveBrickId: (agentNameOrCtx: string | ResolveBrickContext) => string | undefined;
  readonly tokenEstimator?: TokenEstimator | undefined;
  readonly extractor?: LearningExtractor | undefined;
  readonly maxEntries?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly coldAgeDays?: number | undefined;
  readonly injectionBudget?: number | undefined;
  readonly dedupThreshold?: number | undefined;
  readonly autoCompact?: boolean | undefined;
  /** Spawn tool IDs to intercept for learning extraction. Defaults to ["forge_agent", "Spawn"]. */
  readonly spawnToolIds?: readonly string[] | undefined;
  /** Model call for LLM-based post-session extraction. If absent, only regex extraction runs. */
  readonly modelCall?: ((request: ModelRequest) => Promise<ModelResponse>) | undefined;
  /** Model to use for extraction requests. */
  readonly extractionModel?: string | undefined;
  /** Max tokens for extraction response. Default: 1024. */
  readonly extractionMaxTokens?: number | undefined;
  /**
   * Opt-in compatibility for legacy string-only resolveBrickId implementations.
   *
   * Default: false (fail-closed). When the context-form call throws, the brick
   * is treated as unresolved and persistence/injection is skipped — preventing
   * a tenant-aware resolver that throws on malformed metadata from silently
   * leaking across tenants via the agent-only brick.
   *
   * Set to true ONLY when wiring a known legacy `(agentName: string) => brickId`
   * resolver that cannot be updated. With this flag enabled, an exception from
   * the context-form call triggers a retry with just the agent name string.
   */
  readonly enableLegacyResolverCompat?: boolean | undefined;
  /**
   * Total input byte budget for the session-end LLM extraction prompt.
   * Default: 32_768 (~8K tokens at 4 chars/token, comfortably under common
   * model context windows). The middleware drops OLDEST buffered outputs
   * first to fit, so the most recent learnings always make it into the prompt
   * even on busy sessions.
   */
  readonly extractionInputBudget?: number | undefined;
  /**
   * Persist learnings extracted from spawned-child tool outputs to the parent
   * agent's brick. Default: false. When false, spawn outputs are still observable
   * but are not written to any brick — child-attributed persistence requires the
   * middleware to run inside the child's session, where its own onSessionEnd
   * captures learnings against the child's brick.
   *
   * Enable only when you accept that learnings from all child types accumulate
   * on the orchestrator's collective memory rather than per-worker bricks.
   */
  readonly persistSpawnOutputs?: boolean | undefined;
  /**
   * Optional caller-supplied validator for extracted learnings. Returns true if
   * the learning is acceptable to persist. Runs AFTER the built-in
   * isInstruction() denylist. Use this to enforce stricter policy (e.g. require
   * declarative observation forms, reject paths/credentials/tool-invocation text).
   */
  readonly validateLearning?: ((content: string) => boolean) | undefined;
  /**
   * Optional structured observability hook. Invoked when an internal operation
   * fails irrecoverably (e.g. session-end extraction abandoned after retries,
   * persistence dropped after CAS exhaustion). Defaults to a no-op. Callers
   * should plug in metrics/log emission here.
   */
  readonly onError?:
    | ((event: {
        readonly kind: "extraction-abandoned" | "persistence-dropped";
        readonly sessionId?: string;
        readonly attempts?: number;
        readonly cause?: unknown;
      }) => void)
    | undefined;
}
