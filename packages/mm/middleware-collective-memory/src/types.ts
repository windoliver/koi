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

/** Configuration for the collective memory middleware factory. */
export interface CollectiveMemoryMiddlewareConfig {
  readonly forgeStore: ForgeStore;
  readonly resolveBrickId: (agentName: string) => string | undefined;
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
}
