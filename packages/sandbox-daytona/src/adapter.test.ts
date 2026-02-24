import { describe, expect, mock, test } from "bun:test";
import { createDaytonaAdapter } from "./adapter.js";
import type { DaytonaClient, DaytonaSdkSandbox } from "./types.js";

function createMockSdk(): DaytonaSdkSandbox {
  return {
    commands: { run: mock(() => Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" })) },
    files: { read: mock(() => Promise.resolve("")), write: mock(() => Promise.resolve()) },
    close: mock(() => Promise.resolve()),
  };
}

function createMockClient(sdk?: DaytonaSdkSandbox): DaytonaClient {
  return { createSandbox: mock(() => Promise.resolve(sdk ?? createMockSdk())) };
}

describe("createDaytonaAdapter", () => {
  test("returns ok with valid config", () => {
    const result = createDaytonaAdapter({ apiKey: "key", client: createMockClient() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("daytona");
  });

  test("returns error with missing key", () => {
    const original = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      expect(createDaytonaAdapter({}).ok).toBe(false);
    } finally {
      if (original !== undefined) process.env.DAYTONA_API_KEY = original;
    }
  });

  test("create returns working instance", async () => {
    const sdk = createMockSdk();
    const result = createDaytonaAdapter({ apiKey: "key", client: createMockClient(sdk) });
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

  test("passes config to client", async () => {
    const client = createMockClient();
    const result = createDaytonaAdapter({
      apiKey: "key",
      apiUrl: "https://custom.api",
      target: "eu",
      client,
    });
    if (!result.ok) return;
    await result.value.create({
      tier: "sandbox",
      filesystem: {},
      network: { allow: false },
      resources: {},
    });
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "key", apiUrl: "https://custom.api", target: "eu" }),
    );
  });

  test("throws without injected client", async () => {
    const result = createDaytonaAdapter({ apiKey: "key" });
    if (!result.ok) return;
    await expect(
      result.value.create({
        tier: "sandbox",
        filesystem: {},
        network: { allow: false },
        resources: {},
      }),
    ).rejects.toThrow("Daytona SDK client not provided");
  });
});
