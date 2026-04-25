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
  /** Idempotency store options. Omit to use defaults (24h TTL, 5min processing TTL, 10k entries).
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
   * Hard cap on how long dispatch may hold a dedup reservation. After this many
   * milliseconds, the renewal loop stops and the reservation is aborted so
   * provider retries can be accepted. The dispatcher continues running but its
   * eventual `commit`/`abort` will be a token-mismatch no-op.
   *
   * Without this, a permanently-stuck dispatcher renews forever and permanently
   * blocks its delivery key. Recommended: set to 2-3× your p99 dispatch latency.
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

export type WebhookAuthenticator = (
  request: Request,
  rawBody: string,
) => Promise<Result<WebhookAuthResult, KoiError>>;

export interface WebhookAuthResult {
  readonly agentId: string;
  readonly routing?: RoutingContext | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
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

  const idempotencyStore: IdempotencyStore =
    config.idempotencyStore ?? createIdempotencyStore(config.idempotency ?? {});
  // Renewal interval must be shorter than the store's processing TTL.
  // When a custom store is injected, the caller must set leaseRenewalMs explicitly
  // to match their store's TTL; otherwise we fall back to the default-store default.
  const leaseRenewalMs =
    config.leaseRenewalMs ?? Math.floor((config.idempotency?.processingTtlMs ?? 5 * 60 * 1000) / 2);

  const prefix = config.pathPrefix.endsWith("/")
    ? config.pathPrefix.slice(0, -1)
    : config.pathPrefix;

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
      channel = seg0;
      account = seg1;
    } else {
      channel = seg0;
      account = seg1;
    }

    // X-Webhook-Peer is unsigned — trust it only when all routing risks are
    // explicitly accepted (allowUnauthenticated). On any authenticated path the
    // header is spoofable by any caller with a valid signed body; authenticators
    // may set routing.peer explicitly after validating the actual source.
    const peer =
      config.allowUnauthenticated === true
        ? (request.headers.get("X-Webhook-Peer") ?? undefined)
        : undefined;

    const bodyResult = await parseJsonBody(request, maxBodyBytes);
    if (!bodyResult.ok) {
      return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.message });
    }
    const rawBody = bodyResult.raw;

    // Provider-level signature verification (when providerRouting is enabled).
    // Dedup key is extracted here but NOT committed until after dispatch succeeds.
    // pendingToken is the reservation token returned by tryBegin(); required for
    // commit/abort so that stale requests cannot corrupt a newer reservation.
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
      const verifyResult = await provider.verify(secret, rawBody, request);
      if (!verifyResult.ok) {
        return jsonResponse(401, { ok: false, error: "Invalid signature" });
      }
      // Resolve dedup key: prefer provider-native ID (verified payload), fall back
      // to caller-supplied keyExtractor (enables GitHub/generic replay protection).
      let dedupKey = verifyResult.dedupKey;
      if (dedupKey === undefined && config.keyExtractor !== undefined) {
        dedupKey = await config.keyExtractor(provider.kind, request, rawBody);
      }
      // Scope the dedup key to the authenticated trust boundary — prevents
      // cross-tenant key collisions when different accounts share a common
      // provider-vended delivery ID (e.g. two tenants both send wh_abc123).
      // keyExtractor-supplied keys are the caller's responsibility to scope.
      if (dedupKey !== undefined && verifyResult.dedupKey !== undefined) {
        const accountScope = accountAuthenticated && account !== undefined ? `:${account}` : "";
        dedupKey = `${provider.kind}${accountScope}:${dedupKey}`;
      }
      // Atomically reserve the dedup key — prevents concurrent duplicate dispatch.
      // tryBegin() is synchronous: no await between check and reservation, so
      // concurrent requests cannot both pass before either records.
      if (dedupKey !== undefined) {
        const beginResult = idempotencyStore.tryBegin(dedupKey);
        if (beginResult.state !== "ok") {
          if (beginResult.state === "duplicate") {
            return jsonResponse(200, { ok: true, duplicate: true });
          }
          // in-flight or capacity-exceeded — retryable
          const error =
            beginResult.state === "in-flight"
              ? "Delivery already in-flight, retry shortly"
              : "Idempotency store at capacity, retry shortly";
          return jsonResponse(503, { ok: false, error });
        }
        pendingDedupKey = dedupKey;
        pendingToken = beginResult.token;
      }
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
    if (authenticator !== undefined) {
      let authResult: Awaited<ReturnType<WebhookAuthenticator>>;
      try {
        authResult = await authenticator(request, rawBody);
      } catch (err: unknown) {
        if (pendingDedupKey !== undefined && pendingToken !== undefined) {
          idempotencyStore.abort(pendingDedupKey, pendingToken);
          pendingDedupKey = undefined;
          pendingToken = undefined;
        }
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse(503, { ok: false, error: `Auth failed: ${message}` });
      }
      if (!authResult.ok) {
        if (pendingDedupKey !== undefined && pendingToken !== undefined) {
          idempotencyStore.abort(pendingDedupKey, pendingToken);
        }
        const status = authResult.error.retryable ? 503 : 401;
        return jsonResponse(status, { ok: false, error: authResult.error.message });
      }
      agentId = authResult.value.agentId;
      // Merge authenticator routing into the verified baseline — do not replace
      // wholesale. An authenticator that only wants to set peer or agentId must
      // not accidentally clear the already-verified channel or authenticated account.
      routing = { ...routing, ...(authResult.value.routing ?? {}) };
      metadata = authResult.value.metadata ?? metadata;
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
    // maxDispatchMs caps total renewal time: after that, the reservation is aborted
    // so stuck handlers cannot permanently block their delivery key. If the
    // dispatcher eventually completes after the timeout, we return 503 so the
    // provider retries — replay protection was already voided when the abort fired.
    let renewalTimer: ReturnType<typeof setInterval> | undefined;
    let maxDispatchTimer: ReturnType<typeof setTimeout> | undefined;
    let dispatchTimedOut = false;
    if (pendingDedupKey !== undefined && pendingToken !== undefined) {
      const key = pendingDedupKey;
      const token = pendingToken;
      renewalTimer = setInterval(() => {
        idempotencyStore.renew(key, token);
      }, leaseRenewalMs);
      if (config.maxDispatchMs !== undefined) {
        maxDispatchTimer = setTimeout(() => {
          dispatchTimedOut = true;
          // Stop renewing — lease will expire after processingTtlMs, at which point
          // provider retries are accepted. Do NOT abort here: aborting immediately
          // would open a window where the original handler and a provider retry both
          // run concurrently, producing duplicate side effects.
          clearInterval(renewalTimer);
        }, config.maxDispatchMs);
      }
    }

    try {
      await Promise.resolve(dispatcher(session, frame));
    } catch (err: unknown) {
      clearTimeout(maxDispatchTimer);
      clearInterval(renewalTimer);
      // Abort dedup reservation so provider can retry and be accepted.
      if (pendingDedupKey !== undefined && pendingToken !== undefined) {
        idempotencyStore.abort(pendingDedupKey, pendingToken);
      }
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { ok: false, error: `Dispatch failed: ${message}`, frameId });
    }
    clearTimeout(maxDispatchTimer);
    clearInterval(renewalTimer);

    // Timeout fired: stop renewing so the lease will expire on its own — provider
    // retries will be accepted once processingTtlMs elapses. Abort now that work
    // is done (no concurrent retry risk) and return 503 so the provider retries.
    if (dispatchTimedOut) {
      if (pendingDedupKey !== undefined && pendingToken !== undefined) {
        idempotencyStore.abort(pendingDedupKey, pendingToken);
      }
      return jsonResponse(503, {
        ok: false,
        error: "Dispatch exceeded maxDispatchMs — timed out, retry",
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
