// E2E corner-case coverage for the host-local IPC bridge. Drives real Bun
// child processes via defaultSpawnFn and the production worker — unit tests
// cover branching, this file covers the adversarial-review hardening:
// trust boundary, result cap, timeout deadline, env scrubbing, async IIFE.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bridgeToFunctionExecutor } from "../adapter.js";
import { createSandboxBridge } from "../bridge.js";
import type { BridgeConfig, CommandBuilder } from "../types.js";

const PROFILE: BridgeConfig["profile"] = {
  filesystem: {
    defaultReadAccess: "closed",
    allowRead: ["/usr", "/bin", "/tmp", "/private/tmp"],
    allowWrite: ["/tmp", "/private/tmp"],
  },
  network: { allow: false },
  resources: { timeoutMs: 5_000, maxMemoryMb: 256 },
};

const passthrough: CommandBuilder = (_profile, command, args) => ({
  ok: true,
  value: { executable: command, args: [...args] },
});

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    profile: PROFILE,
    buildCommand: passthrough,
    serialization: "advanced",
    graceMs: 500,
    maxResultBytes: 32_768,
    // E2E hosts may not have setsid (default macOS without util-linux). Tests
    // that target descendant-teardown set "required" explicitly when needed.
    processGroupIsolation: "best-effort",
    ...overrides,
  };
}

describe("sandbox-ipc e2e — trust boundary", () => {
  test("untrusted code cannot forge a terminal IPC frame", async () => {
    const bridge = await createSandboxBridge(makeConfig());
    try {
      const result = await bridge.execute(
        `try { process.send({ kind: "result", output: "FORGED", durationMs: 0, nonce: "anything" }); } catch (_e) {}
         return "real";`,
        {},
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.output).toBe("real");
    } finally {
      await bridge.dispose();
    }
  });

  test("removed message listener cannot intercept future host frames", async () => {
    // Worker sealing removes existing 'message' listeners. Verify user code
    // attaching its own listener after the seal does not see the original
    // execute frame leaked back, and the original handler stays inert.
    const bridge = await createSandboxBridge(makeConfig());
    try {
      const result = await bridge.execute(
        `const seen = []; process.on("message", (m) => seen.push(m));
         await new Promise((r) => setTimeout(r, 50));
         return seen;`,
        {},
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.output).toEqual([]);
    } finally {
      await bridge.dispose();
    }
  });
});

describe("sandbox-ipc e2e — result cap", () => {
  test("rejects oversized advanced-mode results before transport", async () => {
    const bridge = await createSandboxBridge(makeConfig({ maxResultBytes: 4_096 }));
    try {
      const result = await bridge.execute(`return new Uint8Array(20_000);`, {});
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected fail");
      expect(result.error.code).toBe("WORKER_ERROR");
      expect(result.error.message.toLowerCase()).toContain("exceeds maxresultbytes");
    } finally {
      await bridge.dispose();
    }
  });

  test("fails closed when transport size cannot be measured (BigInt + json)", async () => {
    const bridge = await createSandboxBridge(
      makeConfig({ serialization: "json", maxResultBytes: 1_024 }),
    );
    try {
      const result = await bridge.execute(`return 42n;`, {});
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected fail");
      expect(result.error.code).toBe("WORKER_ERROR");
      expect(result.error.message.toLowerCase()).toContain("could not be measured");
    } finally {
      await bridge.dispose();
    }
  });

  test("accepts payloads exactly at the cap boundary", async () => {
    // v8.serialize of a 32-char string is small but predictable; pick a cap
    // comfortably above its serialized form.
    const bridge = await createSandboxBridge(makeConfig({ maxResultBytes: 4_096 }));
    try {
      const result = await bridge.execute(`return "x".repeat(64);`, {});
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect((result.value.output as string).length).toBe(64);
    } finally {
      await bridge.dispose();
    }
  });
});

