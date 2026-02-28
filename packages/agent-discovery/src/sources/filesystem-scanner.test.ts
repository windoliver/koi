import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemSource } from "./filesystem-scanner.js";

// let justified: mutable temp dir ref for setup/teardown
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "koi-fs-scanner-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createFilesystemSource", () => {
  it("reads valid JSON descriptors from directory", async () => {
    const descriptor = {
      name: "test-agent",
      transport: "cli",
      capabilities: ["code-generation"],
      command: "test-cmd",
      displayName: "Test Agent",
    };
    await Bun.write(join(tempDir, "test-agent.json"), JSON.stringify(descriptor));

    const source = createFilesystemSource(tempDir);
    const results = await source.discover();

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("test-agent");
    expect(results[0]?.transport).toBe("cli");
    expect(results[0]?.source).toBe("filesystem");
    expect(results[0]?.command).toBe("test-cmd");
    expect(results[0]?.displayName).toBe("Test Agent");
  });

  it("returns empty array for missing directory", async () => {
    const source = createFilesystemSource("/nonexistent/path/that/does/not/exist");
    const results = await source.discover();

    expect(results).toHaveLength(0);
  });

  it("returns empty array for empty directory", async () => {
    const source = createFilesystemSource(tempDir);
    const results = await source.discover();

    expect(results).toHaveLength(0);
  });

  it("skips invalid JSON files and reports via onSkip", async () => {
    await Bun.write(join(tempDir, "bad.json"), "not valid json {{{");
    const skipped: string[] = [];

    const source = createFilesystemSource({
      registryDir: tempDir,
      onSkip: (filepath, reason) => {
        skipped.push(`${filepath}: ${reason}`);
      },
    });
    const results = await source.discover();

    expect(results).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("Failed to read or parse");
  });

  it("skips descriptors with missing required fields", async () => {
    const invalid = { name: "no-transport" };
    await Bun.write(join(tempDir, "invalid.json"), JSON.stringify(invalid));
    const skipped: string[] = [];

    const source = createFilesystemSource({
      registryDir: tempDir,
      onSkip: (filepath, reason) => {
        skipped.push(`${filepath}: ${reason}`);
      },
    });
    const results = await source.discover();

    expect(results).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("Missing required fields");
  });

  it("skips descriptors with invalid transport", async () => {
    const invalid = { name: "bad-transport", transport: "pigeon", capabilities: [] };
    await Bun.write(join(tempDir, "invalid.json"), JSON.stringify(invalid));

    const source = createFilesystemSource(tempDir);
    const results = await source.discover();

    expect(results).toHaveLength(0);
  });

  it("handles mixed valid and invalid files", async () => {
    const valid = { name: "good", transport: "cli", capabilities: ["test"] };
    const invalid = { name: 123 };
    await Bun.write(join(tempDir, "good.json"), JSON.stringify(valid));
    await Bun.write(join(tempDir, "bad.json"), JSON.stringify(invalid));

    const source = createFilesystemSource(tempDir);
    const results = await source.discover();

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("good");
  });

  it("ignores non-JSON files", async () => {
    await Bun.write(join(tempDir, "readme.txt"), "not a json file");
    const valid = { name: "only-json", transport: "mcp", capabilities: [] };
    await Bun.write(join(tempDir, "only-json.json"), JSON.stringify(valid));

    const source = createFilesystemSource(tempDir);
    const results = await source.discover();

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("only-json");
  });

  it("includes metadata when present", async () => {
    const descriptor = {
      name: "with-meta",
      transport: "a2a",
      capabilities: ["test"],
      metadata: { version: "2.0", url: "https://example.com" },
    };
    await Bun.write(join(tempDir, "with-meta.json"), JSON.stringify(descriptor));

    const source = createFilesystemSource(tempDir);
    const results = await source.discover();

    expect(results[0]?.metadata).toEqual({ version: "2.0", url: "https://example.com" });
  });

  it("has name 'filesystem'", () => {
    const source = createFilesystemSource(tempDir);
    expect(source.name).toBe("filesystem");
  });

  it("throws on non-ENOENT directory errors", async () => {
    // Use a file as the "directory" to trigger ENOTDIR, not ENOENT
    const filePath = join(tempDir, "not-a-dir");
    await Bun.write(filePath, "data");

    const source = createFilesystemSource(filePath);

    await expect(source.discover()).rejects.toThrow("Failed to read registry directory");
  });
});
