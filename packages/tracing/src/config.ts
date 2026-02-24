/**
 * Tracing middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { Tracer } from "@opentelemetry/api";

export interface TracingConfig {
  /** OTel service name. Default: "@koi/agent". Ignored when `tracer` is provided. */
  readonly serviceName?: string;
  /** When true, attach request/response content as span attributes. Default: false. */
  readonly captureContent?: boolean;
  /** Optional filter applied to content before attaching. Only used when captureContent is true. */
  readonly contentFilter?: (data: unknown) => unknown;
  /** Bring your own OTel Tracer instance. Overrides serviceName. */
  readonly tracer?: Tracer;
  /** Extra root-level attributes added to every span. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** Called when tracing itself errors. Tracing errors never propagate to the application. */
  readonly onError?: (error: unknown) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function validateConfig(config: unknown): Result<TracingConfig, KoiError> {
  if (!isRecord(config)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "TracingConfig must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (config.serviceName !== undefined && typeof config.serviceName !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "serviceName must be a string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (config.captureContent !== undefined && typeof config.captureContent !== "boolean") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "captureContent must be a boolean",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Safe narrowing: all validated fields are checked above, remaining optional
  // fields (tracer, contentFilter, attributes, onError) are typed via the
  // TracingConfig interface and validated by the TypeScript compiler at call sites.
  return { ok: true, value: config as TracingConfig };
}