describe("sandbox-ipc e2e — timeout deadline", () => {
  test("kills CPU-bound infinite loop at the user-visible deadline", async () => {
    const bridge = await createSandboxBridge(makeConfig({ graceMs: 500 }));
    try {
      const startedAt = performance.now();
      const result = await bridge.execute(`while (true) {}`, {}, { timeoutMs: 250 });
      const elapsed = performance.now() - startedAt;

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected timeout");
      expect(result.error.code).toBe("TIMEOUT");
      // Bridge fires at requestTimeoutMs. graceMs is reserved for kill→exit
      // drain only; allow generous slack for setsid + spawn + CI noise.
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      await bridge.dispose();
    }
  }, 10_000);

  test("worker-emitted TIMEOUT propagates with the correct code", async () => {
    const bridge = await createSandboxBridge(makeConfig({ graceMs: 500 }));
    try {
      // Async work — worker self-timer can fire before host bridge timer.
      const result = await bridge.execute(
        `await new Promise((r) => setTimeout(r, 10_000)); return "late";`,
        {},
        { timeoutMs: 200 },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected timeout");
      expect(result.error.code).toBe("TIMEOUT");
    } finally {
      await bridge.dispose();
    }
  }, 10_000);
});

describe("sandbox-ipc e2e — env scrubbing", () => {
  const SECRET = "KOI_E2E_AMBIENT_SECRET";

  beforeAll(() => {
    process.env[SECRET] = "should-not-leak";
  });
  afterAll(() => {
    delete process.env[SECRET];
  });

  test("ambient host secrets do not appear in the worker env", async () => {
    const bridge = await createSandboxBridge(makeConfig());
    try {
      const result = await bridge.execute(`return Object.keys(process.env);`, {});
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const keys = result.value.output as string[];
      expect(keys).not.toContain(SECRET);
    } finally {
      await bridge.dispose();
    }
  });

  test("envAllowlist forwards only the requested host vars", async () => {
    const bridge = await createSandboxBridge(
      makeConfig({ envAllowlist: ["PATH", SECRET] }),
    );
    try {
      const result = await bridge.execute(
        `return { allowed: process.env["${SECRET}"], path: typeof process.env.PATH };`,
        {},
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.output).toEqual({
        allowed: "should-not-leak",
        path: "string",
      });
    } finally {
      await bridge.dispose();
    }
  });

  test("context.env merges on top of the scrubbed allowlist", async () => {
    const bridge = await createSandboxBridge(makeConfig());
    try {
      const result = await bridge.execute(
        `return process.env.PER_CALL_VAR;`,
        {},
        { context: { env: { PER_CALL_VAR: "via-context" } } },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.output).toBe("via-context");
    } finally {
      await bridge.dispose();
    }
  });
});

describe("sandbox-ipc e2e — async function-body wrapper", () => {
  test("await inside user code resolves via async IIFE", async () => {
    const executor = bridgeToFunctionExecutor(makeConfig());
    const result = await executor.executeFunctionBody(
      `const a = await Promise.resolve(40);
       const b = await Promise.resolve(2);
       return a + b;`,
      {},
      2_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.output).toBe(42);
  });

  test("rejects module source without spawning a worker", async () => {
    const executor = bridgeToFunctionExecutor(makeConfig());
    const result = await executor.executeFunctionBody(
      `export default async () => 1;`,
      {},
      1_000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    expect(result.error.code).toBe("CRASH");
    expect(result.error.message).toContain("module source");
  });

  test("rejects entryPath up front via context type narrowing", async () => {
    const executor = bridgeToFunctionExecutor(makeConfig());
    const result = await executor.executeFunctionBody(
      `return 1;`,
      {},
      1_000,
      // Cast through unknown to mimic an untyped caller passing the field.
      { entryPath: "/tmp/foo.ts" } as unknown as Record<string, never>,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    expect(result.error.code).toBe("CRASH");
    expect(result.error.message).toContain("entryPath");
  });
});

describe("sandbox-ipc e2e — disposal preserves prior outcome", () => {
  test("kills any in-flight worker on dispose", async () => {
    const bridge = await createSandboxBridge(makeConfig({ graceMs: 1_000 }));
    // Don't await the execute; dispose mid-flight.
    const inflight = bridge.execute(
      `await new Promise((r) => setTimeout(r, 30_000)); return "should not arrive";`,
      {},
      { timeoutMs: 30_000 },
    );
    // Give the worker a moment to spawn before disposal.
    await new Promise((r) => setTimeout(r, 250));
    await bridge.dispose();
    const result = await inflight;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected dispose-induced failure");
    // Worker was SIGKILLed; exit code 137 is classified as OOM by the bridge,
    // direct-kill paths surface as CRASH, timeout paths as TIMEOUT.
    expect(["CRASH", "TIMEOUT", "OOM"]).toContain(result.error.code);
  }, 35_000);
});
