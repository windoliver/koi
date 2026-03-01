import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core";
import { createDedupedToolsAccessor } from "./deduped-tools-accessor.js";

function descriptor(name: string, description = `Tool: ${name}`): ToolDescriptor {
  return { name, description, inputSchema: {} };
}

describe("createDedupedToolsAccessor", () => {
  test("returns entity-only when forge descriptors empty", () => {
    const entity = [descriptor("a"), descriptor("b")];
    const accessor = createDedupedToolsAccessor(entity);

    const result = accessor.get();
    expect(result).toBe(entity); // same ref — zero allocation
  });

  test("merges forge + entity, forge first", () => {
    const entity = [descriptor("entity-tool")];
    const accessor = createDedupedToolsAccessor(entity);

    accessor.updateForged([descriptor("forged-tool")]);
    const result = accessor.get();

    expect(result.map((d) => d.name)).toEqual(["forged-tool", "entity-tool"]);
  });

  test("deduplicates by name (forge wins)", () => {
    const entity = [descriptor("shared", "Entity version")];
    const accessor = createDedupedToolsAccessor(entity);

    accessor.updateForged([descriptor("shared", "Forged version")]);
    const result = accessor.get();

    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("Forged version");
  });

  test("ref-stability: same forge ref returns same output array ref", () => {
    const entity = [descriptor("a")];
    const accessor = createDedupedToolsAccessor(entity);

    const forged = [descriptor("b")];
    accessor.updateForged(forged);

    const first = accessor.get();
    const second = accessor.get();
    expect(first).toBe(second); // same ref — memoized
  });
});
