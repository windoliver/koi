import { describe, expect, test } from "bun:test";
import { brickId } from "@koi/core";
import {
  computeBrickId,
  computeCompositeBrickId,
  computePipelineBrickId,
  isBrickId,
} from "./brick-id.js";

/** Regex for the canonical BrickId format: `sha256:<64-hex-chars>`. */
const BRICK_ID_RE = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// computeBrickId
// ---------------------------------------------------------------------------

describe("computeBrickId", () => {
  test("same kind + content produces same BrickId (deterministic)", () => {
    const a = computeBrickId("tool", "console.log('hello')");
    const b = computeBrickId("tool", "console.log('hello')");
    expect(a).toBe(b);
  });

  test("different content produces different BrickId", () => {
    const a = computeBrickId("tool", "alpha");
    const b = computeBrickId("tool", "beta");
    expect(a).not.toBe(b);
  });

  test("same content + different kind produces different BrickId (cross-kind isolation)", () => {
    const a = computeBrickId("tool", "shared content");
    const b = computeBrickId("skill", "shared content");
    expect(a).not.toBe(b);
  });

  test("result matches sha256:<64-hex> format", () => {
    const id = computeBrickId("tool", "test");
    expect(id).toMatch(BRICK_ID_RE);
  });

  test("files affect hash (same content, different files = different ID)", () => {
    const withoutFiles = computeBrickId("tool", "body");
    const withFiles = computeBrickId("tool", "body", { "index.ts": "code" });
    expect(withoutFiles).not.toBe(withFiles);
  });

  test("different file contents produce different IDs", () => {
    const a = computeBrickId("tool", "body", { "index.ts": "v1" });
    const b = computeBrickId("tool", "body", { "index.ts": "v2" });
    expect(a).not.toBe(b);
  });

  test("file key order does not affect hash (sorted internally)", () => {
    const a = computeBrickId("tool", "body", { b: "2", a: "1" });
    const b = computeBrickId("tool", "body", { a: "1", b: "2" });
    expect(a).toBe(b);
  });

  test("unicode content produces valid BrickId", () => {
    const id = computeBrickId("tool", "const name = '工具-名前-도구'");
    expect(id).toMatch(BRICK_ID_RE);
  });

  test("emoji content produces valid BrickId", () => {
    const id = computeBrickId("tool", "const emoji = '🤖🔥'");
    expect(id).toMatch(BRICK_ID_RE);
  });

  test("empty content produces valid BrickId", () => {
    const id = computeBrickId("tool", "");
    expect(id).toMatch(BRICK_ID_RE);
  });

  test("empty files record does not change hash vs undefined files", () => {
    const withUndefined = computeBrickId("tool", "body");
    const withEmpty = computeBrickId("tool", "body", {});
    // Empty record still calls feedFiles which iterates zero keys,
    // so the hash should be identical to no-files.
    expect(withUndefined).toBe(withEmpty);
  });
});

// ---------------------------------------------------------------------------
// computeCompositeBrickId
// ---------------------------------------------------------------------------

