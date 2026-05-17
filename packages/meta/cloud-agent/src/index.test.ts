import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalHandler, FileSystemBackend, ModelAdapter } from "@koi/core";
import { toolToken } from "@koi/core";
import { type CloudSandboxExecutor, createCloudRuntime } from "./index.js";

function makeModelAdapter(): ModelAdapter {
  return {
    id: "stub-cloud",
    provider: "stub",
    capabilities: {
      streaming: true,
      functionCalling: true,
      vision: false,
      jsonMode: false,
      maxContextTokens: 8192,
      maxOutputTokens: 4096,
    },
    complete: mock(async () => ({ content: "", model: "stub" })),
    stream: mock(async function* () {}),
  };
}

const approvalHandler: ApprovalHandler = async () => ({ kind: "allow" });

function sandboxExecutor(): CloudSandboxExecutor {
  return {
    sandboxCapabilities: {
      network: "enforced",
      resources: "enforced",
      filesystem: "enforced",
      process: "enforced",
    },
    execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }),
  };
}

function fsBackend(): FileSystemBackend {
  return {
    name: "cloud-test-fs",
    read: async () => ({ ok: true, value: { path: "", content: "", size: 0 } }),
    write: async () => ({ ok: true, value: { path: "", bytesWritten: 0 } }),
    edit: async () => ({ ok: true, value: { path: "", hunksApplied: 0 } }),
    list: async () => ({ ok: true, value: { entries: [], truncated: false } }),
    search: async () => ({ ok: true, value: { matches: [], truncated: false } }),
    delete: async (path) => ({ ok: true, value: { path } }),
    rename: async (from, to) => ({ ok: true, value: { from, to } }),
  };
}

const dirs: string[] = [];

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "koi-cloud-runtime-"));
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
  dirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createCloudRuntime", () => {
  test("rejects sandbox executors without backend capability metadata", async () => {
    const executor = {
      execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }),
    };
    await expect(
      createCloudRuntime({
        modelAdapter: makeModelAdapter(),
        modelName: "stub-model",
        approvalHandler,
        sandboxExecutor: executor as never,
        filesystem: fsBackend(),
        cwd: makeCwd(),
      }),
    ).rejects.toThrow("must expose enforced network");
  });

  test("assembles with a stub sandbox executor and injected filesystem backend", async () => {
    const handle = await createCloudRuntime({
      modelAdapter: makeModelAdapter(),
      modelName: "stub-model",
      approvalHandler,
      sandboxExecutor: sandboxExecutor(),
      filesystem: fsBackend(),
      cwd: makeCwd(),
    });
    try {
      const tool = handle.runtime.agent.component(toolToken("execute_script"));
      expect(tool).toBeUndefined();
      expect(handle.runtime.agent.component(toolToken("Bash"))).toBeUndefined();
      expect(handle.runtime.agent.component(toolToken("bash_background"))).toBeUndefined();
      expect(handle.runtime.agent.component(toolToken("web_fetch"))).toBeUndefined();
      expect(handle.runtime.agent.component(toolToken("Glob"))).toBeUndefined();
      expect(handle.runtime.agent.component(toolToken("Grep"))).toBeUndefined();
      expect(handle.runtime.agent.component(toolToken("ToolSearch"))).toBeUndefined();
      expect(handle.runtime.agent.component(toolToken("fs_write"))).toBeUndefined();
      expect(handle.runtime.agent.component(toolToken("fs_edit"))).toBeUndefined();
      expect(handle.runtime.agent.component(toolToken("fs_read"))).toBeUndefined();
      expect(handle.sandboxRequired).toBe(true);
    } finally {
      await handle.runtime.dispose();
    }
  });

  test("exposes execute_script only with an explicit sandbox workspace mount", async () => {
    const cwd = makeCwd();
    const handle = await createCloudRuntime({
      modelAdapter: makeModelAdapter(),
      modelName: "stub-model",
      approvalHandler,
      sandboxExecutor: sandboxExecutor(),
      filesystem: fsBackend(),
      cwd,
      sandboxWorkspacePath: cwd,
    });
    try {
      const tool = handle.runtime.agent.component(toolToken("execute_script"));
      expect(tool?.policy.sandbox).toBe(true);
    } finally {
      await handle.runtime.dispose();
    }
  });

  test("rejects sandbox workspace mounts outside the tenant root", async () => {
    const cwd = makeCwd();
    await expect(
      createCloudRuntime({
        modelAdapter: makeModelAdapter(),
        modelName: "stub-model",
        approvalHandler,
        sandboxExecutor: sandboxExecutor(),
        filesystem: fsBackend(),
        cwd,
        sandboxWorkspacePath: tmpdir(),
      }),
    ).rejects.toThrow("sandboxWorkspacePath must be contained");
  });

  test("requires an approved root before enabling execute_script", async () => {
    await expect(
      createCloudRuntime({
        modelAdapter: makeModelAdapter(),
        modelName: "stub-model",
        approvalHandler,
        sandboxExecutor: sandboxExecutor(),
        filesystem: fsBackend(),
        sandboxWorkspacePath: tmpdir(),
      }),
    ).rejects.toThrow("sandboxWorkspaceRoot or cwd is required");
  });

  test("rejects sandbox workspace mounts that escape through symlinks", async () => {
    const cwd = makeCwd();
    const outside = mkdtempSync(join(tmpdir(), "koi-cloud-outside-"));
    dirs.push(outside);
    const linkPath = join(cwd, "linked-outside");
    symlinkSync(outside, linkPath);

    await expect(
      createCloudRuntime({
        modelAdapter: makeModelAdapter(),
        modelName: "stub-model",
        approvalHandler,
        sandboxExecutor: sandboxExecutor(),
        filesystem: fsBackend(),
        cwd,
        sandboxWorkspacePath: linkPath,
      }),
    ).rejects.toThrow("sandboxWorkspacePath must be contained");
  });
});
