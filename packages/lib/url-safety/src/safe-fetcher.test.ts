import { describe, expect, test } from "bun:test";
import { createSafeFetcher } from "./safe-fetcher.js";

const publicResolver = async (hostname: string): Promise<readonly string[]> => {
  if (hostname === "public.example.com") return ["93.184.216.34"];
  if (hostname === "private.example.com") return ["127.0.0.1"];
  throw new Error(`ENOTFOUND ${hostname}`);
};

function mockFetch(responses: Readonly<Record<string, Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = responses[url];
    if (res === undefined) throw new Error(`no mock for ${url}`);
    return res;
  }) as typeof fetch;
}

describe("createSafeFetcher", () => {
  test("passes through safe request", async () => {
    const safeFetch = createSafeFetcher(
      mockFetch({ "https://public.example.com/ok": new Response("hi", { status: 200 }) }),
      { dnsResolver: publicResolver },
    );
    const res = await safeFetch("https://public.example.com/ok");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
  });

  test("blocks initial URL if private", async () => {
    const safeFetch = createSafeFetcher(mockFetch({}), { dnsResolver: publicResolver });
    await expect(safeFetch("http://127.0.0.1/")).rejects.toThrow(/Blocked/);
  });

  test("revalidates on redirect — blocks public→private", async () => {
    const safeFetch = createSafeFetcher(
      mockFetch({
        "https://public.example.com/redirect": new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        }),
      }),
      { dnsResolver: publicResolver },
    );
    await expect(safeFetch("https://public.example.com/redirect")).rejects.toThrow(
      /Blocked|169\.254\.169\.254/,
    );
  });

  test("follows safe redirect", async () => {
    const safeFetch = createSafeFetcher(
      mockFetch({
        "https://public.example.com/r": new Response(null, {
          status: 302,
          headers: { Location: "https://public.example.com/final" },
        }),
        "https://public.example.com/final": new Response("done", { status: 200 }),
      }),
      { dnsResolver: publicResolver },
    );
    const res = await safeFetch("https://public.example.com/r");
    expect(await res.text()).toBe("done");
  });

  test("caps at maxRedirects", async () => {
    const safeFetch = createSafeFetcher(
      mockFetch({
        "https://public.example.com/a": new Response(null, {
          status: 302,
          headers: { Location: "https://public.example.com/b" },
        }),
        "https://public.example.com/b": new Response(null, {
          status: 302,
          headers: { Location: "https://public.example.com/c" },
        }),
        "https://public.example.com/c": new Response(null, {
          status: 302,
          headers: { Location: "https://public.example.com/a" },
        }),
      }),
      { dnsResolver: publicResolver, maxRedirects: 2 },
    );
    await expect(safeFetch("https://public.example.com/a")).rejects.toThrow(/redirects/);
  });
});
