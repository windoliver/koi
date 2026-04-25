/**
 * Webhook ingestion — HTTP server that converts POST requests into
 * GatewayFrames dispatched through the gateway pipeline.
 *
 * Features:
 * - Built-in signature verification per provider (GitHub, Slack, Stripe, generic)
 * - Replay protection via idempotency keys (commit-after-success semantics)
 * - Streaming body parser with size enforcement (prevents OOM on large payloads)
 * - Path boundary safety (prevents "/webhook" matching "/webhookadmin")
 * - Explicit authentication requirement — unauthenticated operation requires
 *   setting `allowUnauthenticated: true` to prevent accidental open endpoints
 */

import type { KoiError, Result } from "@koi/core";
import type { GatewayFrame, RoutingContext, Session } from "@koi/gateway-types";
import { jsonResponse, matchPath, parseJsonBody } from "./http-helpers.js";
import { createIdempotencyStore, type IdempotencyStore } from "./idempotency.js";
import {
  getProvider,
  isKnownProvider,
  type ProviderKind,
  type WebhookProvider,
} from "./providers.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MB

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WebhookConfig {
  readonly port: number;
  readonly pathPrefix: string;
  /** Maximum request body bytes. Default: 1 MB. */
  readonly maxBodyBytes?: number | undefined;
  /**
   * When true, the URL path segment after the prefix is treated as the
   * provider kind (e.g. /webhook/github/acme → provider="github").
   * Unknown provider segments return HTTP 400. Default: false.
   */
  readonly providerRouting?: boolean | undefined;
  /**
   * Allow unauthenticated operation — every POST is accepted and dispatched
   * with attacker-controlled routing. Only set this in controlled/internal
   * environments. Production deployments must use providerRouting+secrets
   * or a WebhookAuthenticator instead.
   */
  readonly allowUnauthenticated?: boolean | undefined;
  /** Idempotency store options. Omit to use defaults (2h committed TTL, 5min processing TTL, 100k entries).
   *  Ignored when `idempotencyStore` is provided. */
  readonly idempotency?: {
    readonly ttlMs?: number | undefined;
    readonly processingTtlMs?: number | undefined;
    readonly maxSize?: number | undefined;
  };
  /**
   * Inject a custom IdempotencyStore (e.g. Redis-backed) for cross-process or
   * cross-replica replay protection. Without this, the default in-memory store
   * loses dedup state on restart and is not shared across replicas.
   */
  readonly idempotencyStore?: IdempotencyStore | undefined;
  /**
   * Interval for renewing the processing lease while dispatch is active.
   * Must be less than the `IdempotencyStore`'s processing TTL — typically half.
   *
   * **Required when using a custom `idempotencyStore`** whose processing TTL
   * differs from the default 5-minute value. Mismatching lease renewal to the
   * store's TTL can cause mid-dispatch expiry and duplicate dispatch.
   *
   * Default: `processingTtlMs / 2` from `config.idempotency` (or 150 000 ms).
   */
  readonly leaseRenewalMs?: number | undefined;
  /**
   * Maximum time in milliseconds to wait for the dispatcher to settle. If the
   * dispatcher does not complete within this window, the dedup reservation is
   * aborted and 503 is returned so the provider can retry with a fresh
   * reservation. The original dispatcher continues running in the background,
   * but its eventual commit is a no-op (token mismatch after abort).
   *
   * Set to 2-3× your p99 dispatch latency to cover slow-but-healthy dispatches
   * while bounding the duplicate execution window for hung dispatchers.
   *
   * Default: `processingTtlMs` (5 min). For custom `idempotencyStore`: `leaseRenewalMs × 2`.
   *
   * **Note:** this does not cancel the dispatcher. For true cancellation, wire an
   * `AbortSignal` into your dispatcher and abort it from a separate timer.
   */
  readonly maxDispatchMs?: number | undefined;
  /**
   * Extract a dedup key for providers that don't supply one natively (e.g. GitHub,
   * generic). Called after signature verification succeeds, with the verified
   * request and raw body. Return a string to enable replay protection for that
   * delivery, or undefined to skip dedup (pass-through, default behavior).
   *
   * **Required** when `providerRouting: true` and `providerSecrets` includes
   * `github` or `generic`, unless `allowReplayableProviders: true` is set.
   *
   * Example — deduplicate GitHub by X-GitHub-Delivery after independent validation:
   * ```ts
   * keyExtractor: (_provider, req) => req.headers.get("X-GitHub-Delivery") ?? undefined
   * ```
   */
  readonly keyExtractor?: (
    provider: ProviderKind | undefined,
    request: Request,
    rawBody: string,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Opt out of the startup guard that requires `keyExtractor` when GitHub or
   * generic providers are configured. Only set this if your dispatcher is fully
   * idempotent and can safely handle duplicate deliveries.
   */
  readonly allowReplayableProviders?: boolean | undefined;
}

export interface WebhookServer {
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly port: () => number;
}

export type WebhookDispatcher = (session: Session, frame: GatewayFrame) => Promise<void> | void;

/**
 * Authenticates an inbound webhook request after signature verification.
 *
 * **Security contract for multi-tenant routing:** if your deployment uses a
 * shared provider secret and routes by URL account (e.g. `/webhook/github/acme`),
 * `routing.account` in the result MUST be derived from independently authenticated
 * material — a verified JWT, session token, or per-account lookup — NOT simply
 * copied from the request URL. Echoing the URL account passes the account-binding
 * check but grants any valid provider-signed request access to any tenant's route,
 * defeating isolation. Use per-account secrets (`ProviderSecrets` with a Record
 * value) whenever possible, as they bind the URL account at the signature level.
 */
export type WebhookAuthenticator = (
  request: Request,
  rawBody: string,
) => Promise<Result<WebhookAuthResult, KoiError>>;

export interface WebhookAuthResult {
  readonly agentId: string;
  readonly routing?: RoutingContext | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Set to `true` only when `routing.account` was derived from independently
   * authenticated material — a JWT claim, a session token lookup, a signed
   * provider identifier, or similar — NOT copied from the request URL.
   *
   * Required for shared-secret + account-URL routes. Without this flag, the
   * server cannot distinguish an authenticated tenant claim from an authenticator
   * that merely echoes the unsigned URL segment, which would let any caller with
   * a valid shared secret route to any tenant's path.
   */
  readonly accountVerified?: boolean | undefined;
}

/**
 * Per-provider signature config. Each provider maps to either:
 *  - a single shared secret (string) — all accounts use the same secret
 *  - a per-account secret map (Record<string, string>) — binds the URL account
 *    segment to its own secret, preventing cross-tenant event injection when a
 *    URL like /webhook/github/acme is used (requests to unknown accounts → 401)
 *
 * Use per-account secrets in any multi-tenant deployment.
 */
export type ProviderSecretValue = string | Readonly<Record<string, string>>;
export type ProviderSecrets = Readonly<Partial<Record<ProviderKind, ProviderSecretValue>>>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebhookServer(
  config: WebhookConfig,
  dispatcher: WebhookDispatcher,
  authenticator?: WebhookAuthenticator,
  providerSecrets?: ProviderSecrets,
): WebhookServer {
  // Guard: require explicit authentication configuration or an opt-out flag.
  // This prevents accidentally exposing an open event injection endpoint.
  const hasProviderAuth =
    config.providerRouting === true &&
    providerSecrets !== undefined &&
    Object.keys(providerSecrets).length > 0;
  const hasAuthenticator = authenticator !== undefined;

  if (!hasProviderAuth && !hasAuthenticator && config.allowUnauthenticated !== true) {
    throw new Error(
      "createWebhookServer: no authentication configured. " +
        "Provide an authenticator, enable providerRouting with secrets, " +
        "or set allowUnauthenticated: true for internal/testing use only.",
    );
  }

  // Guard: GitHub has no built-in replay protection (no stable event ID in the
  // signed payload). The generic provider uses X-Webhook-ID which is part of
  // its HMAC signing string and therefore provides built-in replay protection.
  const hasGitHubProvider =
    config.providerRouting === true &&
    providerSecrets !== undefined &&
    providerSecrets.github !== undefined;
  if (
    hasGitHubProvider &&
    config.keyExtractor === undefined &&
    config.allowReplayableProviders !== true
  ) {
    throw new Error(
      "createWebhookServer: GitHub provider has no built-in replay " +
        "protection. Provide a keyExtractor to supply a verified dedup key per " +
        "delivery (e.g. req.headers.get('X-GitHub-Delivery')), or set " +
        "allowReplayableProviders: true if your dispatcher is fully idempotent.",
    );
  }

  // Guard: Slack slash-commands and interactive payloads have no stable event ID
  // in the signed payload (only Events API deliveries include event_id). Callers
  // that route Slack must either supply a keyExtractor that covers all Slack shapes
  // they expect, or set allowReplayableProviders: true to acknowledge replay risk
  // for non-Events-API requests.
  const hasSlackProvider =
    config.providerRouting === true &&
    providerSecrets !== undefined &&
    providerSecrets.slack !== undefined;
  if (
    hasSlackProvider &&
    config.keyExtractor === undefined &&
    config.allowReplayableProviders !== true
  ) {
    throw new Error(
      "createWebhookServer: Slack provider requires explicit replay protection configuration. " +
        "Slack slash-commands and interactive payloads do not include a stable event_id, " +
        "so they produce no dedup key. Provide a keyExtractor to handle those shapes, or " +
        "set allowReplayableProviders: true if your dispatcher is fully idempotent.",
    );
  }

  let server: ReturnType<typeof Bun.serve> | undefined;
  let resolvedPort: number = config.port;
  let frameCounter = 0;

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (config.idempotencyStore !== undefined && config.leaseRenewalMs === undefined) {
    throw new Error(
      "createWebhookServer: leaseRenewalMs is required when a custom idempotencyStore is provided. " +
        "Set leaseRenewalMs to less than half your store's processing TTL so the renewal " +
        "interval fires before the lease expires.",
    );
  }
  if (config.leaseRenewalMs !== undefined && config.leaseRenewalMs <= 0) {
    throw new Error(
      "createWebhookServer: leaseRenewalMs must be a positive integer. " +
        "Set it to less than half your store's processing TTL.",
    );
  }
  // When using the built-in store, enforce that leaseRenewalMs is shorter than
  // processingTtlMs. If leaseRenewalMs >= processingTtlMs, the renewal fires only
  // after the reservation has already expired, creating a duplicate-dispatch window.
  if (config.idempotencyStore === undefined && config.leaseRenewalMs !== undefined) {
    const processingTtlMs = config.idempotency?.processingTtlMs ?? 5 * 60 * 1000; // default matches idempotency.ts
    if (config.leaseRenewalMs >= processingTtlMs) {
      throw new Error(
        `createWebhookServer: leaseRenewalMs (${config.leaseRenewalMs}ms) must be less than ` +
          `the built-in store's processingTtlMs (${processingTtlMs}ms). ` +
          "A renewal interval equal to or longer than the processing TTL means the first " +
          "renewal fires after the lease has already expired.",
      );
    }
  }

  const idempotencyStore: IdempotencyStore =
    config.idempotencyStore ?? createIdempotencyStore(config.idempotency ?? {});
  // Renewal interval must be shorter than the store's processing TTL.
  // When a custom store is injected, the caller must set leaseRenewalMs explicitly
  // to match their store's TTL; otherwise we fall back to the default-store default.
  const leaseRenewalMs =
    config.leaseRenewalMs ?? Math.floor((config.idempotency?.processingTtlMs ?? 5 * 60 * 1000) / 2);
  // Default maxDispatchMs so hung dispatchers eventually stop renewing. For the
  // built-in store, use processingTtlMs directly. For a custom store, use leaseRenewalMs
  // × 2 as a proportional proxy — callers must declare leaseRenewalMs for custom stores,
  // so it reliably tracks the store's actual TTL without requiring a separate config field.
  const effectiveMaxDispatchMs =
    config.maxDispatchMs ??
    (config.idempotencyStore !== undefined
      ? leaseRenewalMs * 2
      : (config.idempotency?.processingTtlMs ?? 5 * 60 * 1000));

  const prefix = config.pathPrefix.endsWith("/")
    ? config.pathPrefix.slice(0, -1)
    : config.pathPrefix;
  if (prefix === "") {
    throw new Error(
      "createWebhookServer: pathPrefix cannot be '/' or empty. " +
        "Use a specific path like '/webhook' to avoid matching every POST route.",
    );
  }

  function nextFrameId(): string {
    return `wh-${Date.now().toString(36)}-${(frameCounter++).toString(36)}`;
  }

  async function handleRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse(405, { ok: false, error: "Method not allowed" });
    }

    const url = new URL(request.url);
    const pathResult = matchPath(url.pathname, prefix);
    if (!pathResult.match) {
      return jsonResponse(404, { ok: false, error: "Not found" });
    }

    const [seg0, seg1] = pathResult.segments;

    // Provider routing: first segment is the provider kind
    let provider: WebhookProvider | undefined;
    let channel: string | undefined;
    let account: string | undefined;

    if (config.providerRouting === true) {
      if (seg0 === undefined || !isKnownProvider(seg0)) {
        return jsonResponse(400, { ok: false, error: "Unknown webhook provider" });
      }
      provider = getProvider(seg0);
      channel = seg0; // provider kind is verified by signature — trusted
      account = seg1;
    } else {
      // URL-derived channel is unsigned on non-provider routes. Trust it only
      // when routing risks are explicitly accepted (allowUnauthenticated). On
      // authenticated routes the authenticator must bind channel via routing.
      channel = config.allowUnauthenticated === true ? seg0 : undefined;
      account = seg1;
    }

    // X-Webhook-Peer is a trivially spoofable header — never trust it when an
    // authenticator is configured. The authenticator has the verified request
    // context and may set routing.peer after independently validating the source.
    // Only trust it on fully unauthenticated paths where all routing risks are
    // explicitly accepted.
    const peer =
      config.allowUnauthenticated === true && authenticator === undefined
        ? (request.headers.get("X-Webhook-Peer") ?? undefined)
        : undefined;

    const bodyResult = await parseJsonBody(request, maxBodyBytes);
    if (!bodyResult.ok) {
      return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.message });
    }
    const rawBody = bodyResult.raw;

    // Provider-level signature verification (when providerRouting is enabled).
    // rawDedupKey is extracted here but reservation is deferred until the
    // authenticated account is known, so the scoped key reflects the verified tenant.
    // pendingToken is the reservation token returned by tryBegin() after auth.
    let rawDedupKey: string | undefined;
    let pendingDedupKey: string | undefined;
    let pendingToken: string | undefined;

    // accountAuthenticated is true only when a per-account secret map was used.
    // A shared string secret authenticates the provider secret but NOT the URL
    // account segment, which is unsigned. Routing.account is only populated from
    // the URL when the account was explicitly authenticated via secret lookup.
    let accountAuthenticated = false;

    if (provider !== undefined) {
      const secretValue =
        providerSecrets !== undefined ? providerSecrets[provider.kind] : undefined;
      let secret: string | undefined;
      if (typeof secretValue === "string") {
        secret = secretValue;
      } else if (secretValue !== undefined) {
        // Per-account secret map — reject requests to unrecognized accounts and
        // mark the account as authenticated (it was proven via the secret lookup).
        secret = account !== undefined ? secretValue[account] : undefined;
        accountAuthenticated = secret !== undefined;
      }
      if (secret === undefined) {
        return jsonResponse(401, { ok: false, error: "No secret configured for provider" });
      }
      const verifyResult = await provider.verify(secret, rawBody, request, bodyResult.rawBytes);
      if (!verifyResult.ok) {
        return jsonResponse(401, { ok: false, error: "Invalid signature" });
      }
      // Resolve dedup key: prefer provider-native ID (verified payload), fall back
      // to caller-supplied keyExtractor (enables GitHub/generic replay protection).
      rawDedupKey = verifyResult.dedupKey;
      if (rawDedupKey === undefined && config.keyExtractor !== undefined) {
        rawDedupKey = await config.keyExtractor(provider.kind, request, rawBody);
      }
      // Fail-closed: if the provider verified the request but cannot produce a
      // replay-safe key — including when keyExtractor is configured but returns
      // undefined for a specific request (e.g. missing X-GitHub-Delivery) — reject
      // unless the caller has opted in. A configured keyExtractor that returns
      // undefined is not a pass; it means this delivery has no provable identity.
      if (rawDedupKey === undefined && !config.allowReplayableProviders) {
        return jsonResponse(400, {
          ok: false,
          error:
            `Provider '${provider.kind}' verified the request but produced no replay-safe key. ` +
            "Set allowReplayableProviders: true if your dispatcher is fully idempotent, " +
            "or provide a keyExtractor to derive a stable key for this request shape.",
        });
      }
      // Reservation is deferred to after auth so the scoped key uses the verified
      // routing.account instead of the unsigned URL account. This prevents two
      // different tenants sharing the same provider-native event ID from colliding
      // in the dedup namespace and silently dropping each other's events.
    }

    // Account-scope rejection: a shared provider secret proves body integrity but
    // not which tenant the URL account segment belongs to. Without a per-account
    // secret map (accountAuthenticated) or an authenticator that can bind the account,
    // accepting the request would silently misroute events in multi-tenant deployments.
    if (
      provider !== undefined &&
      account !== undefined &&
      !accountAuthenticated &&
      authenticator === undefined &&
      config.allowUnauthenticated !== true
    ) {
      if (pendingDedupKey !== undefined && pendingToken !== undefined) {
        idempotencyStore.abort(pendingDedupKey, pendingToken);
      }
      return jsonResponse(401, {
        ok: false,
        error: "Account path requires per-account secret map or authenticator",
      });
    }

    let agentId = "webhook";
    let routing: RoutingContext = {
      ...(channel !== undefined ? { channel } : {}),
      // Only include the URL account segment when it was authenticated. A shared
      // provider secret proves the body integrity but NOT the URL account path.
      // An authenticator can still set routing.account explicitly in its return value.
      // allowUnauthenticated signals the caller accepted all routing risks.
      ...(account !== undefined && (accountAuthenticated || config.allowUnauthenticated === true)
        ? { account }
        : {}),
      ...(peer !== undefined ? { peer } : {}),
    };
    let metadata: Readonly<Record<string, unknown>> = {};

    // Pluggable authenticator (receives raw body for HMAC verification).
    // Runs AFTER provider signature check — can additionally authorize the
    // (provider, account) tuple to prevent cross-tenant injection.
    // No dedup reservation exists yet — it is deferred until after auth so the
    // final authenticated routing.account is used for scoping (see below).
    if (authenticator !== undefined) {
      let authResult: Awaited<ReturnType<WebhookAuthenticator>>;
      try {
        authResult = await authenticator(request, rawBody);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse(503, { ok: false, error: `Auth failed: ${message}` });
      }
      if (!authResult.ok) {
        const status = authResult.error.retryable ? 503 : 401;
        return jsonResponse(status, { ok: false, error: authResult.error.message });
      }
      agentId = authResult.value.agentId;
      // Merge authenticator routing into the verified baseline. Provider-authenticated
      // channel (provider kind) and account are immutable after signature verification.
      // Re-apply both after the merge to prevent authenticator bugs or misconfiguration
      // from rerouting signed traffic across provider or tenant boundaries.
      const authRouting = authResult.value.routing ?? {};
      routing = {
        ...routing,
        ...authRouting,
        // Re-apply provider-authenticated channel — verified by signature, immutable.
        ...(provider !== undefined && channel !== undefined ? { channel } : {}),
        // Re-apply provider-authenticated account — signature-verified, immutable.
        ...(accountAuthenticated && account !== undefined ? { account } : {}),
      };
      metadata = authResult.value.metadata ?? metadata;

      // Account binding enforcement: if the URL has an account path that was NOT
      // authenticated by the provider secret (shared secret), require the
      // authenticator to have (a) set routing.account === URL account AND (b)
      // set accountVerified: true, proving the account came from independently
      // authenticated material rather than being copied from the unsigned URL.
      // Without (b), any caller with a valid shared secret could route to any
      // tenant by echoing the URL account in their authenticator.
      // Account binding is always enforced when an authenticator is present —
      // allowUnauthenticated does not bypass this check. The authenticator has the
      // context to verify accounts; skipping enforcement here would let any caller
      // with a valid shared secret route to arbitrary tenants.
      if (provider !== undefined && account !== undefined && !accountAuthenticated) {
        const accountMismatch = routing.account !== account;
        const accountUnverified = authResult.value.accountVerified !== true;
        if (accountMismatch || accountUnverified) {
          const reason = accountMismatch
            ? "Authenticator did not bind the URL account"
            : "Authenticator must set accountVerified: true for shared-secret account routes";
          return jsonResponse(401, { ok: false, error: `${reason} — route rejected` });
        }
      }
    }

    // Dedup reservation: scope the key with the final authenticated routing.account
    // (set by per-account secret map or authenticator) rather than the unsigned URL
    // account. This prevents two different tenants sharing the same provider-native
    // event ID from colliding in the dedup namespace and silently dropping events.
    // tryBegin() is synchronous — no await between check and reservation, so
    // concurrent requests cannot both pass before either records.
    if (rawDedupKey !== undefined && provider !== undefined) {
      const finalAccount = routing.account;
      const accountPart = finalAccount !== undefined ? `:${finalAccount}` : "";
      const dedupKey = `${provider.kind}${accountPart}:${rawDedupKey}`;
      const beginResult = idempotencyStore.tryBegin(dedupKey);
      if (beginResult.state !== "ok") {
        if (beginResult.state === "duplicate") {
          return jsonResponse(200, { ok: true, duplicate: true });
        }
        const error =
          beginResult.state === "in-flight"
            ? "Delivery already in-flight, retry shortly"
            : "Idempotency store at capacity, retry shortly";
        return jsonResponse(503, { ok: false, error });
      }
      pendingDedupKey = dedupKey;
      pendingToken = beginResult.token;
    }

    const frameId = nextFrameId();

    const session: Session = {
      id: `webhook-${frameId}`,
      agentId,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      seq: 0,
      remoteSeq: 0,
      metadata,
      routing,
    };

    const frame: GatewayFrame = {
      kind: "event",
      id: frameId,
      seq: 0,
      timestamp: Date.now(),
      payload: bodyResult.parsed,
    };

    // Renew the processing lease periodically while dispatch is active so a
    // slow-but-healthy dispatcher does not lose its reservation to a provider retry.
    // Race the dispatch against effectiveMaxDispatchMs: if the dispatch wins (normal
    // path), we commit and return 200. If the timeout wins, we abort the reservation
    // and return 503 so the provider retries with a fresh reservation. This prevents
    // the lease from quietly expiring while the handler is still running, which would
    // reopen the key for concurrent duplicate execution.
    let leaseLost = false;
    let renewalTimer: ReturnType<typeof setInterval> | undefined;
    if (pendingDedupKey !== undefined && pendingToken !== undefined) {
      const key = pendingDedupKey;
      const token = pendingToken;
      // Capture the timer ref directly so the callback can clear itself without
      // risking a race on the outer `renewalTimer` variable (which is assigned
      // after setInterval returns — the callback cannot fire before that point,
      // but capturing directly is cleaner and avoids the undefined window).
      const timer = setInterval(() => {
        if (!idempotencyStore.renew(key, token)) {
          // Lease was lost — TTL expired or another replica took over.
          // Stop renewal and flag so the post-dispatch path returns 503 instead
          // of 200: a stale commit is a no-op, so returning 200 here would mean
          // the provider believes the delivery was committed when it was not.
          clearInterval(timer);
          leaseLost = true;
        }
      }, leaseRenewalMs);
      renewalTimer = timer;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), effectiveMaxDispatchMs);
    });

    let dispatchError: unknown;
    const dispatchPromise = (async (): Promise<"ok" | "error"> => {
      try {
        await Promise.resolve(dispatcher(session, frame));
        return "ok";
      } catch (err: unknown) {
        dispatchError = err;
        return "error";
      }
    })();

    const result = await Promise.race([dispatchPromise, timeoutPromise]);
    clearTimeout(timeoutHandle);
    clearInterval(renewalTimer);

    if (result === "timeout") {
      // Abort the reservation so provider retries are immediately accepted.
      // The original dispatcher may still be running in the background, but its
      // eventual commit will be a no-op (token mismatch after abort).
      if (pendingDedupKey !== undefined && pendingToken !== undefined) {
        idempotencyStore.abort(pendingDedupKey, pendingToken);
      }
      return jsonResponse(503, { ok: false, error: "Dispatch timeout — retry shortly", frameId });
    }

    if (result === "error") {
      // Abort dedup reservation so provider can retry and be accepted.
      if (pendingDedupKey !== undefined && pendingToken !== undefined) {
        idempotencyStore.abort(pendingDedupKey, pendingToken);
      }
      const message =
        dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
      return jsonResponse(500, { ok: false, error: `Dispatch failed: ${message}`, frameId });
    }

    if (leaseLost) {
      // Lease expired during dispatch — commit is a stale no-op, so returning 200
      // would leave the provider without a committed dedup record. Return 503 so
      // it retries; the next delivery wins a fresh reservation.
      if (pendingDedupKey !== undefined && pendingToken !== undefined) {
        idempotencyStore.abort(pendingDedupKey, pendingToken);
      }
      return jsonResponse(503, {
        ok: false,
        error: "Dispatch lease expired — retry shortly",
        frameId,
      });
    }

    // Commit dedup key only after full successful acceptance (auth + dispatch).
    // Provider retries after transient failures will not be silently dropped.
    if (pendingDedupKey !== undefined && pendingToken !== undefined) {
      idempotencyStore.commit(pendingDedupKey, pendingToken);
    }

    return jsonResponse(200, { ok: true, frameId });
  }

  return {
    async start(): Promise<void> {
      server = Bun.serve({
        port: config.port,
        fetch: handleRequest,
      });
      resolvedPort = server.port ?? config.port;
    },

    stop(): void {
      server?.stop(true);
      server = undefined;
    },

    port(): number {
      return resolvedPort;
    },
  };
}
