import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Agent, SkillComponent } from "@koi/core";
import { fsSkill } from "@koi/core";
import { loadSkillBody, loadSkillBundled } from "../loader.js";
import { parseSkillMd } from "../parse.js";
import { createSkillComponentProvider } from "../provider.js";
import { validateSkillFrontmatter } from "../validate.js";

const FIXTURES = resolve(import.meta.dir, "../../fixtures");
const stubAgent = { pid: { id: "integration-test" } } as unknown as Agent;

describe("end-to-end pipeline", () => {
  test("fixture → parse → validate → load → provider → SkillComponent", async () => {
    // Step 1: Read fixture
    const content = await Bun.file(resolve(FIXTURES, "valid-skill/SKILL.md")).text();

    // Step 2: Parse
    const parsed = parseSkillMd(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Step 3: Validate
    const validated = validateSkillFrontmatter(parsed.value.frontmatter);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.name).toBe("code-review");
    expect(validated.value.allowedTools).toEqual(["read_file", "write_file", "search"]);

    // Step 4: Load via provider
    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });

    const result = await provider.attach(stubAgent);
    expect("components" in result).toBe(true);
    if (!("components" in result)) return;

    const component = result.components.get("skill:code-review") as SkillComponent;
    expect(component).toBeDefined();
    expect(component.name).toBe("code-review");
    expect(component.description).toContain("Reviews code");
    // Initial attach loads at "metadata" level — content is the description
    expect(component.content).toBe("Reviews code for quality, security, and best practices.");

    // Step 5: Promote to body level to get full content
    const promoteResult = await provider.promote("code-review", "body");
    expect(promoteResult.ok).toBe(true);

    // After promote, the component is updated in-place in the components map
    const promoted = result.components.get("skill:code-review") as SkillComponent;
    expect(promoted.content).toContain("# Code Review Skill");
  });

  test("body loader returns markdown body with embedded code", async () => {
    const result = await loadSkillBody(resolve(FIXTURES, "valid-skill"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).toContain("```javascript");
      expect(result.value.body).toContain("reviewCode");
    }
  });

  test("bundled loader includes scripts, references, and assets", async () => {
    const result = await loadSkillBundled(resolve(FIXTURES, "valid-skill"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const scriptNames = result.value.scripts.map((s) => s.filename);
      const refNames = result.value.references.map((r) => r.filename);
      const assetNames = result.value.assets.map((a) => a.filename);
      expect(scriptNames).toContain("helper.sh");
      expect(refNames).toContain("example.md");
      expect(assetNames).toContain("report-template.md");
    }
  });

  test("multiple skills from manifest-style config", async () => {
    const provider = createSkillComponentProvider({
      skills: [
        fsSkill("code-review", "./valid-skill"),
        fsSkill("minimal-skill", "./minimal-skill"),
      ],
      basePath: FIXTURES,
    });

    const result = await provider.attach(stubAgent);
    if ("components" in result) {
      expect(result.components.size).toBe(2);
      expect(result.components.has("skill:code-review")).toBe(true);
      expect(result.components.has("skill:minimal")).toBe(true);
      expect(result.skipped).toHaveLength(0);
    }
  });
});
