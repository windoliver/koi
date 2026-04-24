import { describe, expect, it } from "bun:test";
import { computeGrantKey } from "./grant-key.js";

describe("computeGrantKey", () => {
  it("returns a stable 64-char hex digest", () => {
    const key = computeGrantKey("tool_call", { tool: "bash", cmd: "ls" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order-independent on object keys", () => {
    const a = computeGrantKey("tool_call", { tool: "bash", cmd: "ls" });
    const b = computeGrantKey("tool_call", { cmd: "ls", tool: "bash" });
    expect(a).toBe(b);
  });

  it("is order-sensitive on arrays", () => {
    const a = computeGrantKey("tool_call", { args: ["a", "b"] });
    const b = computeGrantKey("tool_call", { args: ["b", "a"] });
    expect(a).not.toBe(b);
  });

  it("distinguishes kind", () => {
    const payload = { tool: "bash" };
    expect(computeGrantKey("tool_call", payload)).not.toBe(computeGrantKey("model_call", payload));
  });
});
