/**
 * Unit tests for L0 assembly factory helpers (fsSkill, forgedSkill).
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, ContextManifestConfig } from "./assembly.js";
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

describe("AgentManifest.context (issue #1767)", () => {
  test("accepts a context engine selector with version pin and config", () => {
    const ctx: ContextManifestConfig = {
      engine: "@koi/context-manager",
      version: "1.0.0",
      config: { preset: "balanced" },
    };
    const manifest: AgentManifest = {
      name: "agent",
      version: "1.0.0",
      model: { name: "sonnet" },
      context: ctx,
    };
    expect(manifest.context?.engine).toBe("@koi/context-manager");
    expect(manifest.context?.version).toBe("1.0.0");
    expect(manifest.context?.config).toEqual({ preset: "balanced" });
  });

  test("accepts an empty selector — runtime applies its default", () => {
    const manifest: AgentManifest = {
      name: "agent",
      version: "1.0.0",
      model: { name: "sonnet" },
      context: {},
    };
    expect(manifest.context).toBeDefined();
    expect(manifest.context?.engine).toBeUndefined();
  });

  test("manifest without context field is also valid (backward compat)", () => {
    const manifest: AgentManifest = {
      name: "agent",
      version: "1.0.0",
      model: { name: "sonnet" },
    };
    expect(manifest.context).toBeUndefined();
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
