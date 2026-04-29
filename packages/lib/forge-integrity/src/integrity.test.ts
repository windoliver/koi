import { describe, expect, test } from "bun:test";
import { computeBrickId } from "@koi/hash";
import { makeTool, reBrandId, tamper } from "./__tests__/fixtures.js";
import { extractBrickContent } from "./extract-content.js";
import { verifyBrickIntegrity } from "./integrity.js";

describe("verifyBrickIntegrity", () => {
  test("artifact hash is deterministic — same content → same id", () => {
    const a = makeTool({ implementation: "export const x = 1" });
    const b = makeTool({ implementation: "export const x = 1" });
    expect(a.id).toBe(b.id);
  });

  test("ok when stored id matches recomputed id", () => {
    const brick = makeTool();
    const result = verifyBrickIntegrity(brick);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("content_mismatch when implementation has been tampered", () => {
    const original = makeTool();
    const tampered = tamper(original);
    const result = verifyBrickIntegrity(tampered);
    expect(result.kind).toBe("content_mismatch");
    expect(result.ok).toBe(false);
    if (result.kind === "content_mismatch") {
      expect(result.expectedId).toBe(original.id);
      expect(result.actualId).not.toBe(original.id);
    }
  });

  test("content_mismatch when stored id does not match content", () => {
    const brick = reBrandId(makeTool(), "0".repeat(64));
    const result = verifyBrickIntegrity(brick);
    expect(result.kind).toBe("content_mismatch");
  });
});

describe("extractBrickContent", () => {
  test("tool extracts implementation", () => {
    const brick = makeTool({ implementation: "code" });
    expect(extractBrickContent(brick)).toEqual({ kind: "tool", content: "code" });
  });

  test("hash matches @koi/hash for the same content", () => {
    const brick = makeTool({ implementation: "code" });
    const expected = computeBrickId("tool", "code");
    expect(brick.id).toBe(expected);
  });
});
