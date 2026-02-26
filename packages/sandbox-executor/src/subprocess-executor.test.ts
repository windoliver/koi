/**
 * Tests for subprocess-based promoted executor.
 *
 * Creates real temp files and spawns actual child processes to verify
 * process-level isolation, timeout handling, and error classification.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext } from "@koi/core";
import {
  buildIsolatedCommand,
  createSubprocessExecutor,
  detectSandboxPlatform,
  shellEscape,
} from "./subprocess-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `subprocess-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

async function writeEntry(name: string, code: string): Promise<string> {
  const filePath = join(TEST_DIR, `${name}.ts`);
  await writeFile(filePath, code, "utf8");
  return filePath;
}

function ctx(entryPath: string, overrides?: Partial<ExecutionContext>): ExecutionContext {
  return { entryPath, workspacePath: TEST_DIR, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSubprocessExecutor", () => {
  const executor = createSubprocessExecutor();

  // --- Fallback: new Function() (no entry file) ---

  test("fallback: executes simple code via new Function()", async () => {
    const result = await executor.execute("return 42;", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(42);
    }
  });

  test("fallback: passes input to function", async () => {
    const result = await executor.execute("return input.x + input.y;", { x: 3, y: 7 }, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(10);
    }
  });

  test("fallback: classifies throw as CRASH", async () => {
    const result = await executor.execute('throw new Error("boom");', {}, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toBe("boom");
    }
  });

  // --- Subprocess: runs in child process ---

  test("subprocess: executes default export from entry file", async () => {
    const entryPath = await writeEntry(
      "add",
      "export default function run(input: { x: number; y: number }) { return input.x + input.y; }",
    );
    const result = await executor.execute("", { x: 10, y: 20 }, 10_000, ctx(entryPath));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(30);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("subprocess: handles async default export", async () => {
    const entryPath = await writeEntry(
      "async-add",
      "export default async function run(input: { val: number }) { return input.val * 3; }",
    );
    const result = await executor.execute("", { val: 7 }, 10_000, ctx(entryPath));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(21);
    }
  });

  test("subprocess: returns error when module has no default export", async () => {
    const entryPath = await writeEntry("no-default", "export function notDefault() { return 42; }");
    const result = await executor.execute("", {}, 10_000, ctx(entryPath));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toContain("default function");
    }
  });

  test("subprocess: returns error when brick throws", async () => {
    const entryPath = await writeEntry(
      "throwing",
      'export default function run() { throw new Error("subprocess boom"); }',
    );
    const result = await executor.execute("", {}, 10_000, ctx(entryPath));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toContain("subprocess boom");
    }
  });

  test("subprocess: returns error when entry file doesn't exist", async () => {
    const badPath = join(TEST_DIR, "nonexistent.ts");
    const result = await executor.execute("", {}, 10_000, ctx(badPath));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
    }
  });

  test("subprocess: isolates environment variables", async () => {
    const entryPath = await writeEntry(
      "env-check",
      "export default function run() { return { hasApiKey: process.env.ANTHROPIC_API_KEY !== undefined, hasHome: process.env.HOME !== undefined }; }",
    );
    // Set a sensitive var in current process
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-secret";

    const result = await executor.execute("", {}, 10_000, ctx(entryPath));

    // Restore
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value.output as { hasApiKey: boolean; hasHome: boolean };
      expect(output.hasApiKey).toBe(false); // API key NOT forwarded
      expect(output.hasHome).toBe(true); // HOME is in safe list
    }
  });

  test("subprocess: returns JSON-serializable output", async () => {
    const entryPath = await writeEntry(
      "json-output",
      'export default function run() { return { name: "test", count: 42, items: [1, 2, 3] }; }',
    );
    const result = await executor.execute("", {}, 10_000, ctx(entryPath));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ name: "test", count: 42, items: [1, 2, 3] });
    }
  });

  test("subprocess: timeout kills the child process", async () => {
    const entryPath = await writeEntry(
      "slow-brick",
      "export default async function run() { await new Promise(r => setTimeout(r, 30_000)); return 'done'; }",
    );
    const result = await executor.execute("", {}, 500, ctx(entryPath));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Process was killed — error might be TIMEOUT or CRASH depending on signal
      expect(["TIMEOUT", "CRASH"]).toContain(result.error.code);
      expect(result.error.durationMs).toBeLessThan(5_000);
    }
  });

  // --- Network isolation (macOS only, skipped on other platforms) ---

  test("subprocess: executes normally with networkAllowed=true", async () => {
    const entryPath = await writeEntry(
      "net-allowed",
      "export default function run(input: { val: number }) { return input.val * 2; }",
    );
    const result = await executor.execute(
      "",
      { val: 5 },
      10_000,
      ctx(entryPath, { networkAllowed: true }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(10);
    }
  });

  test("subprocess: executes normally with networkAllowed=false (no fetch)", async () => {
    const entryPath = await writeEntry(
      "net-denied-nofetch",
      "export default function run(input: { val: number }) { return input.val + 1; }",
    );
    const result = await executor.execute(
      "",
      { val: 9 },
      10_000,
      ctx(entryPath, { networkAllowed: false }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Network isolation integration test (macOS Seatbelt)
// ---------------------------------------------------------------------------

describe("subprocess: network isolation integration", () => {
  const executor = createSubprocessExecutor();
  const platform = detectSandboxPlatform();

  test.skipIf(platform !== "seatbelt")(
    "fetch fails when networkAllowed=false on macOS",
    async () => {
      const entryPath = await writeEntry(
        "net-denied-fetch",
        `export default async function run() {
  try {
    await fetch("https://example.com");
    return { fetched: true };
  } catch (e: unknown) {
    return { fetched: false, error: e instanceof Error ? e.message : String(e) };
  }
}`,
      );
      const result = await executor.execute(
        "",
        {},
        15_000,
        ctx(entryPath, { networkAllowed: false }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const output = result.value.output as { fetched: boolean; error?: string };
        expect(output.fetched).toBe(false);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// buildIsolatedCommand unit tests
// ---------------------------------------------------------------------------

describe("buildIsolatedCommand", () => {
  test("passthrough when no isolation needed", () => {
    const result = buildIsolatedCommand(["bun", "run", "script.ts"]);
    expect(result.cmd).toEqual(["bun", "run", "script.ts"]);
    expect(result.platform).toBe("none");
  });

  test("passthrough when networkAllowed is true and no limits", () => {
    const result = buildIsolatedCommand(["bun", "run", "script.ts"], {
      networkAllowed: true,
    });
    expect(result.cmd).toEqual(["bun", "run", "script.ts"]);
    expect(result.platform).toBe("none");
  });

  test("passthrough when networkAllowed is undefined and no limits", () => {
    const result = buildIsolatedCommand(["bun", "run", "script.ts"], {});
    expect(result.cmd).toEqual(["bun", "run", "script.ts"]);
    expect(result.platform).toBe("none");
  });

  test("wraps with isolation when networkAllowed=false", () => {
    const result = buildIsolatedCommand(["bun", "run", "script.ts"], {
      networkAllowed: false,
    });
    const platform = detectSandboxPlatform();

    if (platform === "seatbelt") {
      expect(result.cmd[0]).toBe("sandbox-exec");
      expect(result.cmd).toContain("-p");
      expect(result.platform).toBe("seatbelt");
    } else if (platform === "bwrap") {
      expect(result.cmd[0]).toBe("bwrap");
      expect(result.cmd).toContain("--unshare-net");
      expect(result.platform).toBe("bwrap");
    } else {
      // No sandbox — passthrough with degraded flag
      expect(result.platform).toBe("none");
      expect(result.degraded).toBe(true);
    }
  });

  test("sets degraded=true when network deny requested but no sandbox", () => {
    const platform = detectSandboxPlatform();
    if (platform === "none") {
      const result = buildIsolatedCommand(["bun", "run", "script.ts"], {
        networkAllowed: false,
      });
      expect(result.degraded).toBe(true);
    } else {
      // Platform has sandbox — degraded should be undefined/falsy
      const result = buildIsolatedCommand(["bun", "run", "script.ts"], {
        networkAllowed: false,
      });
      expect(result.degraded).toBeFalsy();
    }
  });

  test("includes ulimit -v when maxMemoryMb is set", () => {
    const result = buildIsolatedCommand(["bun", "run", "script.ts"], {
      resourceLimits: { maxMemoryMb: 256 },
    });
    // Should wrap in sh -c with ulimit prefix
    const cmdStr = result.cmd.join(" ");
    expect(cmdStr).toContain("ulimit -v 262144"); // 256 * 1024
  });

  test("includes both network deny and resource limits", () => {
    const result = buildIsolatedCommand(["bun", "run", "script.ts"], {
      networkAllowed: false,
      resourceLimits: { maxMemoryMb: 128 },
    });
    const cmdStr = result.cmd.join(" ");
    expect(cmdStr).toContain("ulimit -v 131072"); // 128 * 1024

    const platform = detectSandboxPlatform();
    if (platform === "seatbelt") {
      expect(result.cmd[0]).toBe("sandbox-exec");
    } else if (platform === "bwrap") {
      expect(result.cmd[0]).toBe("bwrap");
    }
  });
});

// ---------------------------------------------------------------------------
// shellEscape unit tests
// ---------------------------------------------------------------------------

describe("shellEscape", () => {
  test("wraps simple string in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  test("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  test("handles path with spaces", () => {
    expect(shellEscape("/path/to/my file.ts")).toBe("'/path/to/my file.ts'");
  });
});

// ---------------------------------------------------------------------------
// detectSandboxPlatform unit tests
// ---------------------------------------------------------------------------

describe("detectSandboxPlatform", () => {
  test("returns a valid platform string", () => {
    const platform = detectSandboxPlatform();
    expect(["seatbelt", "bwrap", "none"]).toContain(platform);
  });

  test("returns seatbelt on macOS", () => {
    if (process.platform === "darwin") {
      expect(detectSandboxPlatform()).toBe("seatbelt");
    }
  });

  test("returns consistent result on repeated calls", () => {
    const first = detectSandboxPlatform();
    const second = detectSandboxPlatform();
    expect(first).toBe(second);
  });
});
