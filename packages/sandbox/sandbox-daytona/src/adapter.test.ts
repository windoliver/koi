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

  test("create() surfaces idempotency label on ambiguous provider failure", async () => {
    // Orphan-on-retry regression: createSandbox can reject after the remote
    // workspace has already been allocated; the adapter must surface the
    // label so operators can revoke the orphan out-of-band before retrying.
    const labels: string[] = [];
    const client = {
      supportsWorkspaceDelete: true,
      createSandbox: async (opts: { label: string }) => {
        labels.push(opts.label);
        throw new Error("provider 503");
      },
    } as unknown as Parameters<typeof createDaytonaAdapter>[0]["client"];
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await expect(result.value.create(openProfile)).rejects.toThrow(
      /createSandbox\(label=koi-[0-9a-f-]+\) failed.*provider 503/i,
    );
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/^koi-/);
  });

  test("create() rejects when SDK handle lies about delete() (best-effort close + clear leak warning)", async () => {
    // Skew: a buggy/lying wrapper passes supportsWorkspaceDelete=true but
    // returns a handle without delete(). The adapter best-effort calls
    // close() (because in some SDK versions it really does delete) and
    // surfaces a clear error noting the workspace MAY have leaked, so
    // operators know to verify out-of-band.
    const client = createFakeClient();
    const original = client.sandbox;
    const { delete: _omit, ...stripped } = original;
    Object.defineProperty(client, "createSandbox", {
      value: async () => stripped,
    });
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const err = await result.value.create(openProfile).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/MAY have leaked/);
    // The per-attempt label MUST appear so operators can locate the
    // orphan workspace deterministically.
    expect((err as Error).message).toMatch(/koi-[0-9a-f-]{36}/);
    // Best-effort cleanup was attempted.
    expect(original.closed()).toBe(true);
  });

  test("createDaytonaAdapter rejects clients that don't declare supportsWorkspaceDelete", () => {
    // Preflight gate: without the affirmative declaration, the adapter
    // refuses synchronously — never even gives callers a chance to invoke
    // create() and provision a workspace under skew.
    const fake = createFakeClient();
    const { supportsWorkspaceDelete: _drop, ...client } = fake;
    // @ts-expect-error -- intentionally violating the contract to exercise the runtime guard
    const result = createDaytonaAdapter({ apiKey: "k", client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/supportsWorkspaceDelete/);
    }
  });

  test("create() bounds provisioning and surfaces label on stalled createSandbox", async () => {
    // Degraded-provider regression: control plane never responds.
    // create() must time out and surface the label so operators can
    // find any orphan workspace.
    const client = createFakeClient();
    Object.defineProperty(client, "createSandbox", {
      value: () => new Promise(() => {}),
    });
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const start = performance.now();
    const err = await result.value.create(openProfile).catch((e: unknown) => e as Error);
    const elapsed = performance.now() - start;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/INDETERMINATE/);
    expect((err as Error).message).toMatch(/koi-[0-9a-f-]{36}/);
    expect(elapsed).toBeLessThan(35_000);
  }, 40_000);

  test("create() reconciles a late-arriving handle after timeout (best-effort delete)", async () => {
    // Late-cleanup regression: when the local timeout fires but the
    // SDK eventually returns a handle anyway, the adapter must best-
    // effort delete the orphan workspace.
    const client = createFakeClient();
    const handle = client.sandbox;
    let deleteCalls = 0;
    let resolveCreate!: (sdk: typeof handle) => void;
    const lateHandle = {
      ...handle,
      delete: async (): Promise<void> => {
        deleteCalls++;
      },
    };
    Object.defineProperty(client, "createSandbox", {
      value: () =>
        new Promise<typeof handle>((r) => {
          resolveCreate = r;
        }),
    });
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const createPromise = result.value.create(openProfile);
    const err = await createPromise.catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/INDETERMINATE/);
    resolveCreate(lateHandle);
    await new Promise((r) => setTimeout(r, 100));
    expect(deleteCalls).toBe(1);
  }, 40_000);

  test("create() postflights files.readBytes and tears down handles without binary read", async () => {
    const client = createFakeClient();
    const original = client.sandbox;
    let deleteCalls = 0;
    const { readBytes: _omitRead, ...filesNoReadBytes } = original.files;
    const handle = {
      ...original,
      files: filesNoReadBytes,
      delete: async (): Promise<void> => {
        deleteCalls++;
      },
    };
    Object.defineProperty(client, "createSandbox", {
      value: async () => handle,
    });
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await expect(result.value.create(openProfile)).rejects.toThrow(/files\.readBytes/);
    expect(deleteCalls).toBe(1);
  });

  test("create() postflights files.writeBytes and tears down handles without binary write", async () => {
    const client = createFakeClient();
    const original = client.sandbox;
    let deleteCalls = 0;
    const { writeBytes: _omitWrite, ...filesNoWriteBytes } = original.files;
    const handle = {
      ...original,
      files: filesNoWriteBytes,
      delete: async (): Promise<void> => {
        deleteCalls++;
      },
    };
    Object.defineProperty(client, "createSandbox", {
      value: async () => handle,
    });
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await expect(result.value.create(openProfile)).rejects.toThrow(/files\.writeBytes/);
    expect(deleteCalls).toBe(1);
  });

  test("create() postflights supportsMaxOutputBytes and tears down unusable handles", async () => {
    // Skew regression: an SDK whose handle lacks supportsMaxOutputBytes=true
    // would let create() return a billable workspace where every exec()
    // hard-fails. Postflight catches this and tears down the just-
    // provisioned remote resource before any caller can use it.
    const client = createFakeClient();
    const original = client.sandbox;
    let deleteCalls = 0;
    const handle = {
      ...original,
      commands: { ...original.commands, supportsMaxOutputBytes: false },
      delete: async (): Promise<void> => {
        deleteCalls++;
      },
    };
    Object.defineProperty(client, "createSandbox", {
      value: async () => handle,
    });
    const result = createDaytonaAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await expect(result.value.create(openProfile)).rejects.toThrow(/supportsMaxOutputBytes/);
    expect(deleteCalls).toBe(1);
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
