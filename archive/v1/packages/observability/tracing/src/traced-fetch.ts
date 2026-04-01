/**
 * Traced fetch wrapper — injects W3C traceparent/tracestate headers
 * from the active OTel context into outgoing HTTP requests.
 *
 * Zero-cost noop when no propagator is registered (the global
 * `propagation` returns a noop propagator by default).
 */

import { context, propagation } from "@opentelemetry/api";

/** Fetch function signature compatible with both Bun and standard fetch. */
type FetchFn = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Creates a fetch function that injects trace context headers
 * into every outgoing request.
 */
export function createTracedFetch(baseFetch: FetchFn = globalThis.fetch): FetchFn {
  return (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const carrier: Record<string, string> = {};

    // Copy existing headers into the carrier so they are preserved
    if (init?.headers !== undefined) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          carrier[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const entry of init.headers) {
          if (Array.isArray(entry) && entry.length >= 2) {
            carrier[String(entry[0])] = String(entry[1]);
          }
        }
      } else {
        Object.assign(carrier, init.headers);
      }
    }

    // Inject traceparent + tracestate into the carrier
    propagation.inject(context.active(), carrier);

    return baseFetch(input, { ...init, headers: carrier });
  };
}
