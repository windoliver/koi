import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemTool } from "./filesystem.js";

describe("filesystem tool", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "koi-fs-test-"));
    await Bun.write(join(testDir, "hello.txt"), "Hello, World!");
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("has correct descriptor", () => {
    const tool = createFilesystemTool();
    expect(tool.descriptor.name).toBe("filesystem");
    expect(tool.policy.sandbox).toBe(false);
  });

  it("reads a file", async () => {
    const tool = createFilesystemTool([testDir]);
    const result = (await tool.execute({ action: "read", path: join(testDir, "hello.txt") })) as {
      content: string;
    };
    expect(result.content).toBe("Hello, World!");
  });

  it("returns error for non-existent file", async () => {
    const tool = createFilesystemTool([testDir]);
    const result = (await tool.execute({
      action: "read",
      path: join(testDir, "nope.txt"),
    })) as { error: string };
    expect(result.error).toContain("not found");
  });

  it("writes a file", async () => {
    const tool = createFilesystemTool([testDir]);
    const writePath = join(testDir, "written.txt");
    const result = (await tool.execute({
      action: "write",
      path: writePath,
      content: "test content",
    })) as { written: boolean };
    expect(result.written).toBe(true);

    const content = await Bun.file(writePath).text();
    expect(content).toBe("test content");
  });

  it("lists a directory", async () => {
    const tool = createFilesystemTool([testDir]);
    const result = (await tool.execute({ action: "list", path: testDir })) as {
      entries: string[];
      count: number;
    };
    expect(result.entries).toContain("hello.txt");
    expect(result.count).toBeGreaterThan(0);
  });

  it("rejects paths outside allowed directories", async () => {
    const tool = createFilesystemTool([testDir]);
    const result = (await tool.execute({ action: "read", path: "/etc/passwd" })) as {
      error: string;
    };
    expect(result.error).toContain("Path access denied");
  });

  it("returns error for unknown action", async () => {
    const tool = createFilesystemTool([testDir]);
    const result = (await tool.execute({ action: "delete", path: testDir })) as {
      error: string;
    };
    expect(result.error).toContain("Unknown action");
  });

  it("returns error for missing arguments", async () => {
    const tool = createFilesystemTool([testDir]);
    const result = (await tool.execute({})) as { error: string };
    expect(result.error).toContain("Invalid arguments");
  });

  it("returns error for write without content", async () => {
    const tool = createFilesystemTool([testDir]);
    const result = (await tool.execute({
      action: "write",
      path: join(testDir, "no-content.txt"),
    })) as { error: string };
    expect(result.error).toContain("content");
  });
});
