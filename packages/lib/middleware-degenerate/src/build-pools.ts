/**
 * Builds variant pools from ForgeStore queries.
 *
 * For each capability in the config, queries the forge store for matching
 * bricks and builds executable ToolHandler entries with fitness scores.
 */

import type {
  BrickArtifact,
  DegeneracyConfig,
  ForgeStore,
  ToolHandler,
  ToolPolicy,
} from "@koi/core";
import { computeBrickFitness } from "@koi/validation";
import type { VariantEntry, VariantPool } from "@koi/variant-selection";

/**
 * Stable JSON fingerprint of a tool's policy envelope. Keys are sorted
 * recursively so two structurally-equal policies produce the same string
 * regardless of property order. Used to enforce that every variant in a
 * degenerate pool shares an identical sandbox/capabilities envelope.
 */
function fingerprintPolicy(policy: ToolPolicy): string {
  return stableStringify(policy);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export interface BuildPoolsOptions {
  readonly forgeStore: ForgeStore;
  readonly capabilityConfigs: ReadonlyMap<string, DegeneracyConfig>;
  readonly createToolExecutor: (brick: BrickArtifact) => ToolHandler | Promise<ToolHandler>;
  readonly clock: () => number;
}

export interface BuildPoolsResult {
  readonly pools: ReadonlyMap<string, VariantPool<ToolHandler>>;
  readonly toolToCapability: ReadonlyMap<string, string>;
  /** variant id (brick.id) → variant alias (brick.name). */
  readonly variantAliases: ReadonlyMap<string, string>;
}

/**
 * Queries the forge store for variants of each capability and builds
 * executable variant pools.
 *
 * Also returns a mapping from tool name → capability name for fast lookup.
 */
export async function buildVariantPools(options: BuildPoolsOptions): Promise<BuildPoolsResult> {
  const { forgeStore, capabilityConfigs, createToolExecutor, clock } = options;
  const nowMs = clock();
  const pools = new Map<string, VariantPool<ToolHandler>>();
  const toolToCapability = new Map<string, string>();
  const variantAliases = new Map<string, string>();

  for (const [capability, config] of capabilityConfigs) {
    // Query forge store for bricks tagged with this capability
    const searchResult = await forgeStore.search({
      kind: "tool",
      lifecycle: "active",
      tags: [`capability:${capability}`],
    });

    // Fail closed when a configured capability cannot be hydrated.
    // Both store errors (retryable or not) and an empty result set must
    // reach the minVariants enforcement below — silently dropping a
    // configured pool removes failover exactly when it is needed most
    // and is invisible to the operator. The error is annotated with
    // whether it was retryable so wrappers can decide to retry session
    // start vs surface a hard config failure.
    if (!searchResult.ok) {
      const message =
        searchResult.error.message !== undefined && searchResult.error.message !== ""
          ? searchResult.error.message
          : "unknown error";
      const retryHint = searchResult.error.retryable === true ? " [retryable]" : "";
      throw new Error(
        `Capability "${capability}": ForgeStore search failed during session start${retryHint}: ${message}`,
      );
    }

    const bricks = searchResult.value;

    // Score and sort bricks by fitness, then cap at maxVariants.
    // Rank all bricks by fitness; we'll walk the list and build
    // executors until we have `maxVariants` USABLE entries (or run out
    // of candidates). The candidate window is no longer a strict head
    // slice — a single stale top-ranked brick that fails to hydrate
    // must not strand healthy lower-ranked variants below the cutoff
    // and turn drift/partial rollout into a hard outage.
    const candidates: { readonly brick: BrickArtifact; readonly fitness: number }[] = bricks
      .map((brick) => ({
        brick,
        fitness: brick.fitness !== undefined ? computeBrickFitness(brick.fitness, nowMs) : 0,
      }))
      .sort((a, b) => b.fitness - a.fitness);

    // Build executable entries within the candidate window. Per-variant
    // best-effort: a single broken brick must not abort session start
    // for every other capability — skip and record diagnostics. Pool
    // health is enforced against config.minVariants below.
    //
    // Alias ownership policy:
    //   - failoverEnabled=true: claim every candidate alias regardless
    //     of executor build success, so a request addressed to a broken
    //     alias still enters degeneracy and gets served by a healthy
    //     peer. Otherwise partial startup failure silently bypasses
    //     degeneracy and produces a user-visible hard failure.
    //   - failoverEnabled=false: only claim aliases whose executor
    //     actually built. Claiming a broken alias here would silently
    //     reroute it to a healthy peer (the broken brick is absent from
    //     the pool, so executeWithFailover()'s failoverEnabled gate
    //     never fires) — exactly what failoverEnabled=false rules out.
    const entries: VariantEntry<ToolHandler>[] = [];
    const failures: { readonly brickId: string; readonly error: string }[] = [];
    // Policy fingerprint of the first claimed brick — every subsequent variant
    // must match it. Failover preserves the caller-addressed alias as the
    // public toolId, so downstream auth/audit middleware sees one identity for
    // the whole pool. Allowing variants with divergent sandbox/network/policy
    // envelopes turns failover into a trust-boundary bypass: a request
    // authorized as the alias would silently execute a brick with a wider
    // (or narrower) policy. Fail loudly at session start instead.
    // let justified: set on first successful claim, compared on every subsequent claim
    let policyFingerprint: string | undefined;
    for (const { brick, fitness } of candidates) {
      if (entries.length >= config.maxVariants) break;
      // Always remember alias→variant for the candidate window so the
      // middleware can rewrite ToolRequest.toolId on alternate-variant
      // dispatch (downstream policy/audit then sees the executing
      // variant's identity, not the originally-addressed alias).
      variantAliases.set(brick.id, brick.name);
      // Reject duplicate brick.name anywhere in a configured pool — both
      // across capabilities (later pool would steal the alias and route
      // into the wrong capability) and within a single capability (the
      // reverse alias→variantId map would silently let the last
      // duplicate win and execute a different variant than addressed).
      const claimedBy = toolToCapability.get(brick.name);
      if (claimedBy !== undefined) {
        const sameCapability = claimedBy === capability;
        const detail = sameCapability
          ? `is already claimed within capability "${capability}" by another variant`
          : `is already claimed by capability "${claimedBy}"`;
        throw new Error(
          `Capability "${capability}": brick alias "${brick.name}" ${detail}. ` +
            "Alias collisions are not allowed — give each variant a distinct public name.",
        );
      }
      const brickFingerprint = fingerprintPolicy(brick.policy);
      if (policyFingerprint !== undefined && brickFingerprint !== policyFingerprint) {
        throw new Error(
          `Capability "${capability}": brick "${brick.name}" (${brick.id}) has a policy ` +
            "envelope that diverges from peer variants in the same pool. All variants must " +
            "share an identical sandbox/capabilities envelope so failover stays inside the " +
            "alias's authorization scope.",
        );
      }
      try {
        const handler = await createToolExecutor(brick);
        entries.push({
          id: brick.id,
          value: handler,
          fitnessScore: fitness,
        });
        toolToCapability.set(brick.name, capability);
        if (policyFingerprint === undefined) policyFingerprint = brickFingerprint;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Unknown executor build error";
        failures.push({ brickId: brick.id, error: message });
        if (config.failoverEnabled === true) {
          toolToCapability.set(brick.name, capability);
        }
      }
    }

    if (entries.length < config.minVariants) {
      const failureSummary =
        failures.length > 0
          ? ` (${String(failures.length)} executor build failure(s): ${failures.map((f) => `${f.brickId}: ${f.error}`).join("; ")})`
          : "";
      throw new Error(
        `Capability "${capability}": only ${String(entries.length)} usable variant(s), ` +
          `below configured minVariants=${String(config.minVariants)}${failureSummary}`,
      );
    }

    pools.set(capability, {
      capability,
      variants: entries,
      config,
    });
  }

  return { pools, toolToCapability, variantAliases };
}
