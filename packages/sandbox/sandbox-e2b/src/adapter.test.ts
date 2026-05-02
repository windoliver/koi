import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import { createFakeClient } from "./__tests__/fakes.js";
import { createE2bAdapter } from "./adapter.js";

/** Open profile — the hosted backend can support it without provider-side enforcement. */
const openProfile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: true },
  resources: {},
};

describe("createE2bAdapter", () => {
  test("returns adapter when validation passes", () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", client });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("e2b");
  });

  test("propagates VALIDATION error from validate", () => {
    const result = createE2bAdapter({ client: createFakeClient() });
    expect(result.ok).toBe(false);
  });

  test("create() invokes client.createSandbox with apiKey + template", async () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", template: "tpl-1", client });
    if (!result.ok) throw new Error("validate failed");

    const instance = await result.value.create(openProfile);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.opts.apiKey).toBe("k");
    expect(client.calls[0]?.opts.template).toBe("tpl-1");

    const exec = await instance.exec("true", []);
    expect(exec.exitCode).toBe(0);
  });

  test("create() omits template when not configured", async () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await result.value.create(openProfile);
    expect(client.calls[0]?.opts.template).toBeUndefined();
  });

  test("create() fails closed when profile requests network=false", async () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = {
      ...openProfile,
      network: { allow: false },
    };
    await expect(result.value.create(profile)).rejects.toThrow(/network\.allow=false/);
    expect(client.calls).toHaveLength(0);
  });

  test("create() fails closed when profile requests closed filesystem", async () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", client });
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
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = {
      ...openProfile,
      resources: { maxMemoryMb: 512 },
    };
    await expect(result.value.create(profile)).rejects.toThrow(/resources\.maxMemoryMb/);
    expect(client.calls).toHaveLength(0);
  });

  test("create() fails closed when profile requests nexusMounts", async () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", client });
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
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = { ...openProfile, env: { FROM_PROFILE: "1" } };
    const instance = await result.value.create(profile);
    await instance.exec("ls", []);
    expect(client.sandbox.runCalls[0]?.opts?.envs).toEqual({ FROM_PROFILE: "1" });
  });

  test("create() forwards profile timeoutMs as default for per-call exec", async () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const profile: SandboxProfile = { ...openProfile, resources: { timeoutMs: 7777 } };
    const instance = await result.value.create(profile);
    await instance.exec("ls", []);
    expect(client.sandbox.runCalls[0]?.opts?.timeoutMs).toBe(7777);
  });

  test("create() surfaces idempotency label on ambiguous provider failure", async () => {
    // Orphan-on-retry regression: when createSandbox rejects, the provider
    // MAY have already provisioned the microVM. The adapter must surface
    // the label it generated so operators can find and revoke the orphan
    // out-of-band before retrying.
    const labels: string[] = [];
    const client = {
      supportsTeardown: true,
      createSandbox: async (opts: { label: string }) => {
        labels.push(opts.label);
        throw new Error("transient transport error");
      },
    } as unknown as Parameters<typeof createE2bAdapter>[0]["client"];
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await expect(result.value.create(openProfile)).rejects.toThrow(
      /createSandbox\(label=koi-[0-9a-f-]+\) failed.*transport error/i,
    );
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/^koi-/);
  });

  test("createE2bAdapter rejects clients that don't declare supportsTeardown", () => {
    const fake = createFakeClient();
    const { supportsTeardown: _drop, ...client } = fake;
    // @ts-expect-error -- intentionally violating the contract to exercise the runtime guard
    const result = createE2bAdapter({ apiKey: "k", client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/supportsTeardown/);
    }
  });

  test("create() rejects when SDK handle has no callable kill() (no deferred-leak surprise)", async () => {
    // Skew: a wrapper provisions a real microVM but the returned handle
    // has no kill(). Without an upfront check destroy() would discover the
    // gap only at teardown, after the remote sandbox already existed.
    const client = createFakeClient();
    const original = client.sandbox;
    const { kill: _omit, ...stripped } = original;
    Object.defineProperty(client, "createSandbox", {
      value: async () => stripped,
    });
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await expect(result.value.create(openProfile)).rejects.toThrow(/kill\(\)/);
  });

  test("per-call exec options override profile defaults", async () => {
    const client = createFakeClient();
    const result = createE2bAdapter({ apiKey: "k", client });
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