describe("computeCompositeBrickId", () => {
  const childA = brickId("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const childB = brickId("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  test("order-independent: [a,b] and [b,a] produce same BrickId", () => {
    const ab = computeCompositeBrickId([childA, childB]);
    const ba = computeCompositeBrickId([childB, childA]);
    expect(ab).toBe(ba);
  });

  test("result matches sha256:<64-hex> format", () => {
    const id = computeCompositeBrickId([childA, childB]);
    expect(id).toMatch(BRICK_ID_RE);
  });

  test("different children produce different BrickId", () => {
    const childC = brickId(
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    const ab = computeCompositeBrickId([childA, childB]);
    const ac = computeCompositeBrickId([childA, childC]);
    expect(ab).not.toBe(ac);
  });

  test("files affect composite hash", () => {
    const withoutFiles = computeCompositeBrickId([childA]);
    const withFiles = computeCompositeBrickId([childA], {
      "meta.json": '{"v":1}',
    });
    expect(withoutFiles).not.toBe(withFiles);
  });

  test("empty children array produces valid BrickId", () => {
    const id = computeCompositeBrickId([]);
    expect(id).toMatch(BRICK_ID_RE);
  });

  test("single child produces valid BrickId", () => {
    const id = computeCompositeBrickId([childA]);
    expect(id).toMatch(BRICK_ID_RE);
  });

  test("deterministic for same children", () => {
    const first = computeCompositeBrickId([childA, childB]);
    const second = computeCompositeBrickId([childA, childB]);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// computePipelineBrickId
// ---------------------------------------------------------------------------

describe("computePipelineBrickId", () => {
  const stepA = brickId("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const stepB = brickId("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const stepC = brickId("sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");

  test("same order produces same ID (deterministic)", () => {
    const first = computePipelineBrickId([stepA, stepB], "tool");
    const second = computePipelineBrickId([stepA, stepB], "tool");
    expect(first).toBe(second);
  });

  test("different order produces different ID (order-preserving)", () => {
    const ab = computePipelineBrickId([stepA, stepB], "tool");
    const ba = computePipelineBrickId([stepB, stepA], "tool");
    expect(ab).not.toBe(ba);
  });

  test("different children produce different ID", () => {
    const ab = computePipelineBrickId([stepA, stepB], "tool");
    const ac = computePipelineBrickId([stepA, stepC], "tool");
    expect(ab).not.toBe(ac);
  });

  test("outputKind affects hash", () => {
    const asTool = computePipelineBrickId([stepA, stepB], "tool");
    const asSkill = computePipelineBrickId([stepA, stepB], "skill");
    expect(asTool).not.toBe(asSkill);
  });

  test("files affect hash", () => {
    const withoutFiles = computePipelineBrickId([stepA, stepB], "tool");
    const withFiles = computePipelineBrickId([stepA, stepB], "tool", { "meta.json": '{"v":1}' });
    expect(withoutFiles).not.toBe(withFiles);
  });

  test("empty steps produces valid BrickId", () => {
    const id = computePipelineBrickId([], "tool");
    expect(id).toMatch(BRICK_ID_RE);
  });

  test("single step produces valid BrickId", () => {
    const id = computePipelineBrickId([stepA], "tool");
    expect(id).toMatch(BRICK_ID_RE);
  });

  test("pipeline ID differs from composite ID for same children", () => {
    const pipelineId = computePipelineBrickId([stepA, stepB], "tool");
    const compositeId = computeCompositeBrickId([stepA, stepB]);
    expect(pipelineId).not.toBe(compositeId);
  });
});

// ---------------------------------------------------------------------------
// isBrickId
// ---------------------------------------------------------------------------

describe("isBrickId", () => {
  test("returns true for valid BrickId", () => {
    const id = computeBrickId("tool", "test");
    expect(isBrickId(id)).toBe(true);
  });

  test("returns true for hand-crafted valid format", () => {
    expect(
      isBrickId("sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"),
    ).toBe(true);
  });

  test("returns false for empty string", () => {
    expect(isBrickId("")).toBe(false);
  });

  test("returns false for missing prefix", () => {
    expect(isBrickId("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789")).toBe(
      false,
    );
  });

  test("returns false for wrong prefix", () => {
    expect(isBrickId("md5:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789")).toBe(
      false,
    );
  });

  test("returns false for uppercase hex", () => {
    expect(
      isBrickId("sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"),
    ).toBe(false);
  });

  test("returns false for short hex (< 64 chars)", () => {
    expect(isBrickId("sha256:abcdef")).toBe(false);
  });

  test("returns false for long hex (> 64 chars)", () => {
    expect(
      isBrickId("sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ff"),
    ).toBe(false);
  });

  test("returns false for non-hex characters", () => {
    expect(
      isBrickId("sha256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"),
    ).toBe(false);
  });

  test("returns false for random string", () => {
    expect(isBrickId("not-a-brick-id")).toBe(false);
  });
});
