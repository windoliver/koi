/**
 * Federation middleware — KoiMiddleware that transparently routes
 * cross-zone tool calls via Nexus JSON-RPC.
 *
 * Pattern: follows @koi/delegation/src/middleware.ts.
 */

import type { KoiMiddleware, ToolRequest, ToolResponse, ZoneId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Config for createFederationMiddleware. */
export interface FederationMiddlewareConfig {
  readonly localZoneId: ZoneId;
  readonly remoteClients: ReadonlyMap<string, NexusClient>;
  /** Optional callback invoked when a tool call is delegated to a remote zone. */
  readonly onDelegated?: (zoneId: string, request: ToolRequest) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a KoiMiddleware that routes cross-zone tool calls.
 *
 * On every wrapToolCall:
 * 1. Reads `ctx.metadata.targetZoneId`
 * 2. If absent → passes through (local execution)
 * 3. If matches localZoneId → passes through
 * 4. If unknown zone → returns EXTERNAL error
 * 5. Otherwise → routes via `remoteClient.rpc("federation.zone_execute", ...)`
 */
export function createFederationMiddleware(config: FederationMiddlewareConfig): KoiMiddleware {
  const { localZoneId, remoteClients, onDelegated } = config;

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

      // No target zone → local execution
      if (typeof targetZoneId !== "string") {
        return next(request);
      }

      // Target is local zone → pass through
      if (targetZoneId === localZoneId) {
        return next(request);
      }

      // Look up remote client
      const remoteClient = remoteClients.get(targetZoneId);
      if (remoteClient === undefined) {
        throw new Error(
          `Federation routing failed: unknown target zone "${targetZoneId}" (tool=${request.toolId})`,
        );
      }

      // Notify delegation callback
      if (onDelegated !== undefined) {
        onDelegated(targetZoneId, request);
      }

      // Route to remote zone via RPC
      const result = await remoteClient.rpc<ToolResponse>("federation.zone_execute", {
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
