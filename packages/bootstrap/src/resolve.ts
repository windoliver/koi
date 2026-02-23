/**
 * Bootstrap file hierarchy resolver — main entry point.
 *
 * Resolves .koi/{INSTRUCTIONS,TOOLS,CONTEXT}.md files per agent type
 * and outputs BootstrapTextSource[] items for the context hydrator.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { resolveSlot } from "./slot.js";
import type {
  BootstrapConfig,
  BootstrapResolveResult,
  BootstrapResult,
  BootstrapSlot,
  BootstrapTextSource,
  ResolvedSlot,
} from "./types.js";

/** Default file slots for the bootstrap hierarchy. */
export const DEFAULT_SLOTS: readonly BootstrapSlot[] = [
  { fileName: "INSTRUCTIONS.md", label: "Agent Instructions", budget: 8_000 },
  { fileName: "TOOLS.md", label: "Tool Guidelines", budget: 4_000 },
  { fileName: "CONTEXT.md", label: "Domain Context", budget: 4_000 },
] as const satisfies readonly BootstrapSlot[];

/**
 * Size guard multiplier. Files whose byte size exceeds budget * this factor
 * are skipped entirely. Uses a generous factor to account for multi-byte
 * characters (budget is in characters, originalSize is in bytes).
 */
const SIZE_GUARD_FACTOR = 8;

/**
 * Resolves bootstrap files from the .koi/ hierarchy.
 *
 * For each slot, checks agent-specific path first, then project-level.
 * Agent-specific overrides project-level entirely (no concatenation).
 * All slots are resolved in parallel via Promise.allSettled.
 */
export async function resolveBootstrap(config: BootstrapConfig): Promise<BootstrapResolveResult> {
  if (config.rootDir === "") {
    const error: KoiError = {
      code: "VALIDATION",
      message: "rootDir must be a non-empty string",
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
    return { ok: false, error };
  }

  const slots = config.slots ?? DEFAULT_SLOTS;

  if (slots.length === 0) {
    return {
      ok: true,
      value: { sources: [], resolved: [], warnings: [] },
    };
  }

  const settlements = await Promise.allSettled(
    slots.map((slot) => resolveSlot(slot, config.rootDir, config.agentName)),
  );

  // Local accumulators — scoped to this function, returned as readonly
  const resolved: ResolvedSlot[] = [];
  const sources: BootstrapTextSource[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < settlements.length; i++) {
    const settlement = settlements[i];
    const slot = slots[i];
    if (settlement === undefined || slot === undefined) {
      continue;
    }

    if (settlement.status === "rejected") {
      const reason =
        settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
      warnings.push(`Failed to resolve "${slot.label}": ${reason}`);
      continue;
    }

    const resolvedSlot = settlement.value;
    if (resolvedSlot === undefined) {
      continue;
    }

    // Size guard: skip files that are excessively large
    if (resolvedSlot.originalSize > slot.budget * SIZE_GUARD_FACTOR) {
      warnings.push(
        `"${slot.label}" (${resolvedSlot.resolvedFrom}) exceeds size limit (${resolvedSlot.originalSize} bytes > ${slot.budget * SIZE_GUARD_FACTOR} max) — skipped`,
      );
      continue;
    }

    // Truncation warning
    if (resolvedSlot.truncated) {
      warnings.push(
        `"${slot.label}" truncated to ${slot.budget} characters (original: ${resolvedSlot.originalSize} bytes)`,
      );
    }

    resolved.push(resolvedSlot);
    sources.push({
      kind: "text",
      text: resolvedSlot.content,
      label: resolvedSlot.label,
      priority: i,
    });
  }

  const result: BootstrapResult = { sources, resolved, warnings };
  return { ok: true, value: result };
}
