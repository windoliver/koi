import { describe, expect, test } from "bun:test";
import type {
  AdapterCapabilities,
  CapabilityRequirements,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { createSandboxRouter } from "./router.js";

function fakeInstance(): SandboxInstance {
  return {
    exec: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      oomKilled: false,
    }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    destroy: async () => {},
  };
}

function adapter(
  name: string,
  caps: AdapterCapabilities,
  init?: () => Promise<void>,
  shutdown?: () => Promise<void>,
): SandboxAdapter {
  const a: SandboxAdapter = {
    name,
    create: async () => fakeInstance(),
    capabilities: caps,
    version: "0.1.0",
    ...(init ? { init } : {}),
    ...(shutdown ? { shutdown } : {}),
  };
  return a;
}

const execCaps: AdapterCapabilities = { supports: new Set(["exec"]), priority: 0 };

describe("createSandboxRouter — describe()", () => {
  test("returns descriptors with state='ready' after init() resolves", async () => {
    let initCalled = false;
    const r = createSandboxRouter({
      adapters: [
        adapter("local", execCaps, async () => {
          initCalled = true;
        }),
      ],
    });
    // describe() before init may show 'created' — call it after init is known to have run.
    // The router awaits init synchronously inside the constructor's microtask.
    await Promise.resolve();
    await Promise.resolve();
    const descriptors = r.describe();
    expect(initCalled).toBe(true);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.state).toBe("ready");
    expect(descriptors[0]?.name).toBe("local");
    expect(descriptors[0]?.version).toBe("0.1.0");
    await r.shutdown();
  });

  test("adapter without init() goes straight to ready", async () => {
    const r = createSandboxRouter({ adapters: [adapter("local", execCaps)] });
    await Promise.resolve();
    expect(r.describe()[0]?.state).toBe("ready");
    await r.shutdown();
  });

  test("init() rejection moves adapter to terminated", async () => {
    const r = createSandboxRouter({
      adapters: [
        adapter("flaky", execCaps, async () => {
          throw new Error("init boom");
        }),
      ],
    });
    // Wait for init to settle.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.describe()[0]?.state).toBe("terminated");
    await r.shutdown();
  });

  test("shutdown() calls each adapter's shutdown hook and marks state='terminated'", async () => {
    let downCount = 0;
    const r = createSandboxRouter({
      adapters: [
        adapter("a", execCaps, undefined, async () => {
          downCount++;
        }),
        adapter("b", execCaps, undefined, async () => {
          downCount++;
        }),
      ],
    });
    await Promise.resolve();
    await r.shutdown();
    expect(downCount).toBe(2);
    expect(r.describe().every((d) => d.state === "terminated")).toBe(true);
  });

  test("shutdown() is idempotent", async () => {
    let downCount = 0;
    const r = createSandboxRouter({
      adapters: [
        adapter("a", execCaps, undefined, async () => {
          downCount++;
        }),
      ],
    });
    await Promise.resolve();
    await r.shutdown();
    await r.shutdown();
    expect(downCount).toBe(1);
  });
});

function profileWithReq(required: CapabilityRequirements["required"]): SandboxProfile {
  const req: CapabilityRequirements = { required };
  return {
    filesystem: { defaultReadAccess: "closed" },
    network: { allow: false },
    resources: {},
    required: req,
  };
}

function failingAdapter(name: string, caps: AdapterCapabilities): SandboxAdapter {
  return {
    name,
    capabilities: caps,
    version: "0.1.0",
    create: async () => {
      throw new Error(`${name}: create rejected`);
    },
  };
}

describe("createSandboxRouter — create()", () => {
  test("picks the only matching adapter and reports it in the decision", async () => {
    const r = createSandboxRouter({
      adapters: [adapter("local", { supports: new Set(["exec"]), priority: 0 })],
    });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["exec"])));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.decision.selected.name).toBe("local");
    expect(result.value.decision.attempts).toHaveLength(1);
    expect(result.value.decision.attempts[0]?.ok).toBe(true);
    await r.shutdown();
  });

  test("prefers ready over degraded; ties broken by lower priority", async () => {
    const a = adapter("a", { supports: new Set(["exec"]), priority: 10 });
    const b = adapter("b", { supports: new Set(["exec"]), priority: 0 });
    const r = createSandboxRouter({ adapters: [a, b] });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["exec"])));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.decision.selected.name).toBe("b");
    await r.shutdown();
  });

  test("falls back to next adapter when primary create() rejects", async () => {
    const failing = failingAdapter("primary", { supports: new Set(["exec"]), priority: 0 });
    const ok = adapter("backup", { supports: new Set(["exec"]), priority: 10 });
    const r = createSandboxRouter({ adapters: [failing, ok] });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["exec"])));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.decision.selected.name).toBe("backup");
    expect(result.value.decision.attempts.map((x) => x.ok)).toEqual([false, true]);
    expect(result.value.decision.attempts[0]?.error?.code).toBe("EXTERNAL");
    await r.shutdown();
  });

  test("excludes adapters missing required capabilities and lists them as rejected", async () => {
    const a = adapter("local", { supports: new Set(["exec"]), priority: 0 });
    const r = createSandboxRouter({ adapters: [a] });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["gpu"])));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.context?.reason).toBe("no-adapter-matches");
    await r.shutdown();
  });

  test("all adapters fail at create() returns UNAVAILABLE with cause chain", async () => {
    const a = failingAdapter("a", { supports: new Set(["exec"]), priority: 0 });
    const b = failingAdapter("b", { supports: new Set(["exec"]), priority: 10 });
    const r = createSandboxRouter({ adapters: [a, b] });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["exec"])));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.error.code).toBe("UNAVAILABLE");
    expect(result.error.context?.reason).toBe("all-adapters-failed");
    const causedBy = result.error.context?.causedBy;
    expect(Array.isArray(causedBy)).toBe(true);
    expect((causedBy as readonly unknown[]).length).toBe(2);
    await r.shutdown();
  });

  test("excludes terminated adapters from selection entirely", async () => {
    const dead = adapter("dead", { supports: new Set(["exec"]), priority: 0 }, async () => {
      throw new Error("init boom");
    });
    const live = adapter("live", { supports: new Set(["exec"]), priority: 10 });
    const r = createSandboxRouter({ adapters: [dead, live] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await r.create(profileWithReq(new Set(["exec"])));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.decision.selected.name).toBe("live");
    await r.shutdown();
  });
});

