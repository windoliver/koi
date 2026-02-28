import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Agent } from "@koi/core";
import { COMPONENT_PRIORITY } from "@koi/core";
import { createSkillComponentProvider } from "./provider.js";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

/** Minimal agent stub for testing. */
const stubAgent = { id: "test-agent" } as unknown as Agent;

describe("createSkillComponentProvider", () => {
  test("returns provider with correct name and priority", () => {
    const provider = createSkillComponentProvider({
      skills: [],
      basePath: FIXTURES,
    });
    expect(provider.name).toBe("@koi/skills");
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
  });

  test("attaches valid skill as SkillComponent", async () => {
    const provider = createSkillComponentProvider({
      skills: [{ name: "code-review", path: "./valid-skill" }],
      basePath: FIXTURES,
    });
    const result = await provider.attach(stubAgent);
    expect("components" in result).toBe(true);
    if ("components" in result) {
      expect(result.components.size).toBe(1);
      expect(result.components.has("skill:code-review")).toBe(true);
      const component = result.components.get("skill:code-review") as {
        name: string;
        content: string;
      };
      expect(component.name).toBe("code-review");
      expect(component.content).toContain("Code Review Skill");
    }
  });

  test("returns empty result for empty skills array", async () => {
    const provider = createSkillComponentProvider({
      skills: [],
      basePath: FIXTURES,
    });
    const result = await provider.attach(stubAgent);
    expect("components" in result).toBe(true);
    if ("components" in result) {
      expect(result.components.size).toBe(0);
      expect(result.skipped).toHaveLength(0);
    }
  });

  test("skips skill with invalid name and reports reason", async () => {
    const provider = createSkillComponentProvider({
      skills: [{ name: "invalid-name-skill", path: "./invalid-name" }],
      basePath: FIXTURES,
    });
    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      expect(result.components.size).toBe(0);
      expect(result.skipped.length).toBeGreaterThan(0);
    }
  });

  test("skips skill when directory not found", async () => {
    const provider = createSkillComponentProvider({
      skills: [{ name: "missing", path: "./nonexistent" }],
      basePath: FIXTURES,
    });
    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      expect(result.components.size).toBe(0);
      expect(result.skipped.length).toBe(1);
      expect(result.skipped[0]?.reason).toBeTruthy();
    }
  });

  test("first-wins on duplicate skill names", async () => {
    const provider = createSkillComponentProvider({
      skills: [
        { name: "code-review", path: "./valid-skill" },
        { name: "code-review", path: "./valid-skill" },
      ],
      basePath: FIXTURES,
    });
    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      expect(result.components.size).toBe(1);
      expect(result.skipped.length).toBe(1);
      expect(result.skipped[0]?.reason).toContain("Duplicate");
    }
  });

  test("caches result across multiple attach calls", async () => {
    const provider = createSkillComponentProvider({
      skills: [{ name: "code-review", path: "./valid-skill" }],
      basePath: FIXTURES,
    });
    const result1 = await provider.attach(stubAgent);
    const result2 = await provider.attach(stubAgent);
    expect(result1).toBe(result2); // Same object reference (cached)
  });

  test("loads at metadata level when configured", async () => {
    const provider = createSkillComponentProvider({
      skills: [{ name: "minimal-skill", path: "./minimal-skill" }],
      basePath: FIXTURES,
      loadLevel: "metadata",
    });
    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      expect(result.components.size).toBe(1);
      const component = result.components.get("skill:minimal") as {
        name: string;
        content: string;
      };
      // At metadata level, content is the description
      expect(component.content).toBe("A minimal skill with only required fields.");
    }
  });

  test("loads at bundled level with scripts and references in content", async () => {
    const provider = createSkillComponentProvider({
      skills: [{ name: "code-review", path: "./valid-skill" }],
      basePath: FIXTURES,
      loadLevel: "bundled",
    });
    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      expect(result.components.size).toBe(1);
      const component = result.components.get("skill:code-review") as {
        name: string;
        content: string;
      };
      // Body content
      expect(component.content).toContain("Code Review Skill");
      // Scripts section
      expect(component.content).toContain("## Scripts");
      expect(component.content).toContain("helper.sh");
      // References section
      expect(component.content).toContain("## References");
      expect(component.content).toContain("example.md");
    }
  });

  test("handles mixed valid and invalid skills (partial success)", async () => {
    const provider = createSkillComponentProvider({
      skills: [
        { name: "code-review", path: "./valid-skill" },
        { name: "bad", path: "./invalid-name" },
        { name: "minimal-skill", path: "./minimal-skill" },
      ],
      basePath: FIXTURES,
    });
    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      expect(result.components.size).toBe(2);
      expect(result.skipped.length).toBe(1);
    }
  });
});
