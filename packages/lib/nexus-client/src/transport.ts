import type { KoiError, Result } from "@koi/core";
import { mapNexusError } from "./errors.js";
import { extractReadContent } from "./extract-read-content.js";
import {
  DEFAULT_PROBE_PATHS,
  type FetchFn,
  HEALTH_DEADLINE_MS,
  type HealthCapableNexusTransport,
  type JsonRpcResponse,
  type NexusCallOptions,
  type NexusHealth,
  type NexusHealthOptions,
  type NexusTransportConfig,
} from "./types.js";

const DEFAULT_DEADLINE_MS = 45_000;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

const RETRYABLE_METHODS: ReadonlySet<string> = new Set([
  "read",
  "list",
  "grep",
  "search",
  "stat",
  "exists",
  "glob",
  "is_directory",
  "permissions.check",
  "permissions.checkBatch",
  "revocations.check",
  "revocations.checkBatch",
  "version",
]);

export function createHttpTransport(config: NexusTransportConfig): HealthCapableNexusTransport {
  const defaultDeadlineMs = config.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxRetries = config.retries ?? DEFAULT_RETRIES;
  const fetchFn: FetchFn = config.fetch ?? globalThis.fetch;
  const abortController = new AbortController();
  // let justified: monotonic counter for JSON-RPC request IDs
  let nextId = 1;

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
    opts?: NexusCallOptions,
  ): Promise<Result<T, KoiError>> {
    const callDeadlineMs = opts?.deadlineMs ?? defaultDeadlineMs;
    const deadline = Date.now() + callDeadlineMs;
    const effectiveRetries = RETRYABLE_METHODS.has(method) ? maxRetries : 0;
    let lastError: KoiError | undefined;

    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          ok: false,
          error: lastError ?? mapNexusError(new Error("deadline exceeded"), method),
        };
      }

      if (attempt > 0) {
        const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
        const jitter = Math.random() * backoff * 0.2;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(backoff + jitter, remaining)),
        );
      }

      try {
        const id = nextId++;
        const timeoutSignal = AbortSignal.timeout(Math.min(remaining, callDeadlineMs));
        const signals: AbortSignal[] = [abortController.signal, timeoutSignal];
        if (opts?.signal !== undefined) signals.push(opts.signal);
        const signal = AbortSignal.any(signals);

        const response = await fetchFn(`${config.url}/api/nfs/${encodeURIComponent(method)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey !== undefined ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
          signal,
        });

        if (!response.ok) {
          const error = mapNexusError(
            { status: response.status, statusText: response.statusText },
            method,
          );
          if (!error.retryable || attempt >= maxRetries) return { ok: false, error };
          lastError = error;
          continue;
        }

        const body = (await response.json()) as JsonRpcResponse<T>;
        if (body.error !== undefined) {
          const error = mapNexusError(body.error, method);
          if (!error.retryable || attempt >= maxRetries) return { ok: false, error };
          lastError = error;
          continue;
        }

        return { ok: true, value: body.result as T };
      } catch (e: unknown) {
        const error = mapNexusError(e, method);
        if (!error.retryable || attempt >= maxRetries) return { ok: false, error };
        lastError = error;
      }
    }

    return { ok: false, error: lastError ?? mapNexusError(new Error("exhausted retries"), method) };
  }

  async function health(opts?: NexusHealthOptions): Promise<Result<NexusHealth, KoiError>> {
    const probeDeadlineMs = opts?.probeDeadlineMs ?? HEALTH_DEADLINE_MS;
    const readPaths = opts?.readPaths ?? DEFAULT_PROBE_PATHS;
    const callOpts: NexusCallOptions = { deadlineMs: probeDeadlineMs, nonInteractive: true };
    const start = performance.now();

    const versionResult = await call<unknown>("version", {}, callOpts);
    if (!versionResult.ok) return { ok: false, error: versionResult.error };
    const version =
      typeof versionResult.value === "string"
        ? versionResult.value
        : typeof versionResult.value === "object" && versionResult.value !== null
          ? JSON.stringify(versionResult.value)
          : String(versionResult.value);

    if (readPaths.length === 0) {
      return {
        ok: true,
        value: {
          status: "version-only",
          version,
          latencyMs: Math.round(performance.now() - start),
          probed: ["version"],
        },
      };
    }

    const probed: string[] = ["version"];
    const notFound: string[] = [];
    for (const path of readPaths) {
      const r = await call<unknown>("read", { path }, callOpts);
      if (!r.ok) {
        if (r.error.code === "NOT_FOUND") {
          notFound.push(path);
          probed.push(`read:${path}`);
          continue;
        }
        return { ok: false, error: r.error };
      }
      const extracted = extractReadContent(r.value);
      if (!extracted.ok) return { ok: false, error: extracted.error };
      probed.push(`read:${path}`);
    }

    const latencyMs = Math.round(performance.now() - start);
    if (notFound.length > 0) {
      return {
        ok: true,
        value: { status: "missing-paths", version, latencyMs, probed, notFound },
      };
    }
    return { ok: true, value: { status: "ok", version, latencyMs, probed } };
  }

  function close(): void {
    abortController.abort();
  }

  return { kind: "http", call, health, close };
}
