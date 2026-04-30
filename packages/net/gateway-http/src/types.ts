import type { AuditSink, KoiError, Result } from "@koi/core";
import type { Gateway, RoutingContext } from "@koi/gateway-types";

// --- Server config -----------------------------------------------------------

export interface GatewayHttpConfig {
  readonly bind: string;
  readonly maxBodyBytes: number;
  readonly maxInFlight: number;
  readonly replayWindowSeconds: number;
  readonly nonceLruSize: number;
  readonly maxTenantsPerChannel: number;
  readonly idempotencyTtlSeconds: number;
  readonly idempotencyLruSize: number;
  readonly cors: CorsConfig;
  readonly shutdownGraceMs: number;
  readonly proxyTrust: ProxyTrustConfig;
  readonly sourceLimit: RateLimitConfig | "disabled-acknowledged";
  readonly maxPendingUpgrades: number;
  readonly maxWsConnections: number;
  readonly wsHandshakeTimeoutMs: number;
  readonly wsIdleTimeoutSec: number;
  readonly lockFilePath: string;
}

export interface CorsConfig {
  readonly allowedOrigins: readonly string[];
  readonly allowedMethods: readonly string[];
  readonly allowedHeaders: readonly string[];
  readonly maxAgeSeconds: number;
}

export interface RateLimitConfig {
  readonly capacity: number;
  readonly refillPerSec: number;
}

export type ProxyTrustConfig =
  | { readonly mode: "none" }
  | { readonly mode: "trusted"; readonly trustedProxies: readonly string[] };

// --- Channel registration ----------------------------------------------------

export type ReplayProtectionMode = "nonce" | "timestamp-only";

export interface ChannelRegistration {
  readonly id: string;
  readonly secret: string;
  readonly replayProtection: ReplayProtectionMode;
  readonly rateLimit?: RateLimitConfig;
  readonly authenticate: ChannelAuthenticator;
  readonly resolveSession?: SessionResolver;
  readonly extractDeliveryId: (req: Request, payload: unknown) => string | undefined;
  readonly parseBody?: (rawBody: string, contentType: string | null) => Result<unknown, KoiError>;
}

export type ChannelAuthenticator = (
  req: Request,
  rawBody: string,
  payload: unknown,
  secret: string,
) => Promise<Result<AuthOutcome, KoiError>>;

export interface AuthOutcome {
  readonly agentId: string;
  /**
   * Verified tenant identifier. MUST be derived from signed body fields or
   * headers covered by the HMAC signature. NEVER use URL :account segments —
   * those are attacker-controlled within a valid signature.
   */
  readonly tenantId: string;
  readonly routing?: RoutingContext;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SessionResolver = (req: Request, outcome: AuthOutcome) => Promise<string | "create">;

// --- Server & deps -----------------------------------------------------------

export interface GatewayServer {
  readonly start: () => Promise<Result<void, KoiError>>;
  readonly stop: () => Promise<void>;
  readonly registerChannel: (reg: ChannelRegistration) => Result<void, KoiError>;
  readonly port: () => number;
}

export interface GatewayHttpDeps {
  readonly gateway: Gateway;
  readonly auditSink?: AuditSink;
  readonly clock?: () => number;
}

// --- Audit event -------------------------------------------------------------

export type AuthAuditResult =
  | "ok"
  | "rejected:auth"
  | "rejected:replay"
  | "rejected:overflow"
  | "rejected:rate-limit-source"
  | "rejected:rate-limit-tenant"
  | "rejected:invalid-body"
  | "rejected:ws-upgrade-cap"
  | "rejected:ws-connection-cap"
  | "rejected:ws-handshake-timeout"
  | "idempotent-replay"
  | "idempotent-in-flight"
  | "idempotency-disabled"
  | "rejected:not-found"
  | "rejected:draining"
  | "skipped";

// Re-exports for convenience (so consumers don't need to import multiple packages)
export type { AuditSink, KoiError, Result } from "@koi/core";
export type { Gateway, GatewayFrame, RoutingContext, Session } from "@koi/gateway-types";
