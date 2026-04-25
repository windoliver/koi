/**
 * Built-in webhook provider definitions.
 *
 * A provider describes how to:
 * 1. Detect an inbound request (URL path segment)
 * 2. Verify its HMAC signature
 * 3. Extract a stable dedup key for idempotency
 *
 * Dedup keys are derived from provider-native delivery/event identifiers
 * embedded in the verified payload — not from HTTP headers that callers
 * may omit or forge. This ensures retries are correctly deduplicated.
 */

import {
  verifyGenericSignature,
  verifyGitHubSignature,
  verifySlackSignature,
  verifyStripeSignature,
} from "./signing.js";

export type ProviderKind = "github" | "slack" | "stripe" | "generic";

export interface ProviderVerifyResult {
  readonly ok: boolean;
  readonly dedupKey?: string | undefined;
}

export interface WebhookProvider {
  readonly kind: ProviderKind;
  readonly verify: (
    secret: string,
    rawBody: string,
    request: Request,
  ) => Promise<ProviderVerifyResult>;
}

// ---------------------------------------------------------------------------
// Payload dedup-key extraction helpers (only called on verified payloads)
// ---------------------------------------------------------------------------

function extractStripeEventId(rawBody: string): string | undefined {
  // Stripe webhook payload: { "id": "evt_xxx", "type": "...", ... }
  // Use event id as dedup key — stable across Stripe's automatic retries.
  try {
    const payload = JSON.parse(rawBody) as { id?: unknown };
    const id = payload.id;
    if (typeof id === "string" && id.length > 0) return `stripe:${id}`;
  } catch {
    // Non-JSON body — no dedup key
  }
  return undefined;
}

function extractSlackEventId(rawBody: string): string | undefined {
  // Slack Events API envelope: { "event_id": "Ev012345", "type": "event_callback", ... }
  // event_id is globally unique per delivery; use it for dedup.
  // Non-Events-API Slack webhooks (slash commands, interactive payloads) have no
  // stable envelope ID, so we return undefined and skip dedup for those shapes.
  try {
    const payload = JSON.parse(rawBody) as { event_id?: unknown };
    const id = payload.event_id;
    if (typeof id === "string" && id.length > 0) return `slack:${id}`;
  } catch {
    // Non-JSON body
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Built-in providers
// ---------------------------------------------------------------------------

const githubProvider: WebhookProvider = {
  kind: "github",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifyGitHubSignature(secret, rawBody, request);
    if (!ok) return { ok: false };
    // No dedup key: GitHub provides X-GitHub-Delivery but it is not covered by
    // the HMAC signature, so it cannot be trusted for idempotency. Content-based
    // keys (body hash/HMAC) conflate distinct deliveries with identical payloads,
    // causing silent event loss. Callers that need GitHub dedup should inject a
    // custom IdempotencyStore keyed on X-GitHub-Delivery after independent validation.
    return { ok };
  },
};

const slackProvider: WebhookProvider = {
  kind: "slack",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifySlackSignature(secret, rawBody, request);
    if (!ok) return { ok: false };
    // Events API: use event_id — a stable, provider-vended identifier present in
    // the verified payload. No dedup key for other Slack shapes (slash commands,
    // interactive payloads) because those have no stable signed event identifier;
    // using content-based keys would conflate distinct commands with equal bodies.
    const dedupKey = extractSlackEventId(rawBody);
    return { ok, dedupKey };
  },
};

const stripeProvider: WebhookProvider = {
  kind: "stripe",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifyStripeSignature(secret, rawBody, request);
    // Derive dedup from event.id in the verified payload.
    // The Stripe-Signature header's Idempotency-Key is for API requests, not webhooks.
    const dedupKey = ok ? extractStripeEventId(rawBody) : undefined;
    return { ok, dedupKey };
  },
};

const genericProvider: WebhookProvider = {
  kind: "generic",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifyGenericSignature(secret, rawBody, request);
    if (!ok) return { ok: false };
    // X-Webhook-ID is part of the signing string ("${id}.${ts}.${body}") and is
    // therefore verified by the HMAC. Use it directly as the dedup key.
    const dedupKey = request.headers.get("x-webhook-id") ?? undefined;
    return { ok, dedupKey };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PROVIDERS: ReadonlyMap<ProviderKind, WebhookProvider> = new Map([
  ["github", githubProvider],
  ["slack", slackProvider],
  ["stripe", stripeProvider],
  ["generic", genericProvider],
]);

export function getProvider(kind: ProviderKind): WebhookProvider {
  const provider = PROVIDERS.get(kind);
  if (provider === undefined) throw new Error(`Unknown provider: ${kind}`);
  return provider;
}

export function isKnownProvider(value: string): value is ProviderKind {
  return PROVIDERS.has(value as ProviderKind);
}

export { PROVIDERS as ALL_PROVIDERS };
