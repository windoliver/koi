import { describe, expect, mock, test } from "bun:test";
import { createE2bAdapter } from "./adapter.js";
import type { E2bClient, E2bSdkSandbox } from "./types.js";

function createMockSdk(): E2bSdkSandbox {
  return {
    commands: {
      run: mock(() => Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" })),
    },
    files: {
      read: mock(() => Promise.resolve("")),
      write: mock(() => Promise.resolve()),
    },
    kill: mock(() => Promise.resolve()),
  };
}

function createMockClient(sdk?: E2bSdkSandbox): E2bClient {
  return {
    createSandbox: mock(() => Promise.resolve(sdk ?? createMockSdk())),
  };
}

describe("createE2bAdapter", () => {
  test("returns ok with valid config", () => {
    const client = createMockClient();
    const result = createE2bAdapter({ apiKey: "test-key", client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("e2b");
    }
  });

  test("returns error with invalid config", () => {
    const original = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      const result = createE2bAdapter({});
      expect(result.ok).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env.E2B_API_KEY = original;
      }
    }
  });

  test("create returns a working SandboxInstance", async () => {
    const sdk = createMockSdk();
    const client = createMockClient(sdk);
    const result = createE2bAdapter({ apiKey: "test-key", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const instance = await result.value.create({
      tier: "sandbox",
      filesystem: { allowRead: ["/tmp"] },
      network: { allow: false },
      resources: { maxMemoryMb: 256, timeoutMs: 10000 },
    });

    const execResult = await instance.exec("echo", ["hello"]);
    expect(execResult.exitCode).toBe(0);

    await instance.destroy();
    expect(sdk.kill).toHaveBeenCalledTimes(1);
  });

  test("passes template to client", async () => {
    const client = createMockClient();
    const result = createE2bAdapter({
      apiKey: "test-key",
      template: "custom-template",
      client,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      tier: "sandbox",
      filesystem: {},
      network: { allow: false },
      resources: {},
    });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ template: "custom-template" }),
    );
  });

  test("throws without injected client", async () => {
    const result = createE2bAdapter({ apiKey: "test-key" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await expect(
      result.value.create({
        tier: "sandbox",
        filesystem: {},
        network: { allow: false },
        resources: {},
      }),
    ).rejects.toThrow("E2B SDK client not provided");
  });
});
