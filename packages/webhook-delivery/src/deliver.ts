/**
 * HTTP webhook delivery — single POST with timeout and diagnostics.
 */

import type { WebhookDeliveryStatus } from "@koi/core";

export interface DeliverOptions {
  /** HTTP request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Maximum response body bytes to read for error diagnostics. */
  readonly maxResponseBodyBytes: number;
}

/**
 * Delivers a webhook payload via HTTP POST.
 *
 * @param url - Target webhook URL
 * @param body - Pre-serialized JSON string (Decision #16: serialize once)
 * @param headers - Signature headers + content-type
 * @param options - Timeout and body limit config
 * @param fetcher - Injectable fetch function for testing (Decision #9: DI via config)
 */
export async function deliverWebhook(
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  options: DeliverOptions,
  fetcher: typeof fetch = fetch,
): Promise<WebhookDeliveryStatus> {
  const start = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { ...headers },
      body,
      signal: controller.signal,
      redirect: "error",
    });

    const latencyMs = Math.round(performance.now() - start);

    if (response.status >= 200 && response.status < 300) {
      // Drain body to free resources
      await response.arrayBuffer().catch(() => {});
      return { ok: true, statusCode: response.status, latencyMs };
    }

    // Read limited response body for error diagnostics
    let errorDetail = `HTTP ${response.status}`;
    try {
      const bodyBytes = await response.arrayBuffer();
      const limited = bodyBytes.slice(0, options.maxResponseBodyBytes);
      const text = new TextDecoder().decode(limited);
      if (text.length > 0) {
        errorDetail = `HTTP ${response.status}: ${text}`;
      }
    } catch {
      // Ignore body read failures
    }

    return { ok: false, statusCode: response.status, error: errorDetail, latencyMs };
  } catch (error: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    const message =
      error instanceof DOMException && error.name === "AbortError"
        ? `Timeout after ${options.timeoutMs}ms`
        : error instanceof TypeError
          ? `Network error: ${error.message}`
          : `Delivery failed: ${String(error)}`;

    return { ok: false, error: message, latencyMs };
  } finally {
    clearTimeout(timeoutId);
  }
}
