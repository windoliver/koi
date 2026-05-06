import { describe, expect, test } from "bun:test";
import type { TeamsConfig } from "./config.js";
import { createBotFrameworkAppTokenMinter } from "./mint-app-token.js";

type MintConfig = Pick<TeamsConfig, "appId" | "appPassword" | "cloud">;

const baseConfig: MintConfig = {
  appId: "app-1",
  appPassword: "secret",
  cloud: "public",
};

function captureFetch(): {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly calls: { readonly url: string; readonly body: string }[];
} {
  const calls: { url: string; body: string }[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchFn, calls };
}

describe("createBotFrameworkAppTokenMinter", () => {
  test("public cloud uses botframework.com tenant + api.botframework.com scope", async () => {
    const { fetch, calls } = captureFetch();
    const mint = createBotFrameworkAppTokenMinter({ ...baseConfig, cloud: "public" }, { fetch });
    await mint();
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call?.url).toContain("login.microsoftonline.com/botframework.com/");
    expect(call?.body).toContain("scope=https%3A%2F%2Fapi.botframework.com%2F.default");
  });

  test("gov cloud uses botframework.azure.us tenant + api.botframework.us scope", async () => {
    // Regression: gov-cloud Teams configs used to mint public-cloud
    // tokens, so inbound JWT verification (gov issuer) succeeded but
    // every outbound send failed at the wrong authority — a silent
    // gov-deployment outage.
    const { fetch, calls } = captureFetch();
    const mint = createBotFrameworkAppTokenMinter({ ...baseConfig, cloud: "gov" }, { fetch });
    await mint();
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call?.url).toContain("login.microsoftonline.com/botframework.azure.us/");
    expect(call?.body).toContain("scope=https%3A%2F%2Fapi.botframework.us%2F.default");
  });

  test("explicit options.tenant + options.scope override cloud defaults", async () => {
    const { fetch, calls } = captureFetch();
    const mint = createBotFrameworkAppTokenMinter(
      { ...baseConfig, cloud: "gov" },
      { fetch, tenant: "private.example", scope: "https://api.private.example/.default" },
    );
    await mint();
    const call = calls[0];
    expect(call?.url).toContain("/private.example/");
    expect(call?.body).toContain("scope=https%3A%2F%2Fapi.private.example%2F.default");
  });

  test("token cached until refresh window", async () => {
    let now = 0;
    const clock = (): number => now;
    const { fetch, calls } = captureFetch();
    const mint = createBotFrameworkAppTokenMinter(baseConfig, { fetch, clock });
    await mint();
    now = 1000;
    await mint();
    expect(calls.length).toBe(1);
  });
});
