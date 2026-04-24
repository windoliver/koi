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
  /** Idempotency store options. Omit to use defaults (24h TTL, 10k entries). */
  readonly idempotency?: {
    readonly ttlMs?: number | undefined;
    readonly maxSize?: number | undefined;
  };
}

export interface WebhookServer {
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly port: () => number;
}

export type WebhookDispatcher = (session: Session, frame: GatewayFrame) => void;

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
 * Per-provider signature config. Keys are provider kind strings.
 * Used when providerRouting is enabled.
 */
export type ProviderSecrets = Readonly<Partial<Record<ProviderKind, string>>>;

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
  const idempotencyStore: IdempotencyStore = createIdempotencyStore(config.idempotency ?? {});

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

    if (provider !== undefined) {
      const secret = providerSecrets !== undefined ? providerSecrets[provider.kind] : undefined;
      if (secret === undefined) {
        return jsonResponse(401, { ok: false, error: "No secret configured for provider" });
      }
      const verifyResult = await provider.verify(secret, rawBody, request);
      if (!verifyResult.ok) {
        return jsonResponse(401, { ok: false, error: "Invalid signature" });
      }
      // Check idempotency (read-only — do not commit yet)
      if (verifyResult.dedupKey !== undefined) {
        if (idempotencyStore.isDuplicate(verifyResult.dedupKey)) {
          return jsonResponse(200, { ok: true, duplicate: true });
        }
        pendingDedupKey = verifyResult.dedupKey;
      }
    }

    let agentId = "webhook";
    let routing: RoutingContext = {
      ...(channel !== undefined ? { channel } : {}),
      ...(account !== undefined ? { account } : {}),
      peer,
    };
    let metadata: Readonly<Record<string, unknown>> = {};

    // Pluggable authenticator (receives raw body for HMAC verification).
    // Runs AFTER provider signature check — can additionally authorize the
    // (provider, account) tuple to prevent cross-tenant injection.
    if (authenticator !== undefined) {
      const authResult = await authenticator(request, rawBody);
      if (!authResult.ok) {
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
      dispatcher(session, frame);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { ok: false, error: `Dispatch failed: ${message}`, frameId });
    }

    // Commit dedup key only after full successful acceptance (auth + dispatch).
    // Provider retries after transient failures will not be silently dropped.
    if (pendingDedupKey !== undefined) {
      idempotencyStore.record(pendingDedupKey);
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
