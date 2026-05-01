import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import { createFakeClient } from "./__tests__/fakes.js";
import { createE2bAdapter } from "./adapter.js";

const baseProfile: SandboxProfile = {
  filesystem: { defaultReadAccess: "closed" },
  network: { allow: false },
  resources: {},
};

describe("createE2bAdapter", () => {
  test("returns adapter when validation passes", () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("e2b");
    }
  });

  test("propagates VALIDATION error from validate", () => {
    const result = createE2bAdapter({ client: createFakeClient() });
    expect(result.ok).toBe(false);
  });

  test("create() invokes client.createSandbox with apiKey + template", async () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", template: "tpl-1", client });
    if (!result.ok) throw new Error("validate failed");

    const instance = await result.value.create(baseProfile);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.opts.apiKey).toBe("k");
    expect(client.calls[0]?.opts.template).toBe("tpl-1");

    // Smoke check: returned instance is functional.
    const exec = await instance.exec("true", []);
    expect(exec.exitCode).toBe(0);
  });

  test("create() omits template when not configured", async () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await result.value.create(baseProfile);
    expect(client.calls[0]?.opts.template).toBeUndefined();
  });
});
