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
// Tenant-scoped HMAC dedup helper
// ---------------------------------------------------------------------------

async function hmacBodyKey(prefix: string, secret: string, rawBody: string): Promise<string> {
  // HMAC the body with the tenant's secret to produce a dedup key that is:
  //   1. Authenticated (tied to verified signing material, not unsigned headers)
  //   2. Tenant-scoped (different secrets → different keys, preventing cross-tenant
  //      dedup collisions when two tenants receive identical payloads)
  // Same body + same secret always maps to the same key, so retries dedup correctly.
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return `${prefix}:${Buffer.from(sig).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Built-in providers
// ---------------------------------------------------------------------------

const githubProvider: WebhookProvider = {
  kind: "github",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifyGitHubSignature(secret, rawBody, request);
    if (!ok) return { ok: false };
    // HMAC-body key: scoped by secret (tenant) + body, so same payload from two
    // different tenants produces different dedup keys (no cross-tenant suppression).
    // X-GitHub-Delivery is excluded — it is not covered by the request HMAC.
    const dedupKey = await hmacBodyKey("github", secret, rawBody);
    return { ok, dedupKey };
  },
};

const slackProvider: WebhookProvider = {
  kind: "slack",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifySlackSignature(secret, rawBody, request);
    if (!ok) return { ok: false };
    // For Events API: use the stable event_id so retries deduplicate by event.
    // For other Slack payloads (slash commands, interactive, etc.) event_id is
    // absent; fall back to a tenant-scoped HMAC key so signed retries still dedup.
    const dedupKey = extractSlackEventId(rawBody) ?? (await hmacBodyKey("slack", secret, rawBody));
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
    // Tenant-scoped HMAC key: X-Webhook-ID is not covered by the HMAC signature
    // and cannot be trusted. The HMAC key prevents cross-tenant dedup collisions.
    const dedupKey = await hmacBodyKey("generic", secret, rawBody);
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
