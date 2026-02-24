/**
 * Outbound webhook contract — L0 types for webhook delivery infrastructure.
 *
 * Defines the configuration, payload envelope, and delivery status types
 * for pushing HTTP POST notifications to registered webhook URLs.
 */

/**
 * Webhook event kinds — dot-separated discriminators for outbound notifications.
 */
export type WebhookEventKind =
  | "session.started"
  | "session.ended"
  | "tool.failed"
  | "tool.succeeded"
  | "budget.warning"
  | "budget.exhausted"
  | "security.violation";

/**
 * Outbound webhook registration — lives in AgentManifest.
 */
export interface OutboundWebhookConfig {
  /** Target URL for HTTP POST delivery. Must be HTTPS (HTTP allowed for localhost in dev). */
  readonly url: string;
  /** Event kinds that trigger delivery to this webhook. */
  readonly events: readonly WebhookEventKind[];
  /** HMAC-SHA256 signing key. Supports env-var substitution (e.g., "${WEBHOOK_SECRET}"). */
  readonly secret: string;
  /** Human-readable description of this webhook's purpose. */
  readonly description?: string | undefined;
  /** Whether this webhook is active. Default: true. */
  readonly enabled?: boolean | undefined;
}

/**
 * The payload envelope sent to webhook endpoints via HTTP POST.
 */
export interface WebhookPayload {
  /** Event kind discriminator. */
  readonly kind: WebhookEventKind;
  /** Unique delivery ID for idempotency (ULID). */
  readonly webhookId: string;
  /** Agent that generated this event. */
  readonly agentId: string;
  /** Unix millisecond timestamp when the event occurred. */
  readonly timestamp: number;
  /** Per-kind event payload. */
  readonly data: unknown;
}

/**
 * Result of a single webhook delivery attempt.
 */
export type WebhookDeliveryStatus =
  | {
      readonly ok: true;
      readonly statusCode: number;
      readonly latencyMs: number;
    }
  | {
      readonly ok: false;
      readonly statusCode?: number | undefined;
      readonly error: string;
      readonly latencyMs: number;
    };
