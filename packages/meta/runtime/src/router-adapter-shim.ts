import type {
  AdapterCapabilities,
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
 * trail (which adapter was selected, which were rejected/failed, why) — a
 * TUI or logger consumes this to surface fallback to end users.
 */
export interface RouterAdapterShimOptions {
  readonly router: SandboxRouter;
  readonly name?: string;
  readonly version?: string;
  readonly onDecision?: (decision: SelectionDecision) => void;
}

export function createRouterAdapterShim(opts: RouterAdapterShimOptions): SandboxAdapter {
  const { router } = opts;
  const allBackends = router.describe();
  const supports = new Set<
    AdapterCapabilities["supports"] extends ReadonlySet<infer C> ? C : never
  >();
  let priority = Number.MAX_SAFE_INTEGER;
  for (const b of allBackends) {
    for (const cap of b.capabilities.supports) supports.add(cap);
    if (b.capabilities.priority < priority) priority = b.capabilities.priority;
  }
  return {
    name: opts.name ?? "@koi/router-adapter",
    version: opts.version ?? "0.1.0",
    capabilities: { supports, priority },
    async create(profile: SandboxProfile): Promise<SandboxInstance> {
      const result = await router.create(profile);
      if (!result.ok) {
        throw new Error(formatError(result.error), { cause: result.error });
      }
      opts.onDecision?.(result.value.decision);
      return result.value.instance;
    },
  };
}

function formatError(error: KoiError): string {
  const reason = (error.context as { reason?: string } | undefined)?.reason;
  return reason !== undefined
    ? `sandbox-router: ${error.message} (reason=${reason})`
    : `sandbox-router: ${error.message}`;
}
