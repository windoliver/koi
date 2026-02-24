import { describe, expect, mock, test } from "bun:test";
import { createCloudflareAdapter } from "./adapter.js";
import type { CfSdkSandbox, CloudflareClient } from "./types.js";

function createMockSdk(): CfSdkSandbox {
  return {
    commands: { run: mock(() => Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" })) },
    files: { read: mock(() => Promise.resolve("")), write: mock(() => Promise.resolve()) },
    close: mock(() => Promise.resolve()),
  };
}

function createMockClient(sdk?: CfSdkSandbox): CloudflareClient {
  return { createSandbox: mock(() => Promise.resolve(sdk ?? createMockSdk())) };
}

describe("createCloudflareAdapter", () => {
  test("returns ok with valid config", () => {
    const result = createCloudflareAdapter({ apiToken: "token", client: createMockClient() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("cloudflare");
  });

  test("returns error with missing token", () => {
    const original = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      expect(createCloudflareAdapter({}).ok).toBe(false);
    } finally {
      if (original !== undefined) process.env.CLOUDFLARE_API_TOKEN = original;
    }
  });

  test("create returns working instance", async () => {
    const sdk = createMockSdk();
    const result = createCloudflareAdapter({ apiToken: "token", client: createMockClient(sdk) });
    if (!result.ok) return;
    const instance = await result.value.create({
      tier: "sandbox",
      filesystem: {},
      network: { allow: false },
      resources: {},
    });
    expect((await instance.exec("echo", ["hi"])).exitCode).toBe(0);
    await instance.destroy();
  });

  test("throws without injected client", async () => {
    const result = createCloudflareAdapter({ apiToken: "token" });
    if (!result.ok) return;
    await expect(
      result.value.create({
        tier: "sandbox",
        filesystem: {},
        network: { allow: false },
        resources: {},
      }),
    ).rejects.toThrow("Cloudflare SDK client not provided");
  });
});
