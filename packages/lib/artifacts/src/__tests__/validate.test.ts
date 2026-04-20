import { describe, expect, test } from "bun:test";
import type { SessionId } from "@koi/core";
import type { SaveArtifactInput } from "../types.js";
import { validateSaveInput } from "../validate.js";

const MAX = 1024 * 1024;

function mk(partial: Partial<SaveArtifactInput> = {}): SaveArtifactInput {
  return {
    sessionId: "sess_a" as SessionId,
    name: "ok.txt",
    data: new TextEncoder().encode("hi"),
    mimeType: "text/plain",
    ...partial,
  };
}

describe("validateSaveInput", () => {
  test("accepts a well-formed input", () => {
    expect(validateSaveInput(mk(), MAX)).toBeUndefined();
  });

  test("rejects empty name", () => {
    const err = validateSaveInput(mk({ name: "" }), MAX);
    expect(err).toEqual({
      kind: "invalid_input",
      field: "name",
      reason: "must not be empty",
    });
  });

  test("rejects name with forbidden chars (slash)", () => {
    const err = validateSaveInput(mk({ name: "a/b" }), MAX);
    expect(err?.kind).toBe("invalid_input");
    expect((err as { field: string }).field).toBe("name");
  });

  test("rejects name with null byte", () => {
    const err = validateSaveInput(mk({ name: "a\u0000b" }), MAX);
    expect(err?.kind).toBe("invalid_input");
  });

  test("rejects name over 255 chars", () => {
    const err = validateSaveInput(mk({ name: "x".repeat(256) }), MAX);
    expect(err?.kind).toBe("invalid_input");
  });

  test("rejects malformed mime", () => {
    const err = validateSaveInput(mk({ mimeType: "notamime" }), MAX);
    expect(err?.kind).toBe("invalid_input");
    expect((err as { field: string }).field).toBe("mimeType");
  });

  test("rejects oversized data", () => {
    const err = validateSaveInput(mk({ data: new Uint8Array(MAX + 1) }), MAX);
    expect(err?.kind).toBe("invalid_input");
    expect((err as { field: string }).field).toBe("data");
  });

  test("rejects too many tags", () => {
    const err = validateSaveInput(mk({ tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }), MAX);
    expect(err?.kind).toBe("invalid_input");
    expect((err as { field: string }).field).toBe("tags");
  });

  test("rejects empty tag", () => {
    const err = validateSaveInput(mk({ tags: ["ok", ""] }), MAX);
    expect(err?.kind).toBe("invalid_input");
    expect((err as { field: string }).field).toBe("tags");
  });

  test("rejects too-long tag", () => {
    const err = validateSaveInput(mk({ tags: ["x".repeat(65)] }), MAX);
    expect(err?.kind).toBe("invalid_input");
  });
});
