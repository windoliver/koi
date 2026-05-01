import type { AdapterCapability, CapabilityRequirements, SandboxAdapter } from "@koi/core";

export interface MatchRejection {
  readonly adapter: string;
  readonly reason: "missing-capabilities" | "forbidden-capabilities";
  readonly missing?: readonly AdapterCapability[];
}

export interface MatchResult {
  readonly matched: readonly SandboxAdapter[];
  readonly rejected: readonly MatchRejection[];
}

/**
 * Filter adapters by a capability requirement set.
 *
 * Adapters that lack a `capabilities` declaration are rejected with reason
 * `missing-capabilities` and the full required set as `missing` — they cannot
 * participate in router-driven selection.
 *
 * Order of `matched` mirrors the input adapter order. Sorting is the caller's
 * job (router applies state + priority sort).
 */
export function matchAdapters(
  adapters: readonly SandboxAdapter[],
  requirements: CapabilityRequirements,
): MatchResult {
  const matched: SandboxAdapter[] = [];
  const rejected: MatchRejection[] = [];

  for (const adapter of adapters) {
    const supports = adapter.capabilities?.supports;
    if (supports === undefined) {
      rejected.push({
        adapter: adapter.name,
        reason: "missing-capabilities",
        missing: [...requirements.required],
      });
      continue;
    }

    const missing: AdapterCapability[] = [];
    for (const cap of requirements.required) {
      if (!supports.has(cap)) missing.push(cap);
    }
    if (missing.length > 0) {
      rejected.push({ adapter: adapter.name, reason: "missing-capabilities", missing });
      continue;
    }

    if (requirements.forbidden !== undefined) {
      let forbiddenHit = false;
      for (const cap of requirements.forbidden) {
        if (supports.has(cap)) {
          forbiddenHit = true;
          break;
        }
      }
      if (forbiddenHit) {
        rejected.push({ adapter: adapter.name, reason: "forbidden-capabilities" });
        continue;
      }
    }

    matched.push(adapter);
  }

  return { matched, rejected };
}
