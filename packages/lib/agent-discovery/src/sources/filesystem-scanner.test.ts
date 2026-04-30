import { describe, expect, test } from "bun:test";
import type { SystemCalls } from "../types.js";
import { createFilesystemSource } from "./filesystem-scanner.js";

function fakeSc(files: Record<string, string>): SystemCalls {
  return {
    which: async () => null,
    readDir: async () => Object.keys(files),
    readFile: async (path) => {
      for (const [name, content] of Object.entries(files)) {
        if (path.endsWith(name)) return content;
      }
      throw new Error(`ENOENT: ${path}`);
    },
    spawn: async () => ({ stdout: "", exitCode: 0 }),
  };
}

describe("createFilesystemSource", () => {
  test("reads valid JSON files into descriptors", async () => {
    const source = createFilesystemSource({
      registryDir: "/agents",
      systemCalls: fakeSc({
        "a.json": JSON.stringify({
          name: "custom",
          transport: "cli",
          capabilities: ["x"],
          command: "/usr/local/bin/custom",
        }),
      }),
    });
    const r = await source.discover();
    expect(r.length).toBe(1);
    expect(r[0]?.name).toBe("custom");
    expect(r[0]?.source).toBe("filesystem");
  });

  test("missing dir returns empty array (not throw)", async () => {
    const source = createFilesystemSource({
      registryDir: "/nope",
      systemCalls: {
        ...fakeSc({}),
        readDir: async () => {
          throw new Error("ENOENT");
        },
      },
    });
    expect((await source.discover()).length).toBe(0);
  });

  test("invalid JSON is skipped and onSkip is called", async () => {
    const skipped: string[] = [];
    const source = createFilesystemSource({
      registryDir: "/x",
      systemCalls: fakeSc({ "bad.json": "not json {" }),
      onSkip: (path, reason) => skipped.push(`${path}: ${reason}`),
    });
    expect((await source.discover()).length).toBe(0);
    expect(skipped.length).toBe(1);
  });

  test("missing required fields are skipped", async () => {
    const skipped: string[] = [];
    const source = createFilesystemSource({
      registryDir: "/x",
      systemCalls: fakeSc({ "x.json": JSON.stringify({ transport: "cli" }) }),
      onSkip: (path, reason) => skipped.push(`${path}: ${reason}`),
    });
    expect((await source.discover()).length).toBe(0);
    expect(skipped.length).toBe(1);
  });

  test("path traversal in registryDir is rejected", () => {
    expect(() =>
      createFilesystemSource({
        registryDir: "/safe/../etc",
        systemCalls: fakeSc({}),
      }),
    ).toThrow(/VALIDATION|traversal/i);
  });

  test("source id is 'filesystem' and priority follows SOURCE_PRIORITY", () => {
    const source = createFilesystemSource({
      registryDir: "/x",
      systemCalls: fakeSc({}),
    });
    expect(source.id).toBe("filesystem");
    expect(source.priority).toBe(1);
  });
});
