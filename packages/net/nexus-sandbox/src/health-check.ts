/**
 * Health probing for the nexus sandbox subprocess.
 *
 * Polls GET <baseUrl>/health with exponential backoff until 200 or deadline.
 */

import type { KoiError, Result } from "@koi/core";
import { healthTimeoutError } from "./errors.js";
import type { FetchFn } from "./types.js";

const PROBE_TIMEOUT_MS = 1000;
const INITIAL_DELAY_MS = 50;
const BACKOFF_MULTIPLIER = 1.5;
const MAX_INTERVAL_MS = 1000;
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;

export async function probeHealth(
  baseUrl: string,
  fetchFn?: FetchFn | undefined,
): Promise<boolean> {
  const doFetch = fetchFn ?? globalThis.fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await doFetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

export async function pollHealth(
  baseUrl: string,
  fetchFn?: FetchFn | undefined,
  totalTimeoutMs?: number | undefined,
): Promise<Result<void, KoiError>> {
  const total = totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + total;
  let interval = INITIAL_DELAY_MS;
  while (Date.now() < deadline) {
    if (await probeHealth(baseUrl, fetchFn)) return { ok: true, value: undefined };
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(interval, remaining));
    interval = Math.min(interval * BACKOFF_MULTIPLIER, MAX_INTERVAL_MS);
  }
  return { ok: false, error: healthTimeoutError(baseUrl, total) };
}
