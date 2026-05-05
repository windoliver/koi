/**
 * Federation middleware — KoiMiddleware that transparently routes
 * cross-zone tool calls via Nexus JSON-RPC.
 */

import type { KoiMiddleware, ToolRequest, ToolResponse, ZoneId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

/** Config for createFederationMiddleware. */
export interface FederationMiddlewareConfig {
  readonly localZoneId: ZoneId;
  /** Map of remote zone ID → transport bound to that zone. */
  readonly remoteTransports: ReadonlyMap<string, NexusTransport>;
  /** Optional callback invoked when a tool call is delegated to a remote zone. */
  readonly onDelegated?: (zoneId: string, request: ToolRequest) => void;
}

/**
 * Creates a KoiMiddleware that routes cross-zone tool calls.
 *
 * On every wrapToolCall:
 * 1. Reads `ctx.metadata.targetZoneId`
 * 2. If absent → passes through (local execution)
 * 3. If matches localZoneId → passes through
 * 4. If unknown zone → throws (EXTERNAL error)
 * 5. Otherwise → routes via `transport.call("federation.zone_execute", ...)`
 */
export function createFederationMiddleware(config: FederationMiddlewareConfig): KoiMiddleware {
  const { localZoneId, remoteTransports, onDelegated } = config;

  return {
    name: "koi:federation",

    describeCapabilities: (ctx) => {
      const targetZoneId = ctx.metadata.targetZoneId;
      if (typeof targetZoneId !== "string") return undefined;
      return {
        label: "federation",
        description: `Cross-zone routing active (target=${targetZoneId})`,
      };
    },

    wrapToolCall: async (ctx, request, next) => {
      const targetZoneId = ctx.metadata.targetZoneId;

      // No target zone or non-string → local execution
      if (typeof targetZoneId !== "string") {
        return next(request);
      }

      // Target is local zone → pass through
      if (targetZoneId === localZoneId) {
        return next(request);
      }

      const remoteTransport = remoteTransports.get(targetZoneId);
      if (remoteTransport === undefined) {
        throw new Error(
          `Federation routing failed: unknown target zone "${targetZoneId}" (tool=${request.toolId})`,
        );
      }

      if (onDelegated !== undefined) {
        onDelegated(targetZoneId, request);
      }

      const result = await remoteTransport.call<ToolResponse>("federation.zone_execute", {
        toolId: request.toolId,
        input: request.input,
        targetZoneId,
      });

      if (!result.ok) {
        throw new Error(
          `Federation remote call failed: zone "${targetZoneId}" returned error (tool=${request.toolId}): ${result.error.message}`,
          { cause: result.error },
        );
      }

      return result.value;
    },
  };
}
