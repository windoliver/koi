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
import { preflightBlockReason } from "@koi/tools-web";

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
      // SSRF preflight — same DNS-free static check used by web_fetch.
      // Catches obvious targets (localhost, 127/8, 169.254.0.0/16,
      // RFC1918, link-local, .internal, .localhost suffixes, IPv6
      // private). Without this, an `authed_fetch` registered without a
      // manifest `network.allow` falls through to the global fetch and
      // can hit cloud-metadata IMDS or internal services with the
      // credential attached. Returning PERMISSION (not VALIDATION) so
      // the rejection is consistent with credential-scope rejections —
      // agents see a uniform "request denied" surface.
      const blockReason = preflightBlockReason(url);
      if (blockReason !== undefined) {
        return {
          error: "request denied: target is not a public http(s) URL",
          code: "PERMISSION",
        };
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

      // Round-4 finding: a credential longer than the response window
      // can leak partial bytes that bypass exact-match redaction (a
      // reflecting upstream returning `credValue.slice(0, MAX_BODY_BYTES)`
      // would carry verbatim credential material, and string.split()
      // wouldn't find the full credValue to replace). Refuse credentials
      // bigger than what the redactor can safely handle. 1024 bytes is
      // generous for any realistic API key — refuse anything larger
      // with a stable INTERNAL error that does not echo the credKey.
      const MAX_CRED_BYTES = 1024;
      if (credValue.length > MAX_CRED_BYTES) {
        return {
          error: "credential value exceeds the safe-redaction limit",
          code: "INTERNAL",
        };
      }

      const authHeader = scheme === "" ? credValue : `${scheme} ${credValue}`;
      // Redact the credential everywhere it appears in returned strings.
      // Two layers:
      //   (1) Exact-match: replace every full-length occurrence of
      //       authHeader and credValue with [REDACTED].
      //   (2) Overlap-aware: walk every contiguous credValue substring
      //       of length REDACT_MIN_FRAGMENT (sliding window). A
      //       reflecting upstream that echoes any prefix/suffix/middle
      //       slice longer than the window will hit at least one of
      //       these fragments. Replacing it with [REDACTED] removes a
      //       chain of leaked bytes — repeated passes erode the
      //       reflection until no fragment survives.
      // 16 bytes is the smallest fragment that's still identifying for
      // typical high-entropy API keys (sk-live-XXXX, ghp_XXXX, etc.)
      // while being unlikely to false-positive on body content.
      const REDACT_MIN_FRAGMENT = 16;
      const fragments: readonly string[] =
        credValue.length >= REDACT_MIN_FRAGMENT
          ? Array.from({ length: credValue.length - REDACT_MIN_FRAGMENT + 1 }, (_, i) =>
              credValue.slice(i, i + REDACT_MIN_FRAGMENT),
            )
          : [];
      const redact = (s: string): string => {
        if (s.length === 0) return s;
        let out = s;
        if (authHeader.length > 0) out = out.split(authHeader).join("[REDACTED]");
        if (credValue.length > 0) out = out.split(credValue).join("[REDACTED]");
        for (const fragment of fragments) {
          if (out.includes(fragment)) {
            out = out.split(fragment).join("[REDACTED]");
          }
        }
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
        // Redact BEFORE truncation. If we sliced first, an attacker who
        // controls response padding could push the credential value to
        // straddle the truncation boundary, leaving a partial substring
        // in the kept half that no longer matches the redaction tokens.
        // Redacting first means every full-length occurrence is replaced
        // with the same-or-shorter "[REDACTED]" before any slicing.
        const redactedBody = redact(body);
        const truncated = redactedBody.length > MAX_BODY_BYTES;
        return {
          status: res.status,
          statusText: redact(res.statusText),
          body: truncated ? redactedBody.slice(0, MAX_BODY_BYTES) : redactedBody,
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
