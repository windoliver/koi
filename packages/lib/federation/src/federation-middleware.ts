/**
 * Federation middleware — KoiMiddleware that transparently routes
 * cross-zone tool calls via Nexus JSON-RPC.
 */

import type { KoiMiddleware, ToolRequest, ToolResponse, ZoneId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { FEDERATION_PROTOCOL_VERSION } from "./types.js";
import type { ZoneRouter } from "./zone-router.js";

/**
 * How the local origin's principal (agent/session/turn identity) is
 * forwarded on `federation.zone_execute`.
 *
 * - `"omit"` (default, safest): no principal envelope is sent. The
 *   remote zone is expected to authorize delegated calls under its
 *   own service principal. Use whenever the remote-zone transport is
 *   not mutually authenticated, or until cryptographically signed
 *   principal envelopes land (#1410).
 * - `"forward"`: send the unsigned principal envelope. ONLY safe when
 *   the transport itself authenticates the origin zone (e.g. mTLS or
 *   a Nexus-signed channel) AND the remote zone explicitly trusts
 *   forwarded principals from this origin. An unprotected `"forward"`
 *   lets a compromised or misconfigured origin spoof tenant/user
 *   identity to the remote.
 */
export type FederationPrincipalPolicy = "omit" | "forward";

/**
 * Capabilities advertised by a remote peer (controls what the wire
 * protocol *can* do). Discovery of these may be peer-controlled, so
 * they MUST NOT, on their own, authorize the release of identity data
 * to that peer. Identity-release decisions live in
 * `FederationMiddlewareConfig.principalForwarding`, which is a local
 * trust decision the operator makes per zone.
 */
export interface FederationRemoteCapabilities {
  /** Remote implements `federation.zone_cancel`. */
  readonly cancel?: boolean;
  /**
   * Remote receiver understands the optional `principalPolicy` /
   * `principal` fields on `federation.zone_execute`. When set, this
   * package will include the policy field on the wire (so future
   * receivers can validate; an `"omit"` policy still produces no
   * principal envelope). When unset, the legacy v1 payload shape
   * is sent unchanged for wire compatibility.
   */
  readonly understandsPrincipalFields?: boolean;
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
   * assume the remote stopped. NOTE: remote capabilities describe what
   * the wire CAN do — they do NOT authorize identity release. See
   * `principalForwarding` for that.
   */
  readonly remoteCapabilities?: ReadonlyMap<string, FederationRemoteCapabilities>;
  /**
   * **Local** trust decision: per-remote-zone policy for forwarding
   * the caller's principal envelope. This is operator-controlled, NOT
   * peer-advertised. A peer cannot opt itself into receiving identity
   * by advertising capability bits — `principalForwarding` must
   * explicitly list the zone with `"forward"`.
   *
   * Defaults to `"omit"` for any zone not present in the map. Set to
   * `"forward"` ONLY for zones reached over a transport that
   * authenticates the origin (mTLS / signed Nexus channel) AND whose
   * receiver is independently trusted to handle the principal.
   * Cryptographically signed envelopes are deferred to #1410.
   */
  readonly principalForwarding?: ReadonlyMap<string, FederationPrincipalPolicy>;
  /**
   * Resolves the tenant identifier for the current call. **Required**
   * whenever any zone in `principalForwarding` is set to `"forward"`.
   *
   * Tenant isolation cannot rely on `agentId`/`sessionId`/`userId`
   * alone — those identifiers may be tenant-scoped in the local zone
   * but collide across tenants when re-evaluated by a remote. The
   * forwarded principal therefore carries an explicit `tenantId`
   * claim sourced via this resolver. Returning `undefined` or an empty
   * string for a `"forward"` zone aborts the call with a structured
   * error so callers do not silently leak across tenant boundaries.
   *
   * The resolver receives the same `ctx` shape passed to
   * `KoiMiddleware.wrapToolCall` so operators can pull tenant from
   * wherever it actually lives in their deployment (session bag,
   * channel metadata, gateway-injected ctx field, etc.).
   */
  readonly tenantIdResolver?: (ctx: TenantResolverContext) => string | undefined;
  /**
   * Allowlist of `request.metadata` keys that may be forwarded over the
   * federation boundary. **Required** — operators must make an explicit
   * choice rather than rely on a default.
   *
   * `request.metadata` is a generic JsonObject. Two failure modes pull
   * in opposite directions:
   * 1. Forwarding it wholesale lets a compromised or misconfigured
   *    origin fabricate elevated context (approval flags, credentials
   *    accidentally stashed by upstream middleware) that a remote
   *    receiver may trust to short-circuit its own approval flow.
   * 2. Dropping it wholesale silently desynchronizes authorization:
   *    permissions middleware keys policy on `request.metadata`, so a
   *    federated call can be allowed locally but denied remotely (or
   *    vice versa) just because the bag was stripped.
   *
   * There is no safe default. Operators must enumerate the keys their
   * remote permissions/policy layer relies on (so cross-zone
   * authorization sees the same inputs) AND that they trust to
   * traverse the federation boundary. Use `new Set()` only after
   * confirming no policy depends on per-request metadata. A signed
   * envelope that lets the remote authoritatively re-derive context
   * lands in #1410.
   */
  readonly forwardedMetadataKeys?: ReadonlySet<string>;
  /**
   * Optional zone-aware router. When `ctx.metadata.targetZoneId` is absent,
   * the router selects the best healthy zone for the request. Returning
   * `undefined` keeps the call local.
   */
  readonly zoneRouter?: ZoneRouter | undefined;
  /** Optional callback invoked when a tool call is delegated to a remote zone. */
  readonly onDelegated?: (zoneId: string, request: ToolRequest) => void;
}

/** Subset of MiddlewareContext exposed to tenantIdResolver. */
export type TenantResolverContext = Parameters<NonNullable<KoiMiddleware["wrapToolCall"]>>[0];

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
  const {
    localZoneId,
    remoteTransports,
    remoteCapabilities,
    principalForwarding,
    tenantIdResolver,
    forwardedMetadataKeys,
    zoneRouter,
    onDelegated,
  } = config;

  // Fail-fast: principalForwarding="forward" requires (a) the remote to
  // advertise understandsPrincipalFields=true so the wire is compatible
  // with legacy receivers, AND (b) a tenantIdResolver so the forwarded
  // principal carries an explicit tenant claim. Without (b), forwarded
  // identity collapses tenant isolation: the remote authorizes against
  // agent/session/user IDs that may collide across tenants, and we
  // deliberately strip session.metadata (which often carries the only
  // tenant hint) for over-the-wire safety. Phase 3 baseline therefore
  // requires the operator to source tenant explicitly. Cryptographically
  // signed envelopes that carry tenant in a verifiable claim land in #1410.
  if (principalForwarding !== undefined) {
    for (const [zone, policy] of principalForwarding.entries()) {
      if (policy !== "forward") continue;
      const understands = remoteCapabilities?.get(zone)?.understandsPrincipalFields === true;
      if (!understands) {
        throw new Error(
          `createFederationMiddleware: principalForwarding["${zone}"] is "forward" but the remote has not advertised understandsPrincipalFields=true. Both must be set together so the wire payload is compatible with the remote receiver.`,
        );
      }
      if (tenantIdResolver === undefined) {
        throw new Error(
          `createFederationMiddleware: principalForwarding["${zone}"] is "forward" but no tenantIdResolver is configured. Forwarded principals must carry an explicit tenantId claim — without one, multi-tenant deployments lose tenant isolation across the federation boundary. Provide tenantIdResolver, or use principalForwarding="omit" until signed envelopes (#1410) land.`,
        );
      }
    }
  }

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
      const explicitTargetZoneId = ctx.metadata.targetZoneId;
      const routedTargetZoneId =
        typeof explicitTargetZoneId === "string"
          ? explicitTargetZoneId
          : zoneRouter?.selectZone({ toolId: request.toolId, input: request.input })?.zoneId;
      const targetZoneId = routedTargetZoneId;

      // No target zone or non-string → local execution
      if (targetZoneId === undefined) {
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

      // Local validation (tenant + metadata allowlist) runs BEFORE the
      // abort listener is registered. If validation throws, no remote
      // RPC is in flight, so a later abort must NOT fire sendCancel
      // for a callId the remote never saw — that could land on a
      // reused/aliased correlation tuple and cancel the wrong call.
      // The listener is also intentionally a no-op leak risk: setting
      // it up after validation ensures every early-exit path leaves
      // the AbortSignal untouched.
      // Identity-release is a LOCAL trust decision (not peer-advertised).
      // The principalForwarding map is operator-controlled — a peer
      // cannot opt itself into receiving identity by advertising
      // capability bits. The remote-advertised
      // `understandsPrincipalFields` capability only controls whether
      // the policy field appears on the wire (for legacy receivers).
      const principalPolicy: FederationPrincipalPolicy =
        principalForwarding?.get(targetZoneId) ?? "omit";
      const sendPrincipalFields =
        remoteCapabilities?.get(targetZoneId)?.understandsPrincipalFields === true ||
        principalPolicy === "forward";
      // Strict allowlist: forward ONLY the identity claims the remote
      // needs to re-evaluate authorization + audit. Do NOT forward
      // session.metadata or ctx.metadata wholesale — those are generic
      // JsonObjects and may carry trace context, tenant hints,
      // approval state, or credentials accidentally stashed in metadata.
      // Sending them across the federation boundary widens the trust
      // surface beyond what authorization actually requires.
      // tenantIdResolver presence is checked at construction time when
      // any zone is "forward"; here we additionally require the resolved
      // value to be a non-empty string per call. A missing/empty tenant
      // at call time means the operator's resolver cannot identify the
      // tenant for THIS request — fail closed rather than forward an
      // unscoped principal, which would let the remote authorize the
      // call under whichever tenant happens to own the agent/session id
      // on its side.
      let principal:
        | {
            agentId: string;
            sessionId: string;
            runId: string | undefined;
            conversationId: string | undefined;
            userId: string | undefined;
            channelId: string | undefined;
            turnId: string;
            turnIndex: number;
            tenantId: string;
          }
        | undefined;
      if (principalPolicy === "forward") {
        const tenantId = tenantIdResolver?.(ctx);
        if (typeof tenantId !== "string" || tenantId.length === 0) {
          throw new Error(
            `Federation principal forwarding aborted: tenantIdResolver returned no tenantId for tool=${request.toolId} → zone="${targetZoneId}". A forwarded principal must carry an explicit tenant claim; refusing to send an unscoped principal across the federation boundary.`,
          );
        }
        principal = {
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId,
          runId: ctx.session.runId,
          conversationId: ctx.session.conversationId,
          userId: ctx.session.userId,
          channelId: ctx.session.channelId,
          turnId: ctx.turnId,
          turnIndex: ctx.turnIndex,
          tenantId,
        };
      }

      // Filter request.metadata through the operator-supplied allowlist.
      // When metadata is present on the request, the operator MUST have
      // explicitly chosen a policy: cross-zone permission middleware
      // commonly keys on `request.metadata`, and silently dropping or
      // tunneling the bag desynchronizes authorization. Fail closed at
      // call time if the operator has not declared forwardedMetadataKeys.
      // (Empty `new Set()` is a valid explicit choice — drop everything.)
      let filteredMetadata: Record<string, unknown> | undefined;
      if (request.metadata !== undefined) {
        if (forwardedMetadataKeys === undefined) {
          throw new Error(
            `Federation routing aborted: tool=${request.toolId} → zone="${targetZoneId}" carries request.metadata but createFederationMiddleware was constructed without forwardedMetadataKeys. Permissions/policy middleware keys on metadata; configure an explicit allowlist (or pass new Set() if you have confirmed no remote policy depends on it) so cross-zone authorization sees the same inputs as local authorization.`,
          );
        }
        filteredMetadata = pickAllowedKeys(request.metadata, forwardedMetadataKeys);
      }

      // Register the abort listener BEFORE dispatching zone_execute so
      // an abort that fires between dispatch and listener-registration
      // cannot be lost. Validation has already run, so this point is
      // the earliest moment we are committed to a remote call.
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        if (signal === undefined) return; // never settles → harmless
        onAbort = () => {
          sendCancel();
          reject(newAbortError(targetZoneId, request.toolId, federationCallId, cancelSupported));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });

      const callPromise = remoteTransport.call<ToolResponse>("federation.zone_execute", {
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        toolId: request.toolId,
        input: request.input,
        callId: federationCallId,
        targetZoneId,
        originZoneId: localZoneId,
        ...(filteredMetadata !== undefined ? { metadata: filteredMetadata } : {}),
        ...(sendPrincipalFields ? { principalPolicy } : {}),
        ...(principal !== undefined ? { principal } : {}),
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
        // Validate the cross-zone response shape before handing it to
        // the local runtime. A skewed or buggy remote can return a
        // primitive, omit `output`, or send malformed `metadata`; we
        // must fail closed rather than turn schema drift into latent
        // runtime corruption.
        const validated = validateRemoteToolResponse(result.value);
        if (!validated.ok) {
          throw new Error(
            `Federation remote call returned malformed ToolResponse from zone "${targetZoneId}" (tool=${request.toolId}): ${validated.reason}`,
          );
        }
        return validated.value;
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

/**
 * Runtime validator for ToolResponse shapes returned across the
 * federation boundary. Phase 3 baseline contract: an object with a
 * defined `output` field; `metadata`, if present, must be a plain
 * object (no arrays, no primitives). Anything else is rejected so
 * the local runtime never observes a half-formed remote response.
 */
function validateRemoteToolResponse(
  value: unknown,
): { ok: true; value: ToolResponse } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `expected object, got ${value === null ? "null" : typeof value}` };
  }
  const obj = value as Record<string, unknown>;
  if (!("output" in obj)) {
    return { ok: false, reason: "missing required field 'output'" };
  }
  if (obj["output"] === undefined) {
    return { ok: false, reason: "field 'output' is undefined" };
  }
  if ("metadata" in obj && obj["metadata"] !== undefined) {
    const meta = obj["metadata"];
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
      return {
        ok: false,
        reason: `field 'metadata' must be a plain object, got ${
          meta === null ? "null" : Array.isArray(meta) ? "array" : typeof meta
        }`,
      };
    }
  }
  return { ok: true, value: obj as unknown as ToolResponse };
}

function pickAllowedKeys(
  source: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (allowed.size === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.hasOwn(source, key)) {
      out[key] = source[key];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
