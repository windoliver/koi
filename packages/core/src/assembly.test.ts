/**
 * Unit tests for L0 assembly factory helpers (fsSkill, forgedSkill).
 */

import { describe, expect, test } from "bun:test";
import { forgedSkill, fsSkill } from "./assembly.js";
import { brickId } from "./brick-snapshot.js";

describe("fsSkill", () => {
  test("returns correct shape for filesystem skill", () => {
    const result = fsSkill("code-review", "./skills/code-review");
    expect(result).toEqual({
      name: "code-review",
      source: { kind: "filesystem", path: "./skills/code-review" },
    });
  });

  test("includes options when provided", () => {
    const result = fsSkill("code-review", "./skills/code-review", { verbose: true });
    expect(result).toEqual({
      name: "code-review",
      source: { kind: "filesystem", path: "./skills/code-review" },
      options: { verbose: true },
    });
  });

  test("omits options when undefined", () => {
    const result = fsSkill("test", "./test");
    expect("options" in result).toBe(false);
  });
});

describe("forgedSkill", () => {
  test("returns correct shape for forged skill", () => {
    const id = brickId("sha256:abc123");
    const result = forgedSkill("forged-review", id);
    expect(result).toEqual({
      name: "forged-review",
      source: { kind: "forged", brickId: id },
    });
  });

  test("includes options when provided", () => {
    const id = brickId("sha256:abc123");
    const result = forgedSkill("forged-review", id, { trust: "high" });
    expect(result).toEqual({
      name: "forged-review",
      source: { kind: "forged", brickId: id },
      options: { trust: "high" },
    });
  });

  test("omits options when undefined", () => {
    const id = brickId("sha256:abc123");
    const result = forgedSkill("test", id);
    expect("options" in result).toBe(false);
  });
});

describe("SkillSource type narrowing", () => {
  test("source.kind discriminates filesystem from forged", () => {
    const fs = fsSkill("fs-skill", "./skills/fs");
    const forged = forgedSkill("forged-skill", brickId("sha256:def456"));

    // Type narrowing via kind field
    if (fs.source.kind === "filesystem") {
      expect(fs.source.path).toBe("./skills/fs");
    }
    if (forged.source.kind === "forged") {
      expect(forged.source.brickId).toBe(brickId("sha256:def456"));
    }
  });
});
