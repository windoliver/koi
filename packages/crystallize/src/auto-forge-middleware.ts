/**
 * Auto-forge middleware — closes the crystallize→forge pipeline gap.
 *
 * Wraps CrystallizeForgeHandler and automatically forges high-confidence
 * crystallized patterns into BrickArtifacts, saving them to the ForgeStore.
 * StoreChangeEvent (from watch()) triggers hot-attach in L1.
 *
 * The middleware depends on L0 types only (ForgeStore, KoiMiddleware from @koi/core).
 * The caller injects L2 instances via config — no L2→L2 import.
 */

import type {
  CapabilityFragment,
  ForgeProvenance,
  ForgeScope,
  ForgeStore,
  KoiMiddleware,
  ToolArtifact,
  TrustTier,
  TurnContext,
} from "@koi/core";
import { brickId } from "@koi/core";
import type { CrystallizedToolDescriptor } from "./forge-handler.js";
import { createCrystallizeForgeHandler } from "./forge-handler.js";
import type { CrystallizationCandidate, CrystallizeHandle } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Verifier result shape (defined locally to avoid L2 import). */
export interface AutoForgeVerifierResult {
  readonly passed: boolean;
  readonly message?: string;
}

/** Verifier interface (defined locally to avoid L2 import). */
export interface AutoForgeVerifier {
  readonly name: string;
  readonly verify: (descriptor: CrystallizedToolDescriptor) => Promise<AutoForgeVerifierResult>;
}

