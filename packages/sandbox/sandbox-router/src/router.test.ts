import { describe, expect, test } from "bun:test";
import type { AdapterCapabilities, SandboxAdapter, SandboxInstance } from "@koi/core";
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
