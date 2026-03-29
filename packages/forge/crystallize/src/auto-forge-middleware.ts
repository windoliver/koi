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
  AgentArtifact,
  BrickArtifact,
  BrickId,
  CapabilityFragment,
  ForgeBudget,
  ForgeDemandSignal,
  ForgeProvenance,
  ForgeScope,
  ForgeStore,
  ForgeTrigger,
  KoiMiddleware,
  SessionContext,
  SkillArtifact,
  StoreChangeNotifier,
  ToolArtifact,
  ToolPolicy,
  TurnContext,
} from "@koi/core";
import { DEFAULT_FORGE_BUDGET, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { computeBrickId } from "@koi/hash";
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
  readonly policy?: ToolPolicy;
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
  readonly onDemandForged?: ((signal: ForgeDemandSignal, brick: BrickArtifact) => void) | undefined;
  /**
   * Optional harness synthesis callback. When provided and a demand signal
   * has trigger.kind === "repeated_failure", this callback is invoked instead
   * of creating a pioneer stub. The callback runs in the background (fire-and-forget).
   * Injected by L3 wiring from @koi/harness-synth + @koi/harness-search.
   */
  readonly synthesizeHarness?:
    | ((signal: ForgeDemandSignal) => Promise<BrickArtifact | null>)
    | undefined;
  /** Maximum harness synthesis attempts per session. Default: 3. */
  readonly maxSynthesesPerSession?: number | undefined;
  /**
   * Optional pre-save gate. When provided, called before each brick is saved.
   * Return true to allow, false to skip. Enables mutation pressure checks
   * without L2→L2 imports (L3 wiring injects the check).
   */
  readonly beforeSave?: (brick: BrickArtifact) => Promise<boolean>;
  /** Optional notifier for cross-agent cache invalidation after store mutations. */
  readonly notifier?: StoreChangeNotifier | undefined;
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
  const id = computeBrickId("tool", descriptor.implementation);
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
      sandbox: descriptor.policy.sandbox,
      totalDurationMs: 0,
      stageResults: [],
    },
    classification: "public",
    contentMarkers: [],
    contentHash: id,
  };

  return {
    id,
    kind: "tool",
    name: descriptor.name,
    description: descriptor.description,
    scope: descriptor.scope,
    origin: "forged",
    policy: descriptor.policy,
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
// Trigger description — short human-readable label for naming pioneer bricks
// ---------------------------------------------------------------------------

/** Extracts a short descriptor from a trigger for naming pioneer bricks. */
/**
 * Extract a capability search text from a demand trigger.
 * Returns undefined for trigger kinds where trigger-based matching is not meaningful
 * (e.g., repeated_failure uses a tool name, not a capability description).
 */
function extractTriggerSearchText(trigger: ForgeTrigger): string | undefined {
  switch (trigger.kind) {
    case "no_matching_tool":
      return trigger.query;
    case "capability_gap":
      return trigger.requiredCapability;
    case "data_source_gap":
      return trigger.missingCapability;
    case "user_correction":
      return trigger.correctionDescription;
    case "complex_task_completed":
      return trigger.taskDescription;
    case "novel_workflow":
      return trigger.workflowDescription;
    default:
      return undefined;
  }
}

function describeTrigger(trigger: ForgeTrigger): string {
  switch (trigger.kind) {
    case "repeated_failure":
    case "performance_degradation":
      return trigger.toolName;
    case "capability_gap":
      return trigger.requiredCapability;
    case "no_matching_tool":
      return trigger.query;
    case "agent_capability_gap":
    case "agent_repeated_failure":
      return trigger.agentType;
    case "agent_latency_degradation":
      return trigger.agentType;
    case "complex_task_completed":
      return `complex-${String(trigger.toolCallCount)}`;
    case "user_correction":
      return trigger.correctedToolCall;
    case "novel_workflow":
      return trigger.toolSequence.slice(0, 3).join("-");
    case "data_source_detected":
      return `ds-${trigger.sourceName}`;
    case "data_source_gap":
      return `ds-gap-${trigger.sourceName}`;
  }
  // Exhaustiveness guard
  const _exhaustive: never = trigger;
  return String((_exhaustive as ForgeTrigger).kind);
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
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.onForged !== undefined ? { onForged: config.onForged } : {}),
    ...(config.onSuggested !== undefined ? { onSuggested: config.onSuggested } : {}),
  } as const;

  const forgeHandler = createCrystallizeForgeHandler(forgeHandlerConfig);

  // justified: mutable counters reset per session via onSessionStart
  let lastForgedCount = 0;
  let demandForgedCount = 0;
  let synthesesCount = 0; // let: harness synthesis counter, reset per session
  const demandBudget = config.demandBudget ?? DEFAULT_FORGE_BUDGET;
  const maxSyntheses = config.maxSynthesesPerSession ?? 3;

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

        // Name-based dedup: prevent duplicate bricks with the same name.
        // Content dedup (hash) misses bricks with slightly different implementations.
        try {
          const nameCheck = await config.forgeStore.search({
            name: brick.name,
            lifecycle: "active",
            limit: 1,
          });
          if (nameCheck.ok && nameCheck.value.length > 0) {
            continue; // Active brick with same name already exists
          }
        } catch (e: unknown) {
          // Non-fatal: proceed with forge if search fails (fail-open)
          onError(e);
        }

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
        } else if (config.notifier !== undefined) {
          void Promise.resolve(
            config.notifier.notify({ kind: "saved", brickId: brick.id, scope: config.scope }),
          ).catch(() => {});
        }
      } catch (err: unknown) {
        onError(err);
      }
    }

    lastForgedCount = forgeHandler.getForgedCount();
  }

  /**
   * Builds a demand-forged artifact for the given brick kind.
   * Shared provenance and metadata are pre-computed; this function
   * only creates the kind-specific artifact shape.
   */
  function buildDemandArtifact(
    signal: ForgeDemandSignal,
    base: {
      readonly id: BrickId;
      readonly name: string;
      readonly description: string;
      readonly scope: ForgeScope;
      readonly provenance: ForgeProvenance;
    },
  ): BrickArtifact {
    const kind = signal.suggestedBrickKind;
    const shared = {
      id: base.id,
      name: base.name,
      description: base.description,
      scope: base.scope,
      origin: "primordial" as const,
      policy: DEFAULT_SANDBOXED_POLICY,
      lifecycle: "active" as const,
      provenance: base.provenance,
      version: "0.1.0",
      tags: ["demand-forged", "pioneer"],
      usageCount: 0,
    };

    switch (kind) {
      case "skill":
        return {
          ...shared,
          kind: "skill",
          content: `# ${base.name}\n\nPioneer skill — demand-triggered for: ${signal.trigger.kind}\n\n## Procedure\n\nTODO: Fill in after observation.\n\n## Pitfalls\n\n${signal.context.failedToolCalls.map((c: string) => `- ${c}`).join("\n") || "None recorded."}\n`,
        } satisfies SkillArtifact;
      case "agent":
        return {
          ...shared,
          kind: "agent",
          manifestYaml: `name: ${base.name}\nversion: "0.1.0"\nmodel:\n  name: "default"\n`,
        } satisfies AgentArtifact;
      case "tool":
        return {
          ...shared,
          kind: "tool",
          implementation: `// Pioneer stub — demand-triggered for: ${signal.trigger.kind}`,
          inputSchema: {},
        } satisfies ToolArtifact;
      case "middleware":
      case "channel":
      case "composite":
        // Demand forging for middleware/channel/composite is not supported;
        // fall back to tool as a safe default
        return {
          ...shared,
          kind: "tool",
          implementation: `// Pioneer stub (${kind} requested, tool created) — demand-triggered for: ${signal.trigger.kind}`,
          inputSchema: {},
        } satisfies ToolArtifact;
    }
  }

  /**
   * Process a demand signal — forge a pioneer brick.
   * Tags as demand-forged/pioneer, starts at sandbox trust.
   */
  async function processDemandForge(signal: ForgeDemandSignal): Promise<void> {
    const now = clock();
    const triggerDesc = describeTrigger(signal.trigger);
    const id = computeBrickId(signal.suggestedBrickKind, `pioneer:${signal.id}:${String(now)}`);

    const name = `pioneer-${triggerDesc}`;
    const description = `Pioneer ${signal.suggestedBrickKind} forged from demand signal: ${signal.trigger.kind}`;

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
        sandbox: true,
        totalDurationMs: 0,
        stageResults: [],
      },
      classification: "public",
      contentMarkers: [],
      contentHash: id,
    };

    const brick = buildDemandArtifact(signal, {
      id,
      name,
      description,
      scope: config.scope,
      provenance,
    });

    // Name-based dedup: prevent duplicate pioneer bricks with the same name.
    // Content dedup (hash) misses pioneers because each attempt has different
    // timestamps/error messages, producing different hashes for the same logical brick.
    try {
      const nameCheck = await config.forgeStore.search({
        name: brick.name,
        lifecycle: "active",
        limit: 1,
      });
      if (nameCheck.ok && nameCheck.value.length > 0) {
        config.demandHandle?.dismiss(signal.id);
        return; // Active brick with same name already exists
      }
    } catch (e: unknown) {
      // Non-fatal: proceed with forge if search fails (fail-open)
      onError(e);
    }

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

    // Notify after successful demand-forged save
    if (config.notifier !== undefined) {
      void Promise.resolve(
        config.notifier.notify({ kind: "saved", brickId: brick.id, scope: config.scope }),
      ).catch(() => {});
    }

    config.onDemandForged?.(signal, brick);
  }

  return {
    name: "auto-forge",
    priority: 960, // After crystallize middleware (950)

    async onSessionStart(_ctx: SessionContext): Promise<void> {
      // Reset per-session counters so each session gets its own budget
      forgeHandler.resetForSession();
      lastForgedCount = 0;
      demandForgedCount = 0;
      synthesesCount = 0;
    },

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

          // Trigger-based dedup: search for existing bricks whose trigger patterns
          // match the demand's capability description before forging a new one.
          // Uses triggerText (not text) to avoid false positives from name/description matches.
          const searchText = extractTriggerSearchText(signal.trigger);
          if (searchText !== undefined) {
            try {
              const existing = await config.forgeStore.search({
                triggerText: searchText,
                lifecycle: "active",
                limit: 1,
              });
              if (existing.ok && existing.value.length > 0) {
                // Existing brick covers this capability — dismiss without forging
                config.demandHandle?.dismiss(signal.id);
                continue;
              }
            } catch (e: unknown) {
              // Non-fatal: proceed with forge if search fails
              onError(e);
            }
          }

          // Increment synchronously BEFORE async dispatch to enforce budget
          // across concurrent fire-and-forget tasks
          demandForgedCount++;

          // Route failure-driven signals to harness synthesis when configured
          const useHarnessSynth =
            config.synthesizeHarness !== undefined &&
            signal.trigger.kind === "repeated_failure" &&
            synthesesCount < maxSyntheses;

          if (useHarnessSynth) {
            synthesesCount++;
            // Fire-and-forget: harness synthesis runs in background (Issue 15A)
            // justified: fire-and-forget pattern — errors handled via onError callback
            void Promise.resolve().then(async () => {
              try {
                const brick = (await config.synthesizeHarness?.(signal)) ?? null;
                if (brick !== null) {
                  config.onDemandForged?.(signal, brick);
                }
              } catch (err: unknown) {
                onError(err);
              }
            });
          } else {
            // Fire-and-forget: demand forge (pioneer stub) runs asynchronously
            // justified: fire-and-forget pattern — errors handled via onError callback
            void Promise.resolve().then(async () => {
              try {
                await processDemandForge(signal);
              } catch (err: unknown) {
                onError(err);
              }
            });
          }

          // Dismiss the signal after triggering forge (success or failure)
          config.demandHandle?.dismiss(signal.id);
        }
      }
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      const totalForged = lastForgedCount + demandForgedCount;
      if (totalForged === 0 && synthesesCount === 0) return undefined;
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
      if (synthesesCount > 0) {
        parts.push(
          `${String(synthesesCount)} harness${synthesesCount === 1 ? "" : "es"} synthesized`,
        );
      }
      return {
        label: "auto-forge",
        description: parts.join("; "),
      };
    },
  };
}