/** Configuration for the auto-forge middleware. */
export interface AutoForgeConfig {
  /** Crystallize handle to listen for candidates. */
  readonly crystallizeHandle: CrystallizeHandle;
  /** Forge store to save bricks into. */
  readonly forgeStore: ForgeStore;
  /** Optional verification pipeline — skip if not provided. */
  readonly verifyPipeline?: readonly AutoForgeVerifier[];
  /** Visibility scope for forged tools. */
  readonly scope: ForgeScope;
  /** Trust tier for forged tools. Default: "sandbox". */
  readonly trustTier?: TrustTier;
  /** Max tools forged per session. Default: 3. */
  readonly maxForgedPerSession?: number;
  /** Minimum confidence to auto-forge. Default: 0.9. */
  readonly confidenceThreshold?: number;
  /** Called when a candidate is suggested but below threshold. */
  readonly onSuggested?: (candidate: CrystallizationCandidate) => void;
  /** Called when a descriptor is forged and saved. */
  readonly onForged?: (descriptor: CrystallizedToolDescriptor) => void;
  /** Called on forge/save errors. Default: no-op. */
  readonly onError?: (error: unknown) => void;
  /** Clock function for timestamps. Default: Date.now. */
  readonly clock?: () => number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FORGED = 3;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a CrystallizedToolDescriptor to a ToolArtifact for storage. */
function mapDescriptorToBrick(descriptor: CrystallizedToolDescriptor, now: number): ToolArtifact {
  const id = brickId(`crystallize:${descriptor.provenance.ngramKey}:${String(now)}`);
  const provenance: ForgeProvenance = {
    source: {
      origin: "forged",
      forgedBy: "auto-forge-middleware",
      sessionId: `crystallize:${descriptor.provenance.ngramKey}`,
    },
    buildDefinition: {
      buildType: "koi.crystallize/composite/v1",
      externalParameters: {
        ngramKey: descriptor.provenance.ngramKey,
        occurrences: descriptor.provenance.occurrences,
        score: descriptor.provenance.score,
      },
    },
    builder: { id: "koi.crystallize/auto-forge/v1" },
    metadata: {
      invocationId: `auto-forge:${String(now)}`,
      startedAt: now,
      finishedAt: now,
      sessionId: `crystallize:${descriptor.provenance.ngramKey}`,
      agentId: "auto-forge-middleware",
      depth: 0,
    },
    verification: {
      passed: true,
      finalTrustTier: descriptor.trustTier,
      totalDurationMs: 0,
      stageResults: [],
    },
    classification: "public",
    contentMarkers: [],
    contentHash: `crystallize:${descriptor.provenance.ngramKey}:${String(now)}`,
  };

  return {
    id,
    kind: "tool",
    name: descriptor.name,
    description: descriptor.description,
    scope: descriptor.scope,
    trustTier: descriptor.trustTier,
    lifecycle: "active",
    provenance,
    version: "0.1.0",
    tags: ["crystallized", "auto-forged"],
    usageCount: 0,
    implementation: descriptor.implementation,
    inputSchema: descriptor.inputSchema,
  };
}

/** Verification check result. */
interface VerificationCheckResult {
  readonly passed: boolean;
  readonly failedVerifier?: string | undefined;
  readonly message?: string | undefined;
}

/** Run verification pipeline on a descriptor. Returns true if all pass (or no verifiers). */
async function runVerifiers(
  descriptor: CrystallizedToolDescriptor,
  verifiers: readonly AutoForgeVerifier[],
): Promise<VerificationCheckResult> {
  for (const verifier of verifiers) {
    const result = await verifier.verify(descriptor);
    if (!result.passed) {
      return { passed: false, failedVerifier: verifier.name, message: result.message };
    }
  }
  return { passed: true };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an auto-forge middleware that automatically forges crystallized
 * patterns into bricks and saves them to the store.
 *
 * Fire-and-forget: forge operations run asynchronously after candidates
 * are detected, not on the hot path.
 */
export function createAutoForgeMiddleware(config: AutoForgeConfig): KoiMiddleware {
  const clock = config.clock ?? Date.now;
  const verifiers = config.verifyPipeline ?? [];
  const onError = config.onError ?? (() => {});

  const forgeHandlerConfig = {
    scope: config.scope,
    maxForgedPerSession: config.maxForgedPerSession ?? DEFAULT_MAX_FORGED,
    confidenceThreshold: config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    ...(config.trustTier !== undefined ? { trustTier: config.trustTier } : {}),
    ...(config.onForged !== undefined ? { onForged: config.onForged } : {}),
    ...(config.onSuggested !== undefined ? { onSuggested: config.onSuggested } : {}),
  } as const;

  const forgeHandler = createCrystallizeForgeHandler(forgeHandlerConfig);

  // justified: mutable counter encapsulated within factory closure
  let lastForgedCount = 0;

  /**
   * Process candidates asynchronously — fire-and-forget from the middleware hook.
   * Errors are caught and reported via onError, never thrown.
   */
  async function processForge(candidates: readonly CrystallizationCandidate[]): Promise<void> {
    const now = clock();
    const descriptors = forgeHandler.handleCandidates(candidates, now);

    for (const descriptor of descriptors) {
      try {
        // Run verification pipeline
        const verification = await runVerifiers(descriptor, verifiers);
        if (!verification.passed) {
          onError(
            new Error(
              `Verification failed for ${descriptor.name}: ${verification.failedVerifier ?? "unknown"} — ${verification.message ?? "no details"}`,
            ),
          );
          continue;
        }

        // Save to store — StoreChangeEvent triggers hot-attach in L1
        const brick = mapDescriptorToBrick(descriptor, now);
        const saveResult = await config.forgeStore.save(brick);
        if (!saveResult.ok) {
          onError(
            new Error(`Failed to save brick ${descriptor.name}: ${saveResult.error.message}`),
          );
        }
      } catch (err: unknown) {
        onError(err);
      }
    }

    lastForgedCount = forgeHandler.getForgedCount();
  }

  return {
    name: "auto-forge",
    priority: 960, // After crystallize middleware (950)

    async onAfterTurn(_ctx: TurnContext): Promise<void> {
      // Read current candidates from the crystallize handle
      const candidates = config.crystallizeHandle.getCandidates();
      if (candidates.length === 0) return;

      // Fire-and-forget: run forge pipeline asynchronously
      // justified: fire-and-forget pattern — errors handled via onError callback
      void Promise.resolve().then(async () => {
        try {
          await processForge(candidates);
        } catch (err: unknown) {
          onError(err);
        }
      });
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (lastForgedCount === 0) return undefined;
      return {
        label: "auto-forge",
        description: `${String(lastForgedCount)} tool${lastForgedCount === 1 ? "" : "s"} auto-forged from crystallized patterns`,
      };
    },
  };
}
