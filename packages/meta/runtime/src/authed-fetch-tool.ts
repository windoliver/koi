/**
 * `authed_fetch` — minimal agent-facing tool that fetches a URL with an
 * Authorization header sourced from the wired `CredentialComponent`.
 *
 * This is the canonical "credentials are consumed by tools, not by agents"
 * pattern (gov-15): the model selects a `credKey`, the tool resolves it
 * through the scoped credential component, and the response never echoes
 * the credential value back. An out-of-scope `credKey` resolves to
 * `undefined` and the tool returns a `PERMISSION` error — agents cannot
 * enumerate other secrets even by trial.
 *
 * Composes with `createScopedFetcher` (URL scope) when the host passes a
 * scope-wrapped `fetch` via `fetchFn`. Both gates are independent: a
 * request must satisfy URL scope AND credential scope to succeed.
 */

import type { CredentialComponent, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

const MAX_BODY_BYTES = 50_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

export interface AuthedFetchToolOptions {
  /** CredentialComponent the tool resolves `credKey` through. Required. */
  readonly credentials: CredentialComponent;
  /**
   * Optional `fetch` override (e.g. a scope-wrapped fetch from
   * `createScopedFetcher`). Defaults to the global `fetch`.
   */
  readonly fetchFn?: typeof fetch;
  /** Optional custom tool policy. Defaults to `DEFAULT_UNSANDBOXED_POLICY`. */
  readonly policy?: ToolPolicy;
}

export function createAuthedFetchTool(opts: AuthedFetchToolOptions): Tool {
  const { credentials } = opts;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const policy = opts.policy ?? DEFAULT_UNSANDBOXED_POLICY;
  return {
    descriptor: {
      name: "authed_fetch",
      description:
        "Fetch a URL with an Authorization header sourced from the wired credentials store. " +
        "The credential value never appears in the response. " +
        "URL scope (manifest.network.allow) and credential scope (manifest.credentials.allow) " +
        "are enforced independently — both must permit the request.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Public http/https URL to fetch",
          },
          credKey: {
            type: "string",
            description:
              "Logical credential key to resolve through the wired CredentialComponent. " +
              "Must match an entry under `manifest.credentials.allow` or the request fails closed.",
          },
          scheme: {
            type: "string",
            description:
              'Authorization scheme prefix. Default "Bearer". Pass "" for a raw value, or e.g. "Token".',
          },
          headerName: {
            type: "string",
            description: 'Header name. Default "Authorization".',
          },
          timeout: {
            type: "number",
            description: `Timeout in ms (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: ["url", "credKey"],
      } satisfies JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      if (typeof args.url !== "string" || args.url.trim() === "") {
        return { error: "url must be a non-empty string", code: "VALIDATION" };
      }
      const url = args.url.trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return { error: "url must start with http:// or https://", code: "VALIDATION" };
      }
      if (typeof args.credKey !== "string" || args.credKey.trim() === "") {
        return { error: "credKey must be a non-empty string", code: "VALIDATION" };
      }
      const credKey = args.credKey.trim();
      const scheme = typeof args.scheme === "string" ? args.scheme : "Bearer";
      const headerName = typeof args.headerName === "string" ? args.headerName : "Authorization";
      const timeout = typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT_MS;
      if (timeout < 100 || timeout > MAX_TIMEOUT_MS) {
        return {
          error: `timeout must be between 100 and ${MAX_TIMEOUT_MS}`,
          code: "VALIDATION",
        };
      }

      const credValue = await credentials.get(credKey);
      if (credValue === undefined) {
        // Identical message for "key not in scope" vs "key not configured" so
        // the agent cannot probe which keys exist by varying the suffix.
        return {
          error: `credential "${credKey}" is unavailable (not in scope or not configured)`,
          code: "PERMISSION",
        };
      }

      const authHeader = scheme === "" ? credValue : `${scheme} ${credValue}`;
      // Redact both the bare credential and the full Authorization header
      // anywhere they appear in returned strings. An echo/debug endpoint
      // (or a misconfigured upstream that surfaces request headers in error
      // pages) would otherwise hand the credential straight back to the
      // agent through `body` or `statusText`.
      const redact = (s: string): string => {
        if (s.length === 0) return s;
        let out = s;
        if (authHeader.length > 0) out = out.split(authHeader).join("[REDACTED]");
        if (credValue.length > 0) out = out.split(credValue).join("[REDACTED]");
        return out;
      };
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetchFn(url, {
          method: "GET",
          headers: { [headerName]: authHeader },
          // Do NOT auto-follow redirects: URL scope is enforced on the
          // initial URL only, so a redirect to an off-allowlist host would
          // smuggle the credential past the gate. Surface 30x to the agent
          // and let an explicit follow-up call re-pass URL scope.
          redirect: "manual",
          signal: controller.signal,
        });
        const body = await res.text();
        const truncated = body.length > MAX_BODY_BYTES;
        const safeBody = redact(truncated ? body.slice(0, MAX_BODY_BYTES) : body);
        return {
          status: res.status,
          statusText: redact(res.statusText),
          body: safeBody,
          truncated,
        };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        // Surface URL-scope / DNS / network failures uniformly. Do NOT
        // include the credential value or the cred key in the error path —
        // the message is reflected back to the agent.
        return { error: `fetch failed: ${redact(message)}`, code: "EXTERNAL" };
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
  };
}
