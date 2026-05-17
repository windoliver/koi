// End-to-end integration: drives executeScript / execute_script tool through a
// real subprocess SandboxExecutor (@koi/sandbox-executor) — no mocks. Covers
// the corner cases the unit tests with mocks can't reach: real transpile +
// spawn, real timeout classification, real CRASH on script throw, real input
// pass-through across the IPC boundary.
//
// Opt-out portability: requireProcessGroupIsolation=false so macOS hosts
// without `setsid` can still run these tests.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubprocessExecutor } from "@koi/sandbox-executor";
import { executeScript } from "../execute-script.js";
import { createExecuteScriptTool } from "../execute-script-tool.js";

function executor(): ReturnType<typeof createSubprocessExecutor> {
  return createSubprocessExecutor({ requireProcessGroupIsolation: false });
}

describe("code-executor — integration with @koi/sandbox-executor", () => {
  test("plain JS: arithmetic returns through subprocess", async () => {
    const r = await executeScript({ code: "return 1 + 2;", executor: executor() });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(3);
  });

  test("TypeScript: type annotations stripped, value returns", async () => {
    const r = await executeScript({
      code: "const x: number = 42; return x * 2;",
      language: "typescript",
      executor: executor(),
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(84);
  });

  test("await inside script resolves before result", async () => {
    const r = await executeScript({
      code: "await new Promise((res) => setTimeout(res, 5)); return 'done';",
      executor: executor(),
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("done");
  });

  test("input is passed through to the script body", async () => {
    const r = await executeScript({
      code: "return input.a + input.b;",
      input: { a: 19, b: 23 },
      executor: executor(),
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(42);
  });

  test("primitive input is passed through verbatim", async () => {
    const r = await executeScript({ code: "return input + 1;", input: 41, executor: executor() });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(42);
  });

  test("script throw surfaces as CRASH error with the message", async () => {
    const r = await executeScript({
      code: "throw new Error('boom');",
      executor: executor(),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("CRASH");
    expect(r.error?.message).toContain("boom");
  });

  test("infinite loop is killed by deadline and reported as TIMEOUT", async () => {
    const r = await executeScript({
      code: "while (true) {}",
      timeoutMs: 250,
      executor: executor(),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TIMEOUT");
  });

  test("invalid TS does not spawn a subprocess and returns TRANSPILE", async () => {
    // Track that the underlying executor is not invoked.
    let called = 0;
    const wrapped = {
      execute: (...args: Parameters<ReturnType<typeof executor>["execute"]>) => {
        called++;
        return executor().execute(...args);
      },
    };
    const r = await executeScript({
      code: "const x: = ;",
      language: "typescript",
      executor: wrapped,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TRANSPILE");
    expect(called).toBe(0);
  });

  test("non-JSON-serialisable return surfaces as a typed sandbox error (not a hang)", async () => {
    // BigInt cannot cross the worker -> host boundary as JSON. The subprocess
    // executor must classify this as a CRASH (or similar typed code) — never
    // return ok=true with a missing value, and never time out.
    const r = await executeScript({
      code: "return BigInt(1);",
      timeoutMs: 5_000,
      executor: executor(),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).not.toBe("TIMEOUT");
  });

  test("execute_script tool fails closed with plain subprocess executor", async () => {
    const tool = createExecuteScriptTool({
      executor: createSubprocessExecutor({
        externalIsolation: true,
        filesystemIsolation: true,
        requireProcessGroupIsolation: false,
      }),
    });
    const r = (await tool.execute({ code: "return 1 + 1;" })) as {
      ok: boolean;
      error?: { code?: string };
    };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("PERMISSION");
  });

  test("execute_script tool forwards workspace read policy but plain subprocess refuses it", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "koi-execute-script-ws-"));
    try {
      writeFileSync(join(workspacePath, "input.txt"), "workspace-data", "utf8");
      const tool = createExecuteScriptTool({
        workspacePath,
        executor: createSubprocessExecutor({
          externalIsolation: true,
          filesystemIsolation: true,
          requireProcessGroupIsolation: false,
        }),
      });
      const r = (await tool.execute({
        code: "return await Bun.file('input.txt').text();",
      })) as { ok: boolean; error?: { code?: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("PERMISSION");
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("execute_script tool fails closed when subprocess isolation is not asserted", async () => {
    const tool = createExecuteScriptTool({ executor: executor() });
    const r = (await tool.execute({ code: "return 1 + 1;" })) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("PERMISSION");
  });

  test("execute_script tool: missing 'code' arg validates without spawning", async () => {
    const tool = createExecuteScriptTool({ executor: executor() });
    const r = (await tool.execute({})) as { ok: boolean; error?: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("VALIDATION");
  });

  test("execute_script tool: unsupported language validates without spawning", async () => {
    const tool = createExecuteScriptTool({ executor: executor() });
    const r = (await tool.execute({ code: "print('hi')", language: "python" })) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("VALIDATION");
  });
});
