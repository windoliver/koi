import type { KoiError, Result } from "@koi/core";

/** Optional per-call options threaded through `transport.call(...)`. */
export interface NexusCallOptions {
  /** Override transport's default deadline for this single call (ms). */
  readonly deadlineMs?: number | undefined;
  /**
   * When true, transport MUST fail-fast on `auth_required` instead of
   * extending the deadline for OAuth. Set by health probes to prevent
   * startup stalls behind interactive auth. No-op for HTTP transport.
   */
  readonly nonInteractive?: boolean | undefined;
  /**
   * Caller-provided abort signal. HTTP: end-to-end abort.
   * local-bridge: TRANSPORT RESET — kills + respawns the bridge subprocess
   * and rejects every queued call with `code: "ABORTED"`.
   */
  readonly signal?: AbortSignal | undefined;
}

/** Transport kind discriminator. Public API. */
export type NexusTransportKind = "http" | "local-bridge" | "probe";

/** Default probe deadline used by health() (ms). */
export const HEALTH_DEADLINE_MS = 5_000;

/** Default probe paths for `health()` — the standard permission backend paths. */
export const DEFAULT_PROBE_PATHS: readonly string[] = [
  "koi/permissions/version.json",
  "koi/permissions/policy.json",
] as const;

/** Caller-supplied paths to probe + per-call deadline override. */
export interface NexusHealthOptions {
  /**
   * Read paths to probe. Defaults to {@link DEFAULT_PROBE_PATHS}. Pass `[]`
   * for a version-only probe. Runtimes using a custom `policyPath` MUST pass
   * their actual paths or the probe validates the wrong namespace.
   */
  readonly readPaths?: readonly string[] | undefined;
  /** Per-call deadline applied to version + each read probe. Default: {@link HEALTH_DEADLINE_MS}. */
  readonly probeDeadlineMs?: number | undefined;
}

/**
 * Transport health result. Discriminated union — callers that gate on
 * `status === "ok"` get correct fail-closed behavior by default.
 */
export type NexusHealth =
  | {
      readonly status: "ok";
      readonly version: string;
      readonly latencyMs: number;
      readonly probed: readonly string[];
    }
  | {
      readonly status: "version-only";
      readonly version: string;
      readonly latencyMs: number;
      readonly probed: readonly string[];
    }
  | {
      readonly status: "missing-paths";
      readonly version: string;
      readonly latencyMs: number;
      readonly probed: readonly string[];
      readonly notFound: readonly string[];
    };

/** Base transport — minimal surface, satisfied by tests/mocks/fixtures. */
export interface NexusTransport {
  /**
   * Optional on the base interface so test fixtures don't need stubs.
   * `assertProductionTransport(t)` THROWS at the production runtime
   * boundary if undefined — never defaults.
   */
  readonly kind?: NexusTransportKind | undefined;
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
    opts?: NexusCallOptions,
  ) => Promise<Result<T, KoiError>>;
  /** OPTIONAL on the base type. HealthCapableNexusTransport requires it. */
  readonly health?: (opts?: NexusHealthOptions) => Promise<Result<NexusHealth, KoiError>>;
  readonly close: () => void;
}

/**
 * Stronger contract — used ONLY for probe transports (HTTP long-lived
 * transport doubles as its own probe; local-bridge probe is disposable).
 */
export interface HealthCapableNexusTransport extends NexusTransport {
  readonly health: (opts?: NexusHealthOptions) => Promise<Result<NexusHealth, KoiError>>;
}

/** Minimal callable interface for the fetch function (injectable for testing). */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NexusTransportConfig {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly deadlineMs?: number | undefined;
  readonly retries?: number | undefined;
  readonly fetch?: FetchFn | undefined;
}

export interface JsonRpcResponse<T> {
  readonly result?: T;
  readonly error?: { readonly code: number; readonly message: string };
}
