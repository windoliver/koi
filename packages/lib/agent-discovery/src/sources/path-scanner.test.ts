import { describe, expect, test } from "bun:test";
import type { KnownCliAgent, SystemCalls } from "../types.js";
import { createPathSource } from "./path-scanner.js";

function fakeSc(map: Record<string, string>): SystemCalls {
  return {
    which: async (b) => map[b] ?? null,
    readDir: async () => [],
    readFile: async () => "",
    spawn: async () => ({ stdout: "", exitCode: 0 }),
  };
}

describe("createPathSource", () => {
  test("returns descriptors for known agents whose binary resolves", async () => {
    const source = createPathSource({
      systemCalls: fakeSc({ claude: "/usr/local/bin/claude" }),
    });
    const r = await source.discover();
    expect(r.length).toBe(1);
    expect(r[0]?.name).toBe("claude-code");
    expect(r[0]?.command).toBe("claude");
    expect(r[0]?.transport).toBe("cli");
    expect(r[0]?.source).toBe("path");
    expect(r[0]?.healthy).toBe(true);
  });

  test("skips agents whose binary does not resolve", async () => {
    const source = createPathSource({ systemCalls: fakeSc({}) });
    expect((await source.discover()).length).toBe(0);
  });

  test("tries multiple binaries per agent — first hit wins", async () => {
    const customAgents: readonly KnownCliAgent[] = [
      {
        name: "multi",
        binaries: ["primary", "fallback"],
        capabilities: [],
        transport: "cli",
      },
    ];
    const source = createPathSource({
      knownAgents: customAgents,
      systemCalls: fakeSc({ fallback: "/usr/bin/fallback" }),
    });
    const r = await source.discover();
    expect(r.length).toBe(1);
    expect(r[0]?.command).toBe("fallback");
  });

  test("custom knownAgents replaces default list", async () => {
    const source = createPathSource({
      knownAgents: [{ name: "only", binaries: ["only"], capabilities: [], transport: "cli" }],
      systemCalls: fakeSc({ only: "/x", claude: "/y" }),
    });
    const r = await source.discover();
    expect(r.length).toBe(1);
    expect(r[0]?.name).toBe("only");
  });

  test("source id is 'path' and priority follows SOURCE_PRIORITY", async () => {
    const source = createPathSource({ systemCalls: fakeSc({}) });
    expect(source.id).toBe("path");
    expect(source.priority).toBe(2);
  });
});
