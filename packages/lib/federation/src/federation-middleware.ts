/**
 * Federation middleware — KoiMiddleware that transparently routes
 * cross-zone tool calls via Nexus JSON-RPC.
 */

import type { KoiMiddleware, ToolRequest, ToolResponse, ZoneId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { FEDERATION_PROTOCOL_VERSION } from "./types.js";

/**
 * Capabilities advertised by a remote peer. Used to gate optional v1
 * features (e.g. `federation.zone_cancel`) so unsupported peers do not
 * appear "cancellable" when no receiver exists. If a per-zone entry is
 * absent, defaults are conservative: cancel is OFF, since dispatching a
 * cancel RPC to a peer that does not implement it would still leave the
 * remote work running while telling the caller "indeterminate".
 */
export interface FederationRemoteCapabilities {
  /** Remote implements `federation.zone_cancel`. */
  readonly cancel?: boolean;
}

/** Config for createFederationMiddleware. */
export interface FederationMiddlewareConfig {
  readonly localZoneId: ZoneId;
  /** Map of remote zone ID → transport bound to that zone. */
  readonly remoteTransports: ReadonlyMap<string, NexusTransport>;
  /**
   * Per-remote-zone capability map. When `cancel: true` is advertised,
   * abort triggers a `federation.zone_cancel` RPC and the local promise
   * rejects with `FederationAbortError`. When `cancel` is unset/false,
   * abort still rejects locally but the error message and `kind` make it
   * clear cancellation is best-effort/unsupported, so callers do not
   * assume the remote stopped.
   */
  readonly remoteCapabilities?: ReadonlyMap<string, FederationRemoteCapabilities>;
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
  const { localZoneId, remoteTransports, remoteCapabilities, onDelegated } = config;

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

      const signal = request.signal;

      // Synthesize a callId early so even pre-flight aborts surface a
      // structured FederationAbortError with a stable correlation handle.
      const federationCallId = request.callId ?? `fed-${crypto.randomUUID()}`;

      const cancelSupportedPreflight = remoteCapabilities?.get(targetZoneId)?.cancel === true;

      // Pre-flight: caller already gave up. Do NOT dispatch remote work
      // (would cause non-idempotent side effects after local abort).
      if (signal?.aborted === true) {
        throw newAbortError(
          targetZoneId,
          request.toolId,
          federationCallId,
          cancelSupportedPreflight,
        );
      }

      if (onDelegated !== undefined) {
        onDelegated(targetZoneId, request);
      }

      // Only dispatch cancel when the remote has advertised support.
      // Without an advertised handler, sending the RPC is best-effort
      // misleading: the caller would see "cancelled" but the remote work
      // would continue. Surface this as an unsupported-cancel error
      // instead so non-idempotent callers stay aware.
      const cancelSupported = remoteCapabilities?.get(targetZoneId)?.cancel === true;

      // let: flips on first cancel dispatch — keeps onAbort idempotent
      // (the listener may also be invoked manually by the post-dispatch
      // race-closing re-check below).
      let cancelled = false;
      const sendCancel = (): void => {
        if (cancelled) return;
        cancelled = true;
        if (!cancelSupported) return;
        // Use the same correlation tuple as zone_execute so the remote
        // can authoritatively identify the right in-flight invocation.
        // callId alone is not enough: callers may reuse callId values
        // and the synthesized fed-* ids are scoped to this origin zone.
        void remoteTransport
          .call<void>("federation.zone_cancel", {
            protocolVersion: FEDERATION_PROTOCOL_VERSION,
            callId: federationCallId,
            targetZoneId,
            originZoneId: localZoneId,
            toolId: request.toolId,
          })
          .catch(() => {
            // Best-effort cleanup — the remote may have already finished.
          });
      };

      // Register the abort listener BEFORE dispatching zone_execute so an
      // abort that fires between dispatch and listener-registration cannot
      // be lost. The abort path will fire sendCancel + reject as soon as
      // the signal flips.
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        if (signal === undefined) return; // never settles → harmless
        onAbort = () => {
          sendCancel();
          reject(newAbortError(targetZoneId, request.toolId, federationCallId, cancelSupported));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });

      // Forward the full invocation envelope so the remote zone can enforce
      // the same policy/approval semantics and lifecycle guarantees as the
      // local path. AbortSignal cannot serialize over JSON-RPC; bridge it
      // via a best-effort federation.zone_cancel and race the remote
      // execute against a local abort promise so cancellation actually
      // unblocks the caller even if the remote ignores the cancel RPC.
      const callPromise = remoteTransport.call<ToolResponse>("federation.zone_execute", {
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        toolId: request.toolId,
        input: request.input,
        metadata: request.metadata,
        callId: federationCallId,
        targetZoneId,
        originZoneId: localZoneId,
      });

      // Re-check after listener+dispatch in case the signal flipped during
      // synchronous setup (closes the listener-registration race).
      if (signal !== undefined && signal.aborted && onAbort !== undefined) {
        onAbort();
      }

      try {
        const result = await Promise.race([callPromise, abortPromise]);
        if (!result.ok) {
          throw new Error(
            `Federation remote call failed: zone "${targetZoneId}" returned error (tool=${request.toolId}): ${result.error.message}`,
            { cause: result.error },
          );
        }
        return result.value;
      } finally {
        if (signal !== undefined && onAbort !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    },
  };
}

/**
 * Error thrown when a federated tool call is aborted by the caller. Remote
 * cancellation is best-effort: the call may have already committed side
 * effects on the target zone before the cancel RPC arrives, or the cancel
 * may be lost. Treat this as **outcome-indeterminate** — callers must not
 * retry non-idempotent operations without external dedup/idempotency keys.
 */
export interface FederationAbortError extends Error {
  readonly kind: "federation_abort_indeterminate";
  readonly targetZoneId: string;
  readonly toolId: string;
  readonly callId: string;
}

function newAbortError(
  targetZoneId: string,
  toolId: string,
  callId: string,
  cancelSupported: boolean,
): FederationAbortError {
  const cancelNote = cancelSupported
    ? "A federation.zone_cancel was dispatched best-effort."
    : "The remote zone has NOT advertised cancel support — no cancel RPC was dispatched and the remote will likely run to completion.";
  const err = new Error(
    `Federation tool call aborted; remote outcome indeterminate (zone="${targetZoneId}", tool=${toolId}, callId=${callId}). ` +
      `${cancelNote} Do NOT retry without an idempotency key — the remote may have already committed side effects.`,
  ) as Error & {
    kind: "federation_abort_indeterminate";
    targetZoneId: string;
    toolId: string;
    callId: string;
  };
  err.kind = "federation_abort_indeterminate";
  err.targetZoneId = targetZoneId;
  err.toolId = toolId;
  err.callId = callId;
  return err;
}
