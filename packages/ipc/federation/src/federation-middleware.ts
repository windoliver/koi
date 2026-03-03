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
        return makeErrorResponse(request, "unknown_zone", `Unknown target zone: ${targetZoneId}`);
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
        return makeErrorResponse(
          request,
          "remote_error",
          `Remote zone ${targetZoneId} failed: ${result.error.message}`,
        );
      }

      return result.value;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeErrorResponse(request: ToolRequest, reason: string, message: string): ToolResponse {
  return {
    output: null,
    metadata: {
      error: {
        code: "EXTERNAL",
        message: `Federation error: ${message} (tool=${request.toolId})`,
        retryable: false,
        reason,
      },
    },
  };
}
