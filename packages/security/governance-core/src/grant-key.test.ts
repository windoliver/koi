import { describe, expect, it } from "bun:test";
import { computeGrantKey } from "./grant-key.js";

describe("computeGrantKey", () => {
  it("produces a 64-char hex SHA-256 digest", () => {
    const key = computeGrantKey("tool_call", { toolId: "shell", input: { cmd: "ls" } });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across object key order", () => {
    const a = computeGrantKey("tool_call", { a: 1, b: 2, c: { x: 10, y: 20 } });
    const b = computeGrantKey("tool_call", { c: { y: 20, x: 10 }, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order", () => {
    const a = computeGrantKey("tool_call", { items: [1, 2, 3] });
    const b = computeGrantKey("tool_call", { items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it("differentiates by kind", () => {
    const payload = { toolId: "shell", input: { cmd: "ls" } };
    expect(computeGrantKey("tool_call", payload)).not.toBe(computeGrantKey("model_call", payload));
  });

  it("differentiates by payload", () => {
    expect(computeGrantKey("tool_call", { input: { cmd: "ls" } })).not.toBe(
      computeGrantKey("tool_call", { input: { cmd: "rm" } }),
    );
  });

  it("handles null values consistently", () => {
    const a = computeGrantKey("tool_call", { x: null });
    const b = computeGrantKey("tool_call", { x: null });
    expect(a).toBe(b);
  });

  it("sorts keys in objects nested inside arrays", () => {
    const a = computeGrantKey("tool_call", { items: [{ b: 2, a: 1 }] });
    const b = computeGrantKey("tool_call", { items: [{ a: 1, b: 2 }] });
    expect(a).toBe(b);
  });

  it("treats undefined properties as absent", () => {
    const a = computeGrantKey("tool_call", { x: 1, y: undefined as unknown as never });
    const b = computeGrantKey("tool_call", { x: 1 });
    expect(a).toBe(b);
  });
});
