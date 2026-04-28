import type { KoiError, Result } from "@koi/core";

export interface NexusTransport {
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
  readonly close: () => void;
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
