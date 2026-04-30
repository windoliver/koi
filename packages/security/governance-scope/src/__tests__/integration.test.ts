/**
 * Integration: scoped-fetcher composed inside @koi/url-safety's
 * createSafeFetcher proves that redirect-based scope-escape attempts
 * are blocked. The safe-fetcher manually follows redirects and re-calls
 * the inner fetcher (our scoped wrapper) for each hop.
 */

import { describe, expect, test } from "bun:test";
import { createSafeFetcher } from "@koi/url-safety";
import { createScopedFetcher } from "../scoped-fetcher.js";

function makeStubFetch(
  responses: ReadonlyMap<string, Response> | ((url: string) => Response),
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (typeof responses === "function") return responses(url);
    const r = responses.get(url);
    if (!r) return new Response("not found", { status: 404 });
    return r.clone();
  }) as typeof fetch;
}

// Stub resolver — returns a public IP for any host so url-safety's DNS
// check passes and our scope wrapper alone decides allow/deny.
const stubDns = async (_host: string) => ["8.8.8.8"];

describe("integration: scoped-fetcher inside createSafeFetcher", () => {
  test("blocks redirect that escapes the URL scope", async () => {
    const allow = [new URLPattern({ hostname: "api.mycorp.com" })];

    const stub = makeStubFetch(
      new Map([
        [
          "https://api.mycorp.com/redirect",
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.com/exfil" },
          }),
        ],
        ["https://evil.com/exfil", new Response("pwned", { status: 200 })],
      ]),
    );

    const scoped = createScopedFetcher(stub, { allow });
    const safe = createSafeFetcher(scoped, { dnsResolver: stubDns });

    await expect(safe("https://api.mycorp.com/redirect")).rejects.toThrow(
      /governance-scope:.*evil\.com/,
    );
  });

  test("allows a redirect that stays inside the URL scope", async () => {
    const allow = [new URLPattern({ hostname: "api.mycorp.com" })];
    const stub = makeStubFetch(
      new Map([
        [
          "https://api.mycorp.com/a",
          new Response(null, {
            status: 302,
            headers: { Location: "https://api.mycorp.com/b" },
          }),
        ],
        ["https://api.mycorp.com/b", new Response("ok", { status: 200 })],
      ]),
    );

    const scoped = createScopedFetcher(stub, { allow });
    const safe = createSafeFetcher(scoped, { dnsResolver: stubDns });

    const r = await safe("https://api.mycorp.com/a");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });
});
