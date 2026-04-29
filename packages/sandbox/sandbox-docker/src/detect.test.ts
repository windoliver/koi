import { describe, expect, test } from "bun:test";
import { detectDocker } from "./detect.js";

describe("detectDocker", () => {
  test("returns available=false when probe returns non-zero", async () => {
    const result = await detectDocker({ probe: async () => 1 });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("docker");
  });

  test("returns available=true when probe exits 0", async () => {
    const result = await detectDocker({ probe: async () => 0 });
    expect(result.available).toBe(true);
  });
});
