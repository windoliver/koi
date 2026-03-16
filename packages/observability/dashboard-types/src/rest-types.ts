/**
 * REST API response types for the dashboard.
 *
 * All responses use the ApiResult<T> envelope — a discriminated union
 * that separates success from error without throwing.
 */

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

/** Subsystem health status. */
export interface SubsystemStatus {
  readonly status: "ready" | "not_running" | "degraded";
  readonly url?: string | undefined;
  readonly latencyMs?: number | undefined;
}

/** Port binding status. */
export interface PortStatus {
  readonly port: number;
  readonly service: string;
  readonly status: "listening" | "closed";
}

/** Detailed status response with subsystem health. */
export interface DetailedStatusResponse {
  readonly status: string;
  readonly uptimeMs: number;
  readonly subsystems: {
    readonly admin: SubsystemStatus;
    readonly nexus: SubsystemStatus;
    readonly temporal: SubsystemStatus;
    readonly gateway: SubsystemStatus;
  };
  readonly ports: readonly PortStatus[];
}

/** Summary of a demo pack. */
export interface DemoPackSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly requires: readonly string[];
}