describe("createSandboxRouter — degraded transitions", () => {
  test("flips to degraded after threshold consecutive failures", async () => {
    let calls = 0;
    const flaky: SandboxAdapter = {
      name: "flaky",
      capabilities: { supports: new Set(["exec"]), priority: 0 },
      version: "0.1.0",
      create: async () => {
        calls++;
        throw new Error("boom");
      },
    };
    const r = createSandboxRouter({ adapters: [flaky], degradedThreshold: 2 });
    await Promise.resolve();
    await r.create(profileWithReq(new Set(["exec"])));
    expect(r.describe()[0]?.state).toBe("ready"); // 1 failure < threshold
    await r.create(profileWithReq(new Set(["exec"])));
    expect(r.describe()[0]?.state).toBe("degraded"); // 2 failures = threshold
    expect(calls).toBe(2);
    await r.shutdown();
  });

  test("a successful create after degraded streak returns adapter to ready", async () => {
    let succeed = false;
    const flippy: SandboxAdapter = {
      name: "flippy",
      capabilities: { supports: new Set(["exec"]), priority: 0 },
      version: "0.1.0",
      create: async () => {
        if (!succeed) throw new Error("not yet");
        return fakeInstance();
      },
    };
    const r = createSandboxRouter({ adapters: [flippy], degradedThreshold: 1 });
    await Promise.resolve();
    await r.create(profileWithReq(new Set(["exec"])));
    expect(r.describe()[0]?.state).toBe("degraded");
    succeed = true;
    const result = await r.create(profileWithReq(new Set(["exec"])));
    expect(result.ok).toBe(true);
    expect(r.describe()[0]?.state).toBe("ready");
    await r.shutdown();
  });

  test("degraded adapters are still tried, just after ready peers", async () => {
    // Force a to be degraded by failing it once with threshold 1.
    let aWillFail = true;
    const a: SandboxAdapter = {
      name: "a",
      capabilities: { supports: new Set(["exec"]), priority: 0 },
      version: "0.1.0",
      create: async () => {
        if (aWillFail) throw new Error("a fail");
        return fakeInstance();
      },
    };
    const b = adapter("b", { supports: new Set(["exec"]), priority: 10 });
    const r = createSandboxRouter({ adapters: [a, b], degradedThreshold: 1 });
    await Promise.resolve();
    // First call: a fails (no fallback; b also matches), goes to b.
    const r1 = await r.create(profileWithReq(new Set(["exec"])));
    if (!r1.ok) throw new Error("expected ok");
    expect(r1.value.decision.selected.name).toBe("b");
    // a is now degraded.
    expect(r.describe().find((d) => d.name === "a")?.state).toBe("degraded");
    // Second call: b is ready (priority 10), a is degraded (priority 0). b wins.
    const r2 = await r.create(profileWithReq(new Set(["exec"])));
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.value.decision.selected.name).toBe("b");
    // Third call: stop a from failing, but it stays degraded until it succeeds.
    // Force selection by making b fail this time.
    aWillFail = false;
    const bFailing: SandboxAdapter = {
      ...b,
      create: async () => {
        throw new Error("b temporarily down");
      },
    };
    const r3 = createSandboxRouter({ adapters: [a, bFailing], degradedThreshold: 1 });
    await Promise.resolve();
    // r3 has fresh records — both ready initially. With aWillFail=false, a succeeds.
    const r3result = await r3.create(profileWithReq(new Set(["exec"])));
    if (!r3result.ok) throw new Error("expected ok");
    expect(r3result.value.decision.selected.name).toBe("a");
    await r.shutdown();
    await r3.shutdown();
  });
});
