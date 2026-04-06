/**
 * Integration tests: security defaults in createRuntime().
 *
 * Verifies that the exfiltration guard middleware and credential path guard
 * are wired into the production runtime by default, with opt-out via config.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FileSystemBackend, JsonObject, Tool } from "@koi/core";
import { createCredentialPathGuard } from "@koi/tools-builtin";
import { createFileSystemTools } from "../create-filesystem-provider.js";
import { createRuntime } from "../create-runtime.js";
import { resolveFileSystem } from "../resolve-filesystem.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpBase = mkdtempSync(join(tmpdir(), "koi-security-defaults-"));

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function createLocalBackend(): FileSystemBackend {
  return resolveFileSystem({ backend: "local" }, tmpBase);
}

/** Get a tool from the map or throw (test-only convenience). */
function getTool(tools: ReadonlyMap<string, Tool>, name: string): Tool {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`Tool "${name}" not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// Fix 2: Credential path guard
// ---------------------------------------------------------------------------

describe("credential path guard in filesystem tools", () => {
  const pathGuard = createCredentialPathGuard();

  test("fs_read with guard rejects ~/.ssh/id_rsa", async () => {
    const backend = createLocalBackend();
    const fsTools = createFileSystemTools(backend, "fs", ["read", "write", "edit"], { pathGuard });
    const readTool = getTool(fsTools.tools, "fs_read");

    const sshPath = resolve(homedir(), ".ssh/id_rsa");
    const result = await readTool.execute({ path: sshPath } as JsonObject);
    const output = result as Record<string, unknown>;
    expect(output.code).toBe("CREDENTIAL_PATH_DENIED");
    expect(String(output.error)).toContain("SSH keys");
  });

  test("fs_write with guard rejects ~/.aws/credentials", async () => {
    const backend = createLocalBackend();
    const fsTools = createFileSystemTools(backend, "fs", ["read", "write", "edit"], { pathGuard });
    const writeTool = getTool(fsTools.tools, "fs_write");

    const awsPath = resolve(homedir(), ".aws/credentials");
    const result = await writeTool.execute({
      path: awsPath,
      content: "malicious",
    } as JsonObject);
    const output = result as Record<string, unknown>;
    expect(output.code).toBe("CREDENTIAL_PATH_DENIED");
    expect(String(output.error)).toContain("AWS");
  });

  test("fs_edit with guard rejects ~/.docker/config.json", async () => {
    const backend = createLocalBackend();
    const fsTools = createFileSystemTools(backend, "fs", ["read", "write", "edit"], { pathGuard });
    const editTool = getTool(fsTools.tools, "fs_edit");

    const dockerPath = resolve(homedir(), ".docker/config.json");
    const result = await editTool.execute({
      path: dockerPath,
      edits: [{ old_text: "a", new_text: "b" }],
    } as JsonObject);
    const output = result as Record<string, unknown>;
    expect(output.code).toBe("CREDENTIAL_PATH_DENIED");
    expect(String(output.error)).toContain("Docker");
  });

  test("non-credential paths with guard pass through normally", async () => {
    const backend = createLocalBackend();
    await backend.write("test.txt", "hello");

    const fsTools = createFileSystemTools(backend, "fs", ["read"], { pathGuard });
    const readTool = getTool(fsTools.tools, "fs_read");

    const result = await readTool.execute({ path: "test.txt" } as JsonObject);
    const output = result as Record<string, unknown>;
    expect(output.code).toBeUndefined();
    expect(output.content).toBe("hello");
  });

  test("tools without guard do not block credential paths", async () => {
    const backend = createLocalBackend();
    const fsTools = createFileSystemTools(backend, "fs", ["read"]);
    const readTool = getTool(fsTools.tools, "fs_read");

    const sshPath = resolve(homedir(), ".ssh/id_rsa");
    const result = await readTool.execute({ path: sshPath } as JsonObject);
    const output = result as Record<string, unknown>;
    expect(output.code).not.toBe("CREDENTIAL_PATH_DENIED");
  });

  test("createRuntime wires credential guard by default when filesystem enabled", () => {
    const runtime = createRuntime({
      filesystem: { backend: "local" },
      cwd: tmpBase,
    });
    expect(runtime.filesystemBackend).toBeDefined();
    expect(runtime.filesystemProvider).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fix 1: Exfiltration guard wired by default
// ---------------------------------------------------------------------------

describe("exfiltration guard in runtime", () => {
  function createAdapterWithTerminals(): import("@koi/core").EngineAdapter {
    return {
      engineId: "test-terminals",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(): AsyncIterable<import("@koi/core").EngineEvent> {
        yield {
          kind: "done",
          output: {
            content: [{ kind: "text", text: "ok" }],
            stopReason: "completed",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
          },
        };
      },
      terminals: {
        modelCall: async () => ({
          content: "ok",
          model: "test",
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
        toolCall: async (req) => ({ toolId: req.toolId, output: "ok" }),
      },
    };
  }

  test("runtime with terminals includes exfiltration-guard middleware by default", () => {
    const runtime = createRuntime({ adapter: createAdapterWithTerminals() });
    const names = runtime.middleware.map((mw) => mw.name);
    expect(names).toContain("exfiltration-guard");
  });

  test("stub adapter (no terminals) does not include exfiltration guard", () => {
    const runtime = createRuntime();
    const names = runtime.middleware.map((mw) => mw.name);
    expect(names).not.toContain("exfiltration-guard");
  });

  test("exfiltrationGuard: false excludes it even with terminals", () => {
    const runtime = createRuntime({
      adapter: createAdapterWithTerminals(),
      exfiltrationGuard: false,
    });
    const names = runtime.middleware.map((mw) => mw.name);
    expect(names).not.toContain("exfiltration-guard");
  });

  test("caller-provided exfiltration-guard is not doubled", () => {
    const customGuard = {
      name: "exfiltration-guard",
      phase: "intercept" as const,
      priority: 50,
      wrapModelCall: async (
        _ctx: unknown,
        request: unknown,
        next: (req: unknown) => Promise<unknown>,
      ) => next(request),
      wrapToolCall: async (
        _ctx: unknown,
        request: unknown,
        next: (req: unknown) => Promise<unknown>,
      ) => next(request),
      describeCapabilities: () => undefined,
    };
    const runtime = createRuntime({
      adapter: createAdapterWithTerminals(),
      middleware: [customGuard as import("@koi/core").KoiMiddleware],
      requestApproval: async () => ({ kind: "allow" as const }),
    });
    const guardCount = runtime.middleware.filter((mw) => mw.name === "exfiltration-guard").length;
    expect(guardCount).toBe(1);
  });

  test("exfiltration guard has correct priority and phase", () => {
    const runtime = createRuntime({ adapter: createAdapterWithTerminals() });
    const guard = runtime.middleware.find((mw) => mw.name === "exfiltration-guard");
    expect(guard).toBeDefined();
    if (guard === undefined) return;
    expect(guard.priority).toBe(50);
    expect(guard.phase).toBe("intercept");
  });
});
