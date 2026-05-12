/**
 * Shared test helpers for registry-nexus.
 *
 * Provides a programmable mock NexusTransport that records calls and lets
 * tests stub out responses by method name.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface RecordedCall {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type StubHandler = (
  params: Readonly<Record<string, unknown>>,
) => Result<unknown, KoiError> | Promise<Result<unknown, KoiError>>;

export interface MockTransport extends NexusTransport {
  readonly calls: readonly RecordedCall[];
  readonly stub: (method: string, handler: StubHandler) => void;
}

export function createMockTransport(): MockTransport {
  const calls: RecordedCall[] = [];
  const stubs = new Map<string, StubHandler>();

  return {
    get calls() {
      return calls;
    },
    stub(method, handler) {
      stubs.set(method, handler);
    },
    call: async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      calls.push({ method, params });
      const handler = stubs.get(method);
      if (handler === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No stub for method ${method}`,
            retryable: false,
          },
        };
      }
      const result = await handler(params);
      return result as Result<T, KoiError>;
    },
    close: () => {},
  };
}
