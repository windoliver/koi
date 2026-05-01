import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import { createFakeClient } from "./__tests__/fakes.js";
import { createDaytonaAdapter } from "./adapter.js";

const openProfile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: true },
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

    const instance = await result.value.create(openProfile);
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
    await result.value.create(openProfile);
    expect(client.calls[0]?.opts.apiUrl).toBeUndefined();
    expect(client.calls[0]?.opts.target).toBe("us");
  });

  test("create() fails closed when profile requests network=false", async () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = { ...openProfile, network: { allow: false } };
    await expect(result.value.create(profile)).rejects.toThrow(/network\.allow=false/);
    expect(client.calls).toHaveLength(0);
  });

  test("create() fails closed when profile requests closed filesystem", async () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = {
      ...openProfile,
      filesystem: { defaultReadAccess: "closed" },
    };
    await expect(result.value.create(profile)).rejects.toThrow(/filesystem\.defaultReadAccess/);
    expect(client.calls).toHaveLength(0);
  });

  test("create() fails closed when profile requests resource limits", async () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = {
      ...openProfile,
      resources: { maxPids: 100 },
    };
    await expect(result.value.create(profile)).rejects.toThrow(/resources\.maxPids/);
    expect(client.calls).toHaveLength(0);
  });

  test("create() fails closed when profile requests nexusMounts", async () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = {
      ...openProfile,
      nexusMounts: [{ nexusUrl: "x", apiKey: "y", mountPath: "/m" }],
    };
    await expect(result.value.create(profile)).rejects.toThrow(/nexusMounts/);
    expect(client.calls).toHaveLength(0);
  });

  test("create() forwards profile env into per-call exec envs", async () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = { ...openProfile, env: { FROM_PROFILE: "1" } };
    const instance = await result.value.create(profile);
    await instance.exec("ls", []);
    expect(client.sandbox.runCalls[0]?.opts?.envs).toEqual({ FROM_PROFILE: "1" });
  });

  test("create() forwards profile timeoutMs as default for per-call exec", async () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = { ...openProfile, resources: { timeoutMs: 7777 } };
    const instance = await result.value.create(profile);
    await instance.exec("ls", []);
    expect(client.sandbox.runCalls[0]?.opts?.timeoutMs).toBe(7777);
  });

  test("per-call exec options override profile defaults", async () => {
    const client = createFakeClient();
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = {
      ...openProfile,
      env: { FOO: "from-profile" },
      resources: { timeoutMs: 1000 },
    };
    const instance = await result.value.create(profile);
    await instance.exec("ls", [], { env: { FOO: "from-call", BAR: "added" }, timeoutMs: 5000 });
    expect(client.sandbox.runCalls[0]?.opts?.envs).toEqual({ FOO: "from-call", BAR: "added" });
    expect(client.sandbox.runCalls[0]?.opts?.timeoutMs).toBe(5000);
  });
});
