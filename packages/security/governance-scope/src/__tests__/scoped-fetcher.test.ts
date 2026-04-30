import { describe, expect, test } from "bun:test";
import { createScopedFetcher } from "../scoped-fetcher.js";

function makeInner(): {
  readonly fn: typeof fetch;
  readonly calls: { input: string; init: RequestInit | undefined }[];
} {
  const calls: { input: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ input: url, init });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("createScopedFetcher", () => {
  test("forwards URLs that match an allowed pattern", async () => {
    const { fn, calls } = makeInner();
    const scoped = createScopedFetcher(fn, {
      allow: [new URLPattern({ hostname: "api.mycorp.com" })],
    });
    const r = await scoped("https://api.mycorp.com/v1/foo");
    expect(r.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  test("rejects URLs outside the allowlist", async () => {
    const { fn, calls } = makeInner();
    const scoped = createScopedFetcher(fn, {
      allow: [new URLPattern({ hostname: "api.mycorp.com" })],
    });
    await expect(scoped("https://evil.com/exfil")).rejects.toThrow(
      /outside the allowed fetch scope/,
    );
    expect(calls.length).toBe(0);
  });

  test("supports multiple patterns", async () => {
    const { fn } = makeInner();
    const scoped = createScopedFetcher(fn, {
      allow: [
        new URLPattern({ hostname: "api.mycorp.com" }),
        new URLPattern({ hostname: "*.public.example" }),
      ],
    });
    expect((await scoped("https://api.mycorp.com/v1")).status).toBe(200);
    expect((await scoped("https://x.public.example/y")).status).toBe(200);
    await expect(scoped("https://other.com")).rejects.toThrow();
  });

  test("works with URL objects", async () => {
    const { fn } = makeInner();
    const scoped = createScopedFetcher(fn, {
      allow: [new URLPattern({ hostname: "api.mycorp.com" })],
    });
    const r = await scoped(new URL("https://api.mycorp.com/v1"));
    expect(r.status).toBe(200);
  });

  test("works with Request objects", async () => {
    const { fn } = makeInner();
    const scoped = createScopedFetcher(fn, {
      allow: [new URLPattern({ hostname: "api.mycorp.com" })],
    });
    const req = new Request("https://api.mycorp.com/v1");
    const r = await scoped(req);
    expect(r.status).toBe(200);
  });

  test("path-scoped pattern blocks other paths on the same host", async () => {
    const { fn } = makeInner();
    const scoped = createScopedFetcher(fn, {
      allow: [new URLPattern({ hostname: "api.mycorp.com", pathname: "/v1/*" })],
    });
    expect((await scoped("https://api.mycorp.com/v1/foo")).status).toBe(200);
    await expect(scoped("https://api.mycorp.com/admin")).rejects.toThrow();
  });

  test("empty allowlist rejects everything", async () => {
    const { fn } = makeInner();
    const scoped = createScopedFetcher(fn, { allow: [] });
    await expect(scoped("https://api.mycorp.com")).rejects.toThrow();
  });
});
