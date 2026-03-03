import { beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Agent, ComponentEvent } from "@koi/core";
import { COMPONENT_PRIORITY, fsSkill } from "@koi/core";
import { clearSkillCache } from "./loader.js";
import { createSkillComponentProvider } from "./provider.js";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

/** Minimal agent stub for testing. */
const stubAgent = { pid: { id: "test-agent" } } as unknown as Agent;

beforeEach(() => {
  clearSkillCache();
});

describe("createSkillComponentProvider", () => {
  test("returns provider with correct name and priority", () => {
    const provider = createSkillComponentProvider({
      skills: [],
      basePath: FIXTURES,
    });
    expect(provider.name).toBe("@koi/skills");
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
  });

  test("attaches valid skill at metadata level initially", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
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
      // Initial load is metadata: content is the description, not the body
      expect(component.content).toBe("Reviews code for quality, security, and best practices.");
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
      skills: [fsSkill("invalid-name-skill", "./invalid-name")],
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
      skills: [fsSkill("missing", "./nonexistent")],
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
      skills: [fsSkill("code-review", "./valid-skill"), fsSkill("code-review", "./valid-skill")],
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
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });
    const result1 = await provider.attach(stubAgent);
    const result2 = await provider.attach(stubAgent);
    expect(result1).toBe(result2); // Same object reference (cached)
  });

  test("loads at metadata level — content is description", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("minimal-skill", "./minimal-skill")],
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

  test("handles mixed valid and invalid skills (partial success)", async () => {
    const provider = createSkillComponentProvider({
      skills: [
        fsSkill("code-review", "./valid-skill"),
        fsSkill("bad", "./invalid-name"),
        fsSkill("minimal-skill", "./minimal-skill"),
      ],
      basePath: FIXTURES,
    });
    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      expect(result.components.size).toBe(2);
      expect(result.skipped.length).toBe(1);
    }
  });

  test("throws when forged skills exist but no ForgeStore provided", () => {
    expect(() =>
      createSkillComponentProvider({
        skills: [
          { name: "forged-review", source: { kind: "forged", brickId: "sha256:abc" as never } },
        ],
        basePath: FIXTURES,
      }),
    ).toThrow("SkillConfig contains forged skills but no ForgeStore was provided");
  });
});

describe("ProgressiveSkillProvider.getLevel", () => {
  test("returns metadata after initial attach", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);
    expect(provider.getLevel("code-review")).toBe("metadata");
  });

  test("returns undefined for unknown skill", async () => {
    const provider = createSkillComponentProvider({
      skills: [],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);
    expect(provider.getLevel("nonexistent")).toBeUndefined();
  });
});

describe("ProgressiveSkillProvider.promote", () => {
  test("promotes skill from metadata to body", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);
    expect(provider.getLevel("code-review")).toBe("metadata");

    const promoteResult = await provider.promote("code-review", "body");
    expect(promoteResult.ok).toBe(true);
    expect(provider.getLevel("code-review")).toBe("body");

    // After promotion, content should include the markdown body
    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      const component = result.components.get("skill:code-review") as {
        content: string;
      };
      expect(component.content).toContain("Code Review Skill");
    }
  });

  test("promotes skill from metadata to bundled", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);

    const promoteResult = await provider.promote("code-review", "bundled");
    expect(promoteResult.ok).toBe(true);
    expect(provider.getLevel("code-review")).toBe("bundled");

    // After promotion, content should include body + scripts + references
    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      const component = result.components.get("skill:code-review") as {
        content: string;
      };
      expect(component.content).toContain("Code Review Skill");
      expect(component.content).toContain("## Scripts");
      expect(component.content).toContain("helper.sh");
      expect(component.content).toContain("## References");
      expect(component.content).toContain("example.md");
    }
  });

  test("promotes to configured loadLevel when no targetLevel given", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
      loadLevel: "bundled",
    });
    await provider.attach(stubAgent);

    // promote() without explicit target uses loadLevel from config
    const promoteResult = await provider.promote("code-review");
    expect(promoteResult.ok).toBe(true);
    expect(provider.getLevel("code-review")).toBe("bundled");
  });

  test("no-op when already at target level", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);

    // Already at metadata — promoting to metadata is a no-op
    const promoteResult = await provider.promote("code-review", "metadata");
    expect(promoteResult.ok).toBe(true);
    expect(provider.getLevel("code-review")).toBe("metadata");
  });

  test("no-op when already above target level", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);

    await provider.promote("code-review", "bundled");
    expect(provider.getLevel("code-review")).toBe("bundled");

    // Promoting to body when already at bundled is a no-op
    const promoteResult = await provider.promote("code-review", "body");
    expect(promoteResult.ok).toBe(true);
    expect(provider.getLevel("code-review")).toBe("bundled");
  });

  test("returns NOT_FOUND error for unknown skill", async () => {
    const provider = createSkillComponentProvider({
      skills: [],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);

    const promoteResult = await provider.promote("nonexistent", "body");
    expect(promoteResult.ok).toBe(false);
    if (!promoteResult.ok) {
      expect(promoteResult.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("ProgressiveSkillProvider.watch", () => {
  test("fires attached event on promote", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);

    const events: ComponentEvent[] = [];
    const unsubscribe = provider.watch?.((event) => {
      events.push(event);
    });

    await provider.promote("code-review", "body");

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("attached");
    expect(events[0]?.componentKey).toBe("skill:code-review");

    unsubscribe?.();
  });

  test("does not fire event on no-op promote", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);

    const events: ComponentEvent[] = [];
    const unsubscribe = provider.watch?.((event) => {
      events.push(event);
    });

    // Already at metadata — no event
    await provider.promote("code-review", "metadata");

    expect(events).toHaveLength(0);

    unsubscribe?.();
  });

  test("unsubscribe stops further events", async () => {
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });
    await provider.attach(stubAgent);

    const events: ComponentEvent[] = [];
    const unsubscribe = provider.watch?.((event) => {
      events.push(event);
    });

    unsubscribe?.();

    await provider.promote("code-review", "body");
    expect(events).toHaveLength(0);
  });
});
