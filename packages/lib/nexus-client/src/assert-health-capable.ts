import type { HealthCapableNexusTransport, NexusTransport, NexusTransportKind } from "./types.js";

/**
 * Type guard / runtime assertion: throws if `t` is not HealthCapable.
 * Used at the HTTP probe site so a non-HealthCapable HTTP transport
 * fails loudly at startup with an actionable message.
 */
export function assertHealthCapable(t: NexusTransport): asserts t is HealthCapableNexusTransport {
  if (typeof t.health !== "function") {
    throw new Error(
      "HTTP nexus transport is missing required `health()` method — " +
        "construct via createHttpTransport (this package) or the fs-nexus HTTP wrapper.",
    );
  }
}

/**
 * Production-boundary assertion. Throws if `kind` is missing — preserves
 * authorization/audit guarantees during transport-adapter migration.
 *
 * The fs-only escape hatch works by NOT calling this assertion at all:
 * `runtime-factory.ts` skips it when `nexusPermissionsEnabled === false &&
 * nexusAuditEnabled === false`. Library code MUST NOT call this itself.
 */
export function assertProductionTransport(
  t: NexusTransport,
): asserts t is NexusTransport & { readonly kind: NexusTransportKind } {
  if (t.kind === undefined) {
    throw new Error(
      "nexus transport is missing required `kind` discriminator — " +
        "construct via createHttpTransport / createLocalBridgeTransport / " +
        "createLocalBridgeProbeTransport / fs-nexus HTTP wrapper, OR set " +
        "nexusPermissionsEnabled=false AND nexusAuditEnabled=false to " +
        "explicitly opt out of Nexus consumer wiring (transport will still " +
        "be used by other subsystems).",
    );
  }
}
