import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentManifest, KernelExtension, SkillComponent, ValidationResult } from "@koi/core";
import { createBrickRequiresExtension } from "./brick-requires-extension.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MANIFEST: AgentManifest = {
  name: "test",
  version: "0.0.0",
  model: { name: "test" },
};

function makeComponents(
  entries: ReadonlyArray<readonly [string, unknown]>,
): ReadonlyMap<string, unknown> {
  return new Map(entries);
}

function makeSkill(
  name: string,
  requiredTools?: readonly string[],
  requiredAgents?: readonly string[],
): SkillComponent {
  const requires: {
    readonly tools?: readonly string[];
    readonly agents?: readonly string[];
  } = {
    ...(requiredTools !== undefined ? { tools: requiredTools } : {}),
    ...(requiredAgents !== undefined ? { agents: requiredAgents } : {}),
  };
  const hasRequires = requiredTools !== undefined || requiredAgents !== undefined;
  return {
    name,
    description: `Skill ${name}`,
    content: `# ${name}`,
    ...(hasRequires ? { requires } : {}),
  };
}

/** Safely call validateAssembly, throwing if it's not defined. */
function validate(
  ext: KernelExtension,
  components: ReadonlyMap<string, unknown>,
): ValidationResult {
  if (ext.validateAssembly === undefined) {
    throw new Error("validateAssembly not defined");
  }
  return ext.validateAssembly(components, MANIFEST) as ValidationResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBrickRequiresExtension", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns ok when no skills have requires", () => {
    const ext = createBrickRequiresExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const components = makeComponents([
      ["skill:research", makeSkill("research")],
      ["tool:calculator", { descriptor: { name: "calculator" } }],
    ]);

    const result = validate(ext, components);
    expect(result).toEqual({ ok: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("returns ok when skill requires are satisfied", () => {
    const ext = createBrickRequiresExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const components = makeComponents([
      ["tool:calculator", { descriptor: { name: "calculator" } }],
      ["tool:search", { descriptor: { name: "search" } }],
      ["skill:research", makeSkill("research", ["calculator", "search"])],
    ]);

    const result = validate(ext, components);
    expect(result).toEqual({ ok: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("warns when skill requires unsatisfied tool", () => {
    const ext = createBrickRequiresExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const components = makeComponents([
      ["tool:calculator", { descriptor: { name: "calculator" } }],
      ["skill:research", makeSkill("research", ["calculator", "web-search"])],
    ]);

    const result = validate(ext, components);
    expect(result).toEqual({ ok: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("research");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("web-search");
  });

  test("handles multiple skills with mixed satisfaction", () => {
    const ext = createBrickRequiresExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const components = makeComponents([
      ["tool:calculator", { descriptor: { name: "calculator" } }],
      ["skill:math", makeSkill("math", ["calculator"])],
      ["skill:research", makeSkill("research", ["web-search", "scraper"])],
    ]);

    const result = validate(ext, components);
    expect(result).toEqual({ ok: true });
    // "math" satisfied — no warn. "research" has 2 missing tools.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("web-search");
    expect(warnSpy.mock.calls[1]?.[0]).toContain("scraper");
  });

  test("ignores requires without tools or agents field", () => {
    const ext = createBrickRequiresExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const skill: SkillComponent = {
      name: "deploy",
      description: "Deploy skill",
      content: "# Deploy",
      requires: { bins: ["docker"], env: ["DEPLOY_KEY"] },
    };

    const components = makeComponents([["skill:deploy", skill]]);

    const result = validate(ext, components);
    expect(result).toEqual({ ok: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("has correct name and priority", () => {
    const ext = createBrickRequiresExtension();
    expect(ext.name).toBe("koi:brick-requires");
    expect(ext.priority).toBe(0); // EXTENSION_PRIORITY.CORE
  });

  test("returns ok with empty components map", () => {
    const ext = createBrickRequiresExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = validate(ext, new Map());
    expect(result).toEqual({ ok: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Agent requires
  // -------------------------------------------------------------------------

  describe("agents", () => {
    test("no warn when requires.agents satisfied", () => {
      const ext = createBrickRequiresExtension();
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const components = makeComponents([
        ["agent:web-crawler", { name: "web-crawler" }],
        ["skill:deep-research", makeSkill("deep-research", undefined, ["web-crawler"])],
      ]);

      const result = validate(ext, components);
      expect(result).toEqual({ ok: true });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test("warns when required agent is absent", () => {
      const ext = createBrickRequiresExtension();
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const components = makeComponents([
        ["skill:deep-research", makeSkill("deep-research", undefined, ["web-crawler"])],
      ]);

      const result = validate(ext, components);
      expect(result).toEqual({ ok: true });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("deep-research");
      expect(warnSpy.mock.calls[0]?.[0]).toContain("web-crawler");
    });

    test("satisfied tools + missing agents produces agent warning only", () => {
      const ext = createBrickRequiresExtension();
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const components = makeComponents([
        ["tool:calculator", { descriptor: { name: "calculator" } }],
        ["skill:research", makeSkill("research", ["calculator"], ["summarizer"])],
      ]);

      const result = validate(ext, components);
      expect(result).toEqual({ ok: true });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("summarizer");
      expect(warnSpy.mock.calls[0]?.[0]).toContain("agent");
    });
  });
});
