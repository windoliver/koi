import { describe, expect, mock, test } from "bun:test";
import { createVercelAdapter } from "./adapter.js";
import type { VercelClient, VercelSdkSandbox } from "./types.js";

function createMockSdk(): VercelSdkSandbox {
  return {
    commands: { run: mock(() => Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" })) },
    files: { read: mock(() => Promise.resolve("")), write: mock(() => Promise.resolve()) },
    close: mock(() => Promise.resolve()),
  };
}

function createMockClient(sdk?: VercelSdkSandbox): VercelClient {
  return { createSandbox: mock(() => Promise.resolve(sdk ?? createMockSdk())) };
}

describe("createVercelAdapter", () => {
  test("returns ok with valid config", () => {
    const result = createVercelAdapter({ apiToken: "token", client: createMockClient() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("vercel");
  });

  test("returns error with missing token", () => {
    const original = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    try {
      expect(createVercelAdapter({}).ok).toBe(false);
    } finally {
      if (original !== undefined) process.env.VERCEL_TOKEN = original;
    }
  });

  test("returns error without injected client", () => {
    const result = createVercelAdapter({ apiToken: "token" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("client");
    }
  });

  test("create returns working instance", async () => {
    const sdk = createMockSdk();
    const result = createVercelAdapter({ apiToken: "token", client: createMockClient(sdk) });
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
});
