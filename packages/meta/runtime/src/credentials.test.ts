import { describe, expect, test } from "bun:test";
import type { Agent, CredentialComponent } from "@koi/core";
import { CREDENTIALS, isAttachResult } from "@koi/core";

import { createCredentialsProvider, createEnvCredentials } from "./credentials.js";

describe("createEnvCredentials", () => {
  test("resolves key via default KOI_CRED_ prefix", async () => {
    const creds = createEnvCredentials({ env: { KOI_CRED_OPENAI_API_KEY: "sk-test" } });
    expect(await creds.get("openai_api_key")).toBe("sk-test");
  });

  test("canonicalises hyphens, dots, and case", async () => {
    const creds = createEnvCredentials({
      env: { KOI_CRED_OPENAI_API_KEY: "sk-test" },
    });
    expect(await creds.get("OpenAI.Api-Key")).toBe("sk-test");
  });

  test("returns undefined when env var is missing", async () => {
    const creds = createEnvCredentials({ env: {} });
    expect(await creds.get("missing")).toBeUndefined();
  });

  test("treats empty string as undefined", async () => {
    const creds = createEnvCredentials({ env: { KOI_CRED_BLANK: "" } });
    expect(await creds.get("blank")).toBeUndefined();
  });

  test("custom prefix overrides default", async () => {
    const creds = createEnvCredentials({
      prefix: "MYAPP_",
      env: { MYAPP_TOKEN: "xyz", KOI_CRED_TOKEN: "wrong" },
    });
    expect(await creds.get("token")).toBe("xyz");
  });

  test("empty prefix reads bare env vars", async () => {
    const creds = createEnvCredentials({
      prefix: "",
      env: { OPENAI_API_KEY: "sk-bare" },
    });
    expect(await creds.get("openai_api_key")).toBe("sk-bare");
  });
});

describe("createCredentialsProvider", () => {
  test("attaches the component under the CREDENTIALS token", async () => {
    const stub: CredentialComponent = {
      async get(): Promise<string | undefined> {
        return "stub-value";
      },
    };
    const provider = createCredentialsProvider(stub);
    expect(provider.name).toBe("credentials");
    const result = await provider.attach({} as Agent);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.get(CREDENTIALS as unknown as string)).toBe(stub);
    expect(result.skipped).toEqual([]);
  });
});
