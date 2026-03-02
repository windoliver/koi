import { describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import type { WorkspaceInfo } from "@koi/core";
import { workspaceId } from "@koi/core";
import { makeTempDir } from "@koi/test-utils";
import { createShellSetup } from "./shell-setup.js";

function makeWorkspace(path: string): WorkspaceInfo {
  return {
    id: workspaceId("test-ws-1"),
    path,
    createdAt: Date.now(),
    metadata: {},
  };
}

describe("createShellSetup", () => {
  it("throws on empty command", () => {
    expect(() => createShellSetup("")).toThrow("non-empty string");
  });

  it("throws on command with null byte", () => {
    expect(() => createShellSetup("echo\0evil")).toThrow("null bytes");
  });

  it("returns a function for valid command", () => {
    const hook = createShellSetup("echo", ["hello"]);
    expect(typeof hook).toBe("function");
  });

  it("executes command in workspace directory", async () => {
    const dir = await makeTempDir();
    try {
      const hook = createShellSetup("touch", ["setup-marker.txt"]);
      await hook(makeWorkspace(dir));

      const { existsSync } = await import("node:fs");
      expect(existsSync(`${dir}/setup-marker.txt`)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws on non-zero exit code", async () => {
    const dir = await makeTempDir();
    try {
      const hook = createShellSetup("false");
      await expect(hook(makeWorkspace(dir))).rejects.toThrow("Shell setup");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
