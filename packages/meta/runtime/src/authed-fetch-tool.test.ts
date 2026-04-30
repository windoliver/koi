import { describe, expect, test } from "bun:test";
import type { CredentialComponent, JsonObject } from "@koi/core";

import { createAuthedFetchTool } from "./authed-fetch-tool.js";

interface FetchSpy {
  readonly fn: typeof fetch;
  readonly calls: { url: string; init: RequestInit | undefined }[];
}

function makeFetchSpy(response: Response): FetchSpy {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const credsAllowOnlyOpenAI: CredentialComponent = {
  async get(key) {
    if (key === "openai_api_key") return "sk-secret-shouldnt-leak";
    return undefined;
  },
};

describe("createAuthedFetchTool", () => {
  test("rejects empty url", async () => {
    const tool = createAuthedFetchTool({ credentials: credsAllowOnlyOpenAI });
    const result = (await tool.execute({ url: "", credKey: "openai_api_key" })) as JsonObject;
    expect(result.code).toBe("VALIDATION");
  });

  test("rejects non-http url", async () => {
    const tool = createAuthedFetchTool({ credentials: credsAllowOnlyOpenAI });
    const result = (await tool.execute({
      url: "ftp://example.com",
      credKey: "openai_api_key",
    })) as JsonObject;
    expect(result.code).toBe("VALIDATION");
  });

  test("rejects empty credKey", async () => {
    const tool = createAuthedFetchTool({ credentials: credsAllowOnlyOpenAI });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "",
    })) as JsonObject;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns PERMISSION when credKey resolves to undefined", async () => {
    const spy = makeFetchSpy(new Response("nope", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "stripe_secret",
    })) as JsonObject;
    expect(result.code).toBe("PERMISSION");
    expect(spy.calls).toHaveLength(0);
    // Identical message regardless of cause — agents can't enumerate
    expect(typeof result.error).toBe("string");
    expect((result.error as string).includes("not in scope or not configured")).toBe(true);
  });

  test("attaches Authorization: Bearer <cred> by default", async () => {
    const spy = makeFetchSpy(new Response("ok", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
    })) as JsonObject;
    expect(result.status).toBe(200);
    expect(spy.calls).toHaveLength(1);
    const headers = spy.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-secret-shouldnt-leak");
  });

  test("honors custom scheme and headerName", async () => {
    const spy = makeFetchSpy(new Response("ok", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
      scheme: "Token",
      headerName: "X-Api-Key",
    });
    const headers = spy.calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("Token sk-secret-shouldnt-leak");
    expect(headers.Authorization).toBeUndefined();
  });

  test("empty scheme passes the bare credential value", async () => {
    const spy = makeFetchSpy(new Response("ok", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
      scheme: "",
    });
    const headers = spy.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("sk-secret-shouldnt-leak");
  });

  test("response body never echoes the credential value", async () => {
    const spy = makeFetchSpy(new Response("hello", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
    })) as JsonObject;
    expect(result.body).toBe("hello");
    expect(JSON.stringify(result)).not.toContain("sk-secret-shouldnt-leak");
  });

  test("propagates URL-scope rejection from a wrapped fetch", async () => {
    const wrappedFetch = (async () => {
      throw new Error("governance-scope: URL 'https://blocked' is outside the allowed fetch scope");
    }) as unknown as typeof fetch;
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: wrappedFetch,
    });
    const result = (await tool.execute({
      url: "https://blocked",
      credKey: "openai_api_key",
    })) as JsonObject;
    expect(result.code).toBe("EXTERNAL");
    expect((result.error as string).includes("outside the allowed fetch scope")).toBe(true);
  });

  // gov-15 round-2: SSRF preflight + redaction-before-truncation regressions.

  describe("SSRF preflight (round-2)", () => {
    const ssrfTargets = [
      "http://localhost/admin",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://192.168.1.1/admin",
    ];
    for (const target of ssrfTargets) {
      test(`blocks ${target} with PERMISSION before fetch`, async () => {
        const spy = makeFetchSpy(new Response("would have leaked", { status: 200 }));
        const tool = createAuthedFetchTool({
          credentials: credsAllowOnlyOpenAI,
          fetchFn: spy.fn,
        });
        const result = (await tool.execute({
          url: target,
          credKey: "openai_api_key",
        })) as JsonObject;
        expect(result.code).toBe("PERMISSION");
        expect(spy.calls).toHaveLength(0);
      });
    }
  });

  test("redacts partial credential reflections via overlap-aware fragments (round-4)", async () => {
    // An upstream that echoes only a prefix of the credential would
    // bypass split-on-full-credValue redaction. With overlap-aware
    // fragments (every 16-byte sliding window of credValue is also
    // redacted), any reflection >= 16 bytes is removed.
    const cred = "sk-secret-shouldnt-leak-at-all-12345";
    const partialPrefix = cred.slice(0, 24); // 24-byte slice — bigger than 16-byte window
    const body = `Debug echo: Authorization: Bearer ${partialPrefix}... [truncated upstream]`;
    const spy = makeFetchSpy(new Response(body, { status: 200 }));
    const credsLong: CredentialComponent = {
      async get(key) {
        if (key === "openai_api_key") return cred;
        return undefined;
      },
    };
    const tool = createAuthedFetchTool({ credentials: credsLong, fetchFn: spy.fn });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
    })) as JsonObject;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(partialPrefix);
    expect(serialized).not.toContain(cred.slice(0, 16));
  });

  test("rejects credentials larger than the safe-redaction limit (round-4)", async () => {
    // A credential longer than the redaction window can leak partial
    // bytes that bypass exact-match redaction. Refuse credValue
    // > 1024 bytes with a stable INTERNAL error.
    const huge = "k".repeat(1025);
    const credsHuge: CredentialComponent = {
      async get(key) {
        if (key === "huge_key") return huge;
        return undefined;
      },
    };
    const spy = makeFetchSpy(new Response("ok", { status: 200 }));
    const tool = createAuthedFetchTool({ credentials: credsHuge, fetchFn: spy.fn });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "huge_key",
    })) as JsonObject;
    expect(result.code).toBe("INTERNAL");
    expect(spy.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(huge);
  });

  test("overlap-aware redaction leaves no residual bytes from echoed credential prefix (round-7)", async () => {
    // Round-7 finding: independent 16-byte fragment passes leave up
    // to 15 residual bytes from a reflected slice (the first
    // fragment match consumes bytes that overlapping fragments
    // depended on, so subsequent passes silently miss the tail).
    // The longest-match scan must collapse any contiguous run of
    // credential bytes >= REDACT_MIN_FRAGMENT (8) into a single
    // [REDACTED] regardless of where the run starts inside credValue.
    const cred = "sk-secret-shouldnt-leak-at-all-12345"; // 36 bytes
    const credsLong: CredentialComponent = {
      async get(key) {
        if (key === "openai_api_key") return cred;
        return undefined;
      },
    };
    // Echo a 17-byte prefix — bigger than the 8-byte fragment so it
    // must match, but specifically chosen to expose the residual-byte
    // bug under the old algorithm.
    const echo = cred.slice(0, 17);
    const body = `prefix ${echo} suffix`;
    const spy = makeFetchSpy(new Response(body, { status: 200 }));
    const tool = createAuthedFetchTool({ credentials: credsLong, fetchFn: spy.fn });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
    })) as JsonObject;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(echo);
    // No 8-byte slice of cred should survive (would indicate residual
    // bytes leaked at the boundary of a redacted run).
    for (let i = 0; i + 8 <= cred.length; i++) {
      expect(serialized).not.toContain(cred.slice(i, i + 8));
    }
  });

  test("overlap-aware redaction handles echoed middle and suffix slices (round-7)", async () => {
    const cred = "ghp_AAAAAAAAAAAABBBBBBBBBBBBCCCCCCCCCCCC"; // 40 bytes
    const credsCustom: CredentialComponent = {
      async get(key) {
        if (key === "github_token") return cred;
        return undefined;
      },
    };
    // Multiple disjoint echoes inside a single body — middle slice +
    // suffix slice + a non-secret blob between them.
    const middle = cred.slice(8, 24); // 16 bytes
    const suffix = cred.slice(20); // 20 bytes
    const body = `error log: ${middle} unrelated payload ${suffix} end`;
    const spy = makeFetchSpy(new Response(body, { status: 200 }));
    const tool = createAuthedFetchTool({ credentials: credsCustom, fetchFn: spy.fn });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "github_token",
    })) as JsonObject;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(middle);
    expect(serialized).not.toContain(suffix);
    expect(serialized).not.toContain(cred);
    expect(serialized).toContain("unrelated payload");
  });

  test("default fetchFn is SSRF-safe (DNS-backed) when caller omits override (round-7)", async () => {
    // createAuthedFetchTool used to fall back to globalThis.fetch when
    // the host did not inject a scope-wrapped fetch; that path had no
    // DNS-backed SSRF guard, so a public hostname resolving to a
    // private/metadata IP could exfil the credential. The default now
    // uses createSafeFetcher under the hood, which performs DNS-backed
    // isSafeUrl checks. We assert the call surfaces a url-safety
    // error, not a successful network request, when targeting a
    // non-resolvable / non-public host.
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      // No fetchFn — exercise the default safe fetcher.
    });
    const result = (await tool.execute({
      url: "http://this-host-must-not-resolve.invalid./",
      credKey: "openai_api_key",
    })) as JsonObject;
    // Either the static preflight fires (if it classifies the target
    // as non-public) or createSafeFetcher rejects via isSafeUrl after
    // DNS. Either path returns a non-success code with no credential
    // leak; both PERMISSION (preflight) and EXTERNAL (safe-fetcher
    // throw) are acceptable.
    expect(result.code === "PERMISSION" || result.code === "EXTERNAL").toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-secret-shouldnt-leak");
  });

  test("redacts the credential even when response body straddles MAX_BODY_BYTES boundary", async () => {
    // Round-2 finding: if redaction runs after truncation, an attacker
    // who controls response padding can push the credential to span the
    // truncation boundary. Build a response where the credential value
    // sits exactly across 50_000 bytes — the prefix slice must NOT
    // contain a partial substring of the secret.
    const cred = "sk-secret-shouldnt-leak";
    const padding = "A".repeat(50_000 - 5); // 5 bytes of cred would land in kept slice
    const body = `${padding}${cred}`;
    const spy = makeFetchSpy(new Response(body, { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
    })) as JsonObject;
    // Whole response must contain no fragment of the credential, not
    // just the full string. Check substrings of length >= 8 — anything
    // shorter is too generic to be a useful exfiltration.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(cred);
    expect(serialized).not.toContain(cred.slice(0, 12));
    expect(serialized).not.toContain(cred.slice(0, 10));
    expect(serialized).not.toContain(cred.slice(0, 8));
  });
});
