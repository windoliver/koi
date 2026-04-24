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

  let server: ReturnType<typeof Bun.serve> | undefined;
  let resolvedPort: number = config.port;
  let frameCounter = 0;

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const idempotencyStore: IdempotencyStore =
    config.idempotencyStore ?? createIdempotencyStore(config.idempotency ?? {});

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

    const peer = request.headers.get("X-Webhook-Peer") ?? "webhook";

    const bodyResult = await parseJsonBody(request, maxBodyBytes);
    if (!bodyResult.ok) {
      return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.message });
    }
    const rawBody = bodyResult.raw;

    // Provider-level signature verification (when providerRouting is enabled).
    // Dedup key is extracted here but NOT committed until after dispatch succeeds.
    let pendingDedupKey: string | undefined;

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
      // Atomically reserve the dedup key — prevents concurrent duplicate dispatch.
      // tryBegin() is synchronous: no await between check and reservation, so
      // concurrent requests cannot both pass before either records.
      if (verifyResult.dedupKey !== undefined) {
        const beginResult = idempotencyStore.tryBegin(verifyResult.dedupKey);
        if (beginResult === "duplicate") {
          return jsonResponse(200, { ok: true, duplicate: true });
        }
        if (beginResult === "in-flight") {
          // Another request is processing this key. Return 503 so the provider
          // keeps retrying — do NOT return 200 here, as the original may still fail.
          return jsonResponse(503, {
            ok: false,
            error: "Delivery already in-flight, retry shortly",
          });
        }
        pendingDedupKey = verifyResult.dedupKey;
      }
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
      peer,
    };
    let metadata: Readonly<Record<string, unknown>> = {};

    // Pluggable authenticator (receives raw body for HMAC verification).
    // Runs AFTER provider signature check — can additionally authorize the
    // (provider, account) tuple to prevent cross-tenant injection.
    if (authenticator !== undefined) {
      const authResult = await authenticator(request, rawBody);
      if (!authResult.ok) {
        if (pendingDedupKey !== undefined) {
          idempotencyStore.abort(pendingDedupKey);
        }
        return jsonResponse(401, { ok: false, error: authResult.error.message });
      }
      agentId = authResult.value.agentId;
      routing = authResult.value.routing ?? routing;
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

    try {
      await Promise.resolve(dispatcher(session, frame));
    } catch (err: unknown) {
      // Abort dedup reservation so provider can retry and be accepted.
      if (pendingDedupKey !== undefined) {
        idempotencyStore.abort(pendingDedupKey);
      }
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { ok: false, error: `Dispatch failed: ${message}`, frameId });
    }

    // Commit dedup key only after full successful acceptance (auth + dispatch).
    // Provider retries after transient failures will not be silently dropped.
    if (pendingDedupKey !== undefined) {
      idempotencyStore.commit(pendingDedupKey);
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
