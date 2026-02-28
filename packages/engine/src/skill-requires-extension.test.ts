import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentManifest, KernelExtension, SkillComponent, ValidationResult } from "@koi/core";
import { createSkillRequiresExtension } from "./skill-requires-extension.js";

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

function makeSkill(name: string, requiredTools?: readonly string[]): SkillComponent {
  return {
    name,
    description: `Skill ${name}`,
    content: `# ${name}`,
    ...(requiredTools !== undefined ? { requires: { tools: requiredTools } } : {}),
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

describe("createSkillRequiresExtension", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns ok when no skills have requires", () => {
    const ext = createSkillRequiresExtension();
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
    const ext = createSkillRequiresExtension();
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
    const ext = createSkillRequiresExtension();
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
    const ext = createSkillRequiresExtension();
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

  test("ignores requires without tools field", () => {
    const ext = createSkillRequiresExtension();
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
    const ext = createSkillRequiresExtension();
    expect(ext.name).toBe("koi:skill-requires");
    expect(ext.priority).toBe(0); // EXTENSION_PRIORITY.CORE
  });

  test("returns ok with empty components map", () => {
    const ext = createSkillRequiresExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = validate(ext, new Map());
    expect(result).toEqual({ ok: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
