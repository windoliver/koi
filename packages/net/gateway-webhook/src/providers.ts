/**
 * Built-in webhook provider definitions.
 *
 * A provider describes how to:
 * 1. Detect an inbound request (path segment or header)
 * 2. Verify its HMAC signature
 * 3. Extract a dedup key for idempotency
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
// Built-in providers
// ---------------------------------------------------------------------------

const githubProvider: WebhookProvider = {
  kind: "github",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifyGitHubSignature(secret, rawBody, request);
    const dedupKey = request.headers.get("x-github-delivery") ?? undefined;
    return { ok, dedupKey };
  },
};

const slackProvider: WebhookProvider = {
  kind: "slack",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifySlackSignature(secret, rawBody, request);
    return { ok };
  },
};

const stripeProvider: WebhookProvider = {
  kind: "stripe",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifyStripeSignature(secret, rawBody, request);
    const dedupKey = request.headers.get("idempotency-key") ?? undefined;
    return { ok, dedupKey };
  },
};

const genericProvider: WebhookProvider = {
  kind: "generic",
  async verify(secret, rawBody, request): Promise<ProviderVerifyResult> {
    const ok = await verifyGenericSignature(secret, rawBody, request);
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
