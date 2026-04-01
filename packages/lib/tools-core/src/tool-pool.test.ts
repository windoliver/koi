import { describe, expect, test } from "bun:test";
import type { Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { assembleToolPool } from "./tool-pool.js";

function fakeTool(name: string, origin: "primordial" | "operator" | "forged" = "operator"): Tool {
  return {
    descriptor: {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object" },
      origin,
    },
    origin,
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async () => "ok",
  };
}

describe("assembleToolPool", () => {
  test("returns tools sorted alphabetically by name", () => {
    const tools = [fakeTool("zebra"), fakeTool("alpha"), fakeTool("middle")];
    const pool = assembleToolPool(tools);
    expect(pool.map((t) => t.descriptor.name)).toEqual(["alpha", "middle", "zebra"]);
  });

  test("deduplicates by name — primordial wins over operator", () => {
    const tools = [fakeTool("dup", "operator"), fakeTool("dup", "primordial")];
    const pool = assembleToolPool(tools);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.origin).toBe("primordial");
  });

  test("deduplicates by name — operator wins over forged", () => {
    const tools = [fakeTool("dup", "forged"), fakeTool("dup", "operator")];
    const pool = assembleToolPool(tools);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.origin).toBe("operator");
  });

  test("deduplicates by name — primordial wins over forged", () => {
    const tools = [fakeTool("dup", "forged"), fakeTool("dup", "primordial")];
    const pool = assembleToolPool(tools);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.origin).toBe("primordial");
  });

  test("keeps first occurrence on same-origin tie", () => {
    const first = fakeTool("dup", "operator");
    const second = fakeTool("dup", "operator");
    const pool = assembleToolPool([first, second]);
    expect(pool).toHaveLength(1);
    expect(pool[0]).toBe(first);
  });

  test("returns empty array for empty input", () => {
    const pool = assembleToolPool([]);
    expect(pool).toEqual([]);
  });

  test("does not mutate the input array", () => {
    const tools = [fakeTool("b"), fakeTool("a")];
    const original = [...tools];
    assembleToolPool(tools);
    expect(tools).toEqual(original);
  });
});
