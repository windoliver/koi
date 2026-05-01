import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import { createFakeClient } from "./__tests__/fakes.js";
import { createDaytonaAdapter } from "./adapter.js";

const baseProfile: SandboxProfile = {
  filesystem: { defaultReadAccess: "closed" },
  network: { allow: false },
  resources: {},
};

describe("createDaytonaAdapter", () => {
  test("returns adapter when validation passes", () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({ apiKey: "k", client });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("daytona");
  });

  test("propagates VALIDATION error", () => {
    const result = createDaytonaAdapter({ client: createFakeClient() });
    expect(result.ok).toBe(false);
  });

  test("create() invokes client with apiKey + apiUrl + target", async () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({
      apiKey: "k",
      apiUrl: "https://api.example",
      target: "eu",
      client,
    });
    if (!result.ok) throw new Error("validate failed");

    const instance = await result.value.create(baseProfile);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.opts.apiKey).toBe("k");
    expect(client.calls[0]?.opts.apiUrl).toBe("https://api.example");
    expect(client.calls[0]?.opts.target).toBe("eu");

    const exec = await instance.exec("true", []);
    expect(exec.exitCode).toBe(0);
  });

  test("create() omits apiUrl when not configured", async () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await result.value.create(baseProfile);
    expect(client.calls[0]?.opts.apiUrl).toBeUndefined();
    expect(client.calls[0]?.opts.target).toBe("us");
  });
});
