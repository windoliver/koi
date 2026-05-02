import type {
  AdapterCapabilities,
  AdapterCapability,
  KoiError,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import type { SandboxRouter, SelectionDecision } from "@koi/sandbox-router";

/**
 * Minimal `SandboxAdapter` shim that delegates to a `SandboxRouter`.
 *
 * Lets existing callers that wire a single `SandboxAdapter` (e.g., the bash
 * tool's `sandboxAdapter` field) pick up multi-backend fallback transparently.
 * The `onDecision` callback fires once per `create()`, exposing the audit
 * trail (which adapter was selected, which were rejected/failed, why).
 *
 * **Capability advertisement.** Capabilities exposed on the shim are NOT the
 * union of every backend — that would lie about guarantees the shim cannot
 * uphold (e.g., advertising `copy-files` while a low-priority OS backend
 * gets selected and throws on `readFile`). The shim instead advertises only
 * the **intersection** of all backend supports — capabilities every backend
 * declares — so a caller introspecting `adapter.capabilities` only sees
 * guarantees that hold regardless of which backend is selected. Callers
 * needing a specific capability MUST set `profile.required` so the router
 * can filter to backends that support it.
 *
 * `capabilitiesOverride` lets the caller force an explicit advertisement
 * (e.g., the bash-tool shim only ever exec()s — `{ supports: ["exec"] }`).
 */
export interface RouterAdapterShimOptions {
  readonly router: SandboxRouter;
  readonly name?: string;
  readonly version?: string;
  readonly onDecision?: (decision: SelectionDecision) => void;
  /**
   * Override the auto-computed intersection. When set, the shim advertises
   * exactly these capabilities — useful when the caller only ever invokes
   * a known subset of the SandboxInstance API (e.g., `exec` only).
   */
  readonly capabilitiesOverride?: AdapterCapabilities;
}

export function createRouterAdapterShim(opts: RouterAdapterShimOptions): SandboxAdapter {
  const { router } = opts;
  const capabilities = opts.capabilitiesOverride ?? computeIntersection(router);
  return {
    name: opts.name ?? "@koi/router-adapter",
    version: opts.version ?? "0.1.0",
    capabilities,
    async create(profile: SandboxProfile): Promise<SandboxInstance> {
      const result = await router.create(profile);
      if (!result.ok) {
        throw new Error(formatError(result.error), { cause: result.error });
      }
      // Observer callbacks must never propagate failures to the caller —
      // the instance has already been created and would otherwise leak.
      try {
        opts.onDecision?.(result.value.decision);
      } catch {
        // Swallow — observers are advisory; failure here cannot retroactively
        // unmake the sandbox instance.
      }
      return result.value.instance;
    },
  };
}

function computeIntersection(router: SandboxRouter): AdapterCapabilities {
  const backends = router.describe();
  if (backends.length === 0) {
    return { supports: new Set(), priority: Number.MAX_SAFE_INTEGER };
  }
  const first = backends[0];
  if (first === undefined) return { supports: new Set(), priority: Number.MAX_SAFE_INTEGER };
  const supports = new Set<AdapterCapability>(first.capabilities.supports);
  let priority = first.capabilities.priority;
  for (let i = 1; i < backends.length; i++) {
    const b = backends[i];
    if (b === undefined) continue;
    for (const cap of [...supports]) {
      if (!b.capabilities.supports.has(cap)) supports.delete(cap);
    }
    if (b.capabilities.priority < priority) priority = b.capabilities.priority;
  }
  return { supports, priority };
}

function formatError(error: KoiError): string {
  const reason = (error.context as { reason?: string } | undefined)?.reason;
  return reason !== undefined
    ? `sandbox-router: ${error.message} (reason=${reason})`
    : `sandbox-router: ${error.message}`;
}
