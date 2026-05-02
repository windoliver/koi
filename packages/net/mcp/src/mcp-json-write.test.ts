import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addServerToMcpJson, removeServerFromMcpJson, saveMcpJsonFile } from "./mcp-json-write.js";

function tmpFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-json-"));
  return {
    path: join(dir, ".mcp.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("saveMcpJsonFile", () => {
  test("writes valid mcp.json from a record", async () => {
    const { path, cleanup } = tmpFile();
    try {
      const result = await saveMcpJsonFile(path, {
        mcpServers: { foo: { type: "http", url: "https://x" } },
      });
      expect(result.ok).toBe(true);
      const text = await Bun.file(path).text();
      expect(JSON.parse(text)).toEqual({
        mcpServers: { foo: { type: "http", url: "https://x" } },
      });
    } finally {
      cleanup();
    }
  });

  test("creates parent directory if missing", async () => {
    const { path, cleanup } = tmpFile();
    try {
      const nested = join(path, "..", "nested", ".mcp.json");
      const result = await saveMcpJsonFile(nested, { mcpServers: {} });
      expect(result.ok).toBe(true);
      const text = await Bun.file(nested).text();
      expect(JSON.parse(text)).toEqual({ mcpServers: {} });
    } finally {
      cleanup();
    }
  });
});

describe("addServerToMcpJson", () => {
  test("adds an entry to a fresh file", async () => {
    const { path, cleanup } = tmpFile();
    try {
      const result = await addServerToMcpJson(path, "foo", { type: "http", url: "https://x" });
      expect(result.ok).toBe(true);
      const file = JSON.parse(await Bun.file(path).text()) as {
        mcpServers: Record<string, unknown>;
      };
      expect(file.mcpServers.foo).toEqual({ type: "http", url: "https://x" });
    } finally {
      cleanup();
    }
  });

  test("preserves existing entries when adding a new one", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(
        path,
        JSON.stringify({
          mcpServers: { existing: { type: "stdio", command: "x" } },
        }),
      );
      const result = await addServerToMcpJson(path, "foo", { type: "http", url: "https://x" });
      expect(result.ok).toBe(true);
      const file = JSON.parse(await Bun.file(path).text()) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(file.mcpServers).sort()).toEqual(["existing", "foo"]);
    } finally {
      cleanup();
    }
  });

  test("preserves unknown top-level fields (forward compatible)", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(
        path,
        JSON.stringify({
          $schema: "https://example.com/schema.json",
          mcpServers: {},
          customSetting: "preserved",
        }),
      );
      await addServerToMcpJson(path, "foo", { type: "http", url: "https://x" });
      const file = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
      expect(file.$schema).toBe("https://example.com/schema.json");
      expect(file.customSetting).toBe("preserved");
    } finally {
      cleanup();
    }
  });

  test("returns CONFLICT when server already exists", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(
        path,
        JSON.stringify({ mcpServers: { foo: { type: "stdio", command: "x" } } }),
      );
      const result = await addServerToMcpJson(path, "foo", { type: "http", url: "https://x" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("CONFLICT");
    } finally {
      cleanup();
    }
  });

  test("overwrites when overwrite: true", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(
        path,
        JSON.stringify({ mcpServers: { foo: { type: "stdio", command: "x" } } }),
      );
      const result = await addServerToMcpJson(
        path,
        "foo",
        { type: "http", url: "https://x" },
        { overwrite: true },
      );
      expect(result.ok).toBe(true);
      const file = JSON.parse(await Bun.file(path).text()) as {
        mcpServers: Record<string, unknown>;
      };
      expect(file.mcpServers.foo).toEqual({ type: "http", url: "https://x" });
    } finally {
      cleanup();
    }
  });
});

describe("concurrent writes (file lock)", () => {
  test("two parallel addServerToMcpJson calls do not lose entries", async () => {
    const { path, cleanup } = tmpFile();
    try {
      const calls = Array.from({ length: 8 }, (_, i) =>
        addServerToMcpJson(path, `server-${i}`, { type: "http", url: `https://${i}.x` }),
      );
      const results = await Promise.all(calls);
      for (const r of results) expect(r.ok).toBe(true);

      const file = JSON.parse(await Bun.file(path).text()) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(file.mcpServers).sort()).toEqual([
        "server-0",
        "server-1",
        "server-2",
        "server-3",
        "server-4",
        "server-5",
        "server-6",
        "server-7",
      ]);
    } finally {
      cleanup();
    }
  });

  test("interleaved add + remove operations remain consistent", async () => {
    const { path, cleanup } = tmpFile();
    try {
      // Seed.
      await addServerToMcpJson(path, "keep", { type: "stdio", command: "x" });
      // Race adds against a removal of the same name.
      const tasks: Array<Promise<unknown>> = [];
      for (let i = 0; i < 5; i++) {
        tasks.push(addServerToMcpJson(path, `s-${i}`, { type: "http", url: `https://${i}.x` }));
      }
      tasks.push(removeServerFromMcpJson(path, "keep"));
      await Promise.all(tasks);

      const file = JSON.parse(await Bun.file(path).text()) as {
        mcpServers: Record<string, unknown>;
      };
      // All 5 adds must be present; "keep" must be gone.
      const keys = Object.keys(file.mcpServers).sort();
      expect(keys).toContain("s-0");
      expect(keys).toContain("s-1");
      expect(keys).toContain("s-2");
      expect(keys).toContain("s-3");
      expect(keys).toContain("s-4");
      expect(keys).not.toContain("keep");
    } finally {
      cleanup();
    }
  });
});

describe("removeServerFromMcpJson", () => {
  test("removes an existing entry", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(
        path,
        JSON.stringify({
          mcpServers: {
            foo: { type: "http", url: "https://x" },
            bar: { type: "stdio", command: "y" },
          },
        }),
      );
      const result = await removeServerFromMcpJson(path, "foo");
      expect(result.ok).toBe(true);
      const file = JSON.parse(await Bun.file(path).text()) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(file.mcpServers)).toEqual(["bar"]);
    } finally {
      cleanup();
    }
  });

  test("returns NOT_FOUND when server is absent", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(path, JSON.stringify({ mcpServers: {} }));
      const result = await removeServerFromMcpJson(path, "ghost");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("NOT_FOUND");
    } finally {
      cleanup();
    }
  });

  test("returns NOT_FOUND when file is absent", async () => {
    const { path, cleanup } = tmpFile();
    try {
      const result = await removeServerFromMcpJson(path, "ghost");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("NOT_FOUND");
    } finally {
      cleanup();
    }
  });
});
