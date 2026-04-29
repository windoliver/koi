import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickId } from "@koi/core";
import { brickId } from "@koi/core";
import { makeTool, reBrandId, recomputeFixtureId, tamper } from "./__tests__/fixtures.js";
import { verifyBrickIntegrity } from "./integrity.js";

describe("verifyBrickIntegrity", () => {
  test("artifact hash is deterministic — same content → same recomputed id", () => {
    const a = makeTool({ implementation: "export const x = 1" });
    const b = makeTool({ implementation: "export const x = 1" });
    expect(recomputeFixtureId(a)).toBe(recomputeFixtureId(b));
    expect(a.id).toBe(b.id);
  });

  test("ok when stored id matches recomputed id", () => {
    const result = verifyBrickIntegrity(makeTool(), recomputeFixtureId);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("content_mismatch when implementation has been tampered", () => {
    const original = makeTool();
    const result = verifyBrickIntegrity(tamper(original), recomputeFixtureId);
    expect(result.kind).toBe("content_mismatch");
    expect(result.ok).toBe(false);
    if (result.kind === "content_mismatch") {
      expect(result.expectedId).toBe(original.id);
      expect(result.actualId).not.toBe(original.id);
    }
  });

  test("content_mismatch when stored id does not match content", () => {
    const brick = reBrandId(makeTool(), "0".repeat(64));
    const result = verifyBrickIntegrity(brick, recomputeFixtureId);
    expect(result.kind).toBe("content_mismatch");
  });

  test("recompute_failed surfaces caller-thrown errors as a typed result", () => {
    const brick = makeTool();
    const failing = (_b: BrickArtifact): BrickId => {
      throw new Error("identity scheme requires agentId");
    };
    const result = verifyBrickIntegrity(brick, failing);
    expect(result.kind).toBe("recompute_failed");
    if (result.kind === "recompute_failed") {
      expect(result.reason).toContain("agentId");
    }
  });

  test("delegates entirely to caller-supplied recompute (no built-in scheme)", () => {
    const brick = makeTool({ implementation: "anything" });
    const constantRecompute = (_b: BrickArtifact): BrickId => brick.id;
    const result = verifyBrickIntegrity(reBrandId(brick, "f".repeat(64)), constantRecompute);
    expect(result.kind).toBe("content_mismatch");
    if (result.kind === "content_mismatch") {
      expect(result.actualId).toBe(brick.id);
      expect(result.expectedId).toBe(brickId(`sha256:${"f".repeat(64)}`));
    }
  });
});
