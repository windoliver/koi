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
  ForgeBudget,
  ForgeDemandSignal,
  ForgeProvenance,
  ForgeScope,
  ForgeStore,
  KoiMiddleware,
  ToolArtifact,
  TrustTier,
  TurnContext,
} from "@koi/core";
import { brickId, DEFAULT_FORGE_BUDGET } from "@koi/core";
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

/**
 * Demand handle interface (L0-compatible, defined locally to avoid L2 import).
 * Matches ForgeDemandHandle from @koi/forge-demand.
 */
export interface AutoForgeDemandHandle {
  readonly getSignals: () => readonly ForgeDemandSignal[];
  readonly dismiss: (signalId: string) => void;
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
  /** Optional demand handle — enables demand-triggered forging. */
  readonly demandHandle?: AutoForgeDemandHandle | undefined;
  /** Demand budget — overrides when demandHandle is provided. */
  readonly demandBudget?: ForgeBudget | undefined;
  /** Called when a demand signal triggers a forge. */
  readonly onDemandForged?: ((signal: ForgeDemandSignal, brick: ToolArtifact) => void) | undefined;
  /**
   * Optional pre-save gate. When provided, called before each brick is saved.
   * Return true to allow, false to skip. Enables mutation pressure checks
   * without L2→L2 imports (L3 wiring injects the check).
   */
  readonly beforeSave?: (brick: ToolArtifact) => Promise<boolean>;
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

  // justified: mutable counters encapsulated within factory closure
  let lastForgedCount = 0;
  let demandForgedCount = 0;
  const demandBudget = config.demandBudget ?? DEFAULT_FORGE_BUDGET;

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

        // Pre-save gate (e.g., mutation pressure check injected by L3)
        if (config.beforeSave !== undefined) {
          const allowed = await config.beforeSave(brick);
          if (!allowed) continue;
        }

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

  /**
   * Process a demand signal — forge a pioneer brick.
   * Tags as demand-forged/pioneer, starts at sandbox trust.
   */
  async function processDemandForge(signal: ForgeDemandSignal): Promise<void> {
    const now = clock();
    const id = brickId(`demand:${signal.trigger.kind}:${String(now)}`);
    const triggerDesc =
      signal.trigger.kind === "repeated_failure"
        ? signal.trigger.toolName
        : signal.trigger.kind === "capability_gap"
          ? signal.trigger.requiredCapability
          : signal.trigger.kind === "no_matching_tool"
            ? signal.trigger.query
            : signal.trigger.kind === "performance_degradation"
              ? signal.trigger.toolName
              : signal.trigger.kind === "agent_capability_gap"
                ? signal.trigger.agentType
                : signal.trigger.kind === "agent_repeated_failure"
                  ? signal.trigger.agentType
                  : signal.trigger.agentType;

    const provenance: ForgeProvenance = {
      source: {
        origin: "forged",
        forgedBy: "auto-forge-middleware/demand",
        sessionId: `demand:${signal.id}`,
      },
      buildDefinition: {
        buildType: "koi.demand/pioneer/v1",
        externalParameters: {
          triggerKind: signal.trigger.kind,
          confidence: signal.confidence,
          failureCount: signal.context.failureCount,
        },
      },
      builder: { id: "koi.demand/auto-forge/v1" },
      metadata: {
        invocationId: `demand-forge:${String(now)}`,
        startedAt: now,
        finishedAt: now,
        sessionId: `demand:${signal.id}`,
        agentId: "auto-forge-middleware",
        depth: 0,
      },
      verification: {
        passed: true,
        finalTrustTier: "sandbox",
        totalDurationMs: 0,
        stageResults: [],
      },
      classification: "public",
      contentMarkers: [],
      contentHash: `demand:${signal.id}:${String(now)}`,
    };

    const brick: ToolArtifact = {
      id,
      kind: "tool",
      name: `pioneer-${triggerDesc}`,
      description: `Pioneer tool forged from demand signal: ${signal.trigger.kind}`,
      scope: config.scope,
      trustTier: "sandbox",
      lifecycle: "active",
      provenance,
      version: "0.1.0",
      tags: ["demand-forged", "pioneer"],
      usageCount: 0,
      implementation: `// Pioneer stub — demand-triggered for: ${signal.trigger.kind}`,
      inputSchema: {},
    };

    // Pre-save gate (e.g., mutation pressure check injected by L3)
    if (config.beforeSave !== undefined) {
      const allowed = await config.beforeSave(brick);
      if (!allowed) return;
    }

    const saveResult = await config.forgeStore.save(brick);
    if (!saveResult.ok) {
      onError(new Error(`Failed to save demand-forged brick: ${saveResult.error.message}`));
      return;
    }

    demandForgedCount++;
    config.onDemandForged?.(signal, brick);
  }

  return {
    name: "auto-forge",
    priority: 960, // After crystallize middleware (950)

    async onAfterTurn(_ctx: TurnContext): Promise<void> {
      // --- Existing: process crystallization candidates ---
      const candidates = config.crystallizeHandle.getCandidates();
      if (candidates.length > 0) {
        // Fire-and-forget: run forge pipeline asynchronously
        // justified: fire-and-forget pattern — errors handled via onError callback
        void Promise.resolve().then(async () => {
          try {
            await processForge(candidates);
          } catch (err: unknown) {
            onError(err);
          }
        });
      }

      // --- New: process demand signals ---
      if (config.demandHandle !== undefined) {
        const signals = config.demandHandle.getSignals();
        for (const signal of signals) {
          // Check hard cap
          if (demandForgedCount >= demandBudget.maxForgesPerSession) break;
          // Check confidence threshold
          if (signal.confidence < demandBudget.demandThreshold) continue;

          // Fire-and-forget: demand forge runs asynchronously
          // justified: fire-and-forget pattern — errors handled via onError callback
          void Promise.resolve().then(async () => {
            try {
              await processDemandForge(signal);
            } catch (err: unknown) {
              onError(err);
            }
          });

          // Dismiss the signal after triggering forge (success or failure)
          config.demandHandle?.dismiss(signal.id);
        }
      }
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      const totalForged = lastForgedCount + demandForgedCount;
      if (totalForged === 0) return undefined;
      const parts: string[] = [];
      if (lastForgedCount > 0) {
        parts.push(
          `${String(lastForgedCount)} tool${lastForgedCount === 1 ? "" : "s"} auto-forged from crystallized patterns`,
        );
      }
      if (demandForgedCount > 0) {
        parts.push(
          `${String(demandForgedCount)} pioneer tool${demandForgedCount === 1 ? "" : "s"} demand-forged`,
        );
      }
      return {
        label: "auto-forge",
        description: parts.join("; "),
      };
    },
  };
}
