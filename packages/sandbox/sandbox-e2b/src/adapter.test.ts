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
    const err = await result.value.create(openProfile).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/kill\(\)/);
    // The per-attempt label MUST appear so operators can locate the
    // orphan via the same recovery workflow used for ambiguous create
    // failures. Without it, the leak is anonymous.
    expect((err as Error).message).toMatch(/koi-[0-9a-f-]{36}/);
  });

  test("create() bounds provisioning and surfaces label on stalled createSandbox", async () => {
    // Degraded-provider regression: control plane never responds. A
    // create() that hangs forever blocks callers and hides the label
    // operators need to find any orphan microVM. The adapter must time
    // out, surface the label, and tell operators how to recover.
    const client = createFakeClient();
    Object.defineProperty(client, "createSandbox", {
      value: () => new Promise(() => {}), // hangs forever
    });
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const start = performance.now();
    const err = await result.value.create(openProfile).catch((e: unknown) => e as Error);
    const elapsed = performance.now() - start;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/INDETERMINATE/);
    expect((err as Error).message).toMatch(/koi-[0-9a-f-]{36}/);
    expect(elapsed).toBeLessThan(35_000);
  }, 40_000);

  test("create() aborts the provider call on local timeout (no orphan pile-up on retries)", async () => {
    // Cancellable-create regression: without aborting the in-flight
    // SDK call, repeated caller retries during a control-plane hang
    // would accumulate background creates, each potentially
    // materializing a billable orphan microVM.
    const client = createFakeClient();
    let observedAborted = false;
    Object.defineProperty(client, "createSandbox", {
      value: (opts: import("./types.js").E2bCreateOpts) =>
        new Promise<typeof client.sandbox>((_, reject) => {
          opts.signal?.addEventListener("abort", () => {
            observedAborted = true;
            reject(new Error("aborted by adapter"));
          });
        }),
    });
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    const err = await result.value.create(openProfile).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/INDETERMINATE/);
    // Give the abort handler a tick to observe the signal.
    await new Promise((r) => setTimeout(r, 50));
    expect(observedAborted).toBe(true);
  }, 40_000);

  test("create() reconciles a late-arriving handle after timeout (best-effort kill)", async () => {
    // Late-cleanup regression: when the local 30 s timeout fires but
    // the SDK eventually returns a handle anyway, the adapter must
    // best-effort kill the orphan microVM rather than leak a billable
    // resource. Without the reconciler, retries during a control-plane
    // latency spike would accumulate orphans.
    const client = createFakeClient();
    const handle = client.sandbox;
    let killCalls = 0;
    let resolveCreate!: (sdk: typeof handle) => void;
    const lateHandle = {
      ...handle,
      kill: async (): Promise<void> => {
        killCalls++;
      },
    };
    Object.defineProperty(client, "createSandbox", {
      value: () =>
        new Promise<typeof handle>((r) => {
          resolveCreate = r;
        }),
    });
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    // Override the timeout via a much shorter wait — but the timeout
    // constant is internal. So instead, we resolve the promise BEFORE
    // the timeout, after first observing the create() rejection by
    // racing it against a local timeout shorter than the adapter's.
    // Simpler approach: hand the promise back, time out create() by
    // letting 30s pass is too long — so we replace setTimeout?
    // Pragmatic: shrink the test by manually triggering: launch
    // create(), don't await; resolve `resolveCreate` after the 30s
    // adapter timeout. That makes the test 30s+ which is over the
    // default. Allow 35s.
    const createPromise = result.value.create(openProfile);
    // Wait for the adapter timeout to fire and surface the
    // INDETERMINATE error, THEN resolve the late createSandbox promise.
    // The reconciler attached during the timeout path observes the
    // late resolution and best-effort kills the orphan.
    const err = await createPromise.catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/INDETERMINATE/);
    resolveCreate(lateHandle);
    // Give the late-cleanup .then a tick to fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(killCalls).toBe(1);
  }, 40_000);

  test("create() postflights files.readBytes and tears down handles without binary read", async () => {
    // Without readBytes, every readFile() would hard-fail after the
    // microVM is already billed. Postflight catches this at create.
    const client = createFakeClient();
    const original = client.sandbox;
    let killCalls = 0;
    const { readBytes: _omitRead, ...filesNoReadBytes } = original.files;
    const handle = {
      ...original,
      files: filesNoReadBytes,
      kill: async (): Promise<void> => {
        killCalls++;
      },
    };
    Object.defineProperty(client, "createSandbox", {
      value: async () => handle,
    });
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await expect(result.value.create(openProfile)).rejects.toThrow(/files\.readBytes/);
    expect(killCalls).toBe(1);
  });

  test("create() postflights files.writeBytes and tears down handles without binary write", async () => {
    const client = createFakeClient();
    const original = client.sandbox;
    let killCalls = 0;
    const { writeBytes: _omitWrite, ...filesNoWriteBytes } = original.files;
    const handle = {
      ...original,
      files: filesNoWriteBytes,
      kill: async (): Promise<void> => {
        killCalls++;
      },
    };
    Object.defineProperty(client, "createSandbox", {
      value: async () => handle,
    });
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await expect(result.value.create(openProfile)).rejects.toThrow(/files\.writeBytes/);
    expect(killCalls).toBe(1);
  });

  test("create() postflights supportsMaxOutputBytes and tears down unusable handles", async () => {
    // Skew regression: an SDK whose handle lacks supportsMaxOutputBytes=true
    // would let create() return a billable sandbox where every exec()
    // hard-fails. Postflight catches this and tears down the just-
    // provisioned remote resource before any caller can use it.
    const client = createFakeClient();
    const original = client.sandbox;
    let killCalls = 0;
    const handle = {
      ...original,
      commands: { ...original.commands, supportsMaxOutputBytes: false },
      kill: async (): Promise<void> => {
        killCalls++;
      },
    };
    Object.defineProperty(client, "createSandbox", {
      value: async () => handle,
    });
    const result = createE2bAdapter({ apiKey: "k", client });
    if (!result.ok) throw new Error("validate failed");
    await expect(result.value.create(openProfile)).rejects.toThrow(/supportsMaxOutputBytes/);
    // The just-provisioned sandbox must be best-effort killed so the
    // capability gap doesn't leak a billable resource.
    expect(killCalls).toBe(1);
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
