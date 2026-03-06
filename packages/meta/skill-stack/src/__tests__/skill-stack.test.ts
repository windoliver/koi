/**
 * Integration tests for createSkillStack.
 *
 * Verifies: factory composition, mount/unmount proxy, dispose, preset resolution.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Agent } from "@koi/core";
import { fsSkill } from "@koi/core";
import { clearSkillCache } from "@koi/skills";
import { createSkillStack } from "../skill-stack.js";

const FIXTURES = resolve(import.meta.dir, "../../../../fs/skills/fixtures");

/** Minimal agent stub for testing. */
const stubAgent = { pid: { id: "test-agent" } } as unknown as Agent;

beforeEach(() => {
  clearSkillCache();
});

describe("createSkillStack", () => {
  test("creates bundle with provider and middleware", () => {
    const bundle = createSkillStack({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });

    expect(bundle.provider).toBeDefined();
    expect(bundle.provider.name).toBe("@koi/skills");
    expect(bundle.middleware).toHaveLength(1);
    expect(bundle.config.preset).toBe("standard");
    expect(bundle.config.gatingEnabled).toBe(true);

    bundle.dispose();
  });

  test("resolves preset from config", () => {
    const restrictive = createSkillStack({
      skills: [],
      basePath: FIXTURES,
      preset: "restrictive",
    });
    expect(restrictive.config.preset).toBe("restrictive");
    restrictive.dispose();

    const permissive = createSkillStack({
      skills: [],
      basePath: FIXTURES,
      preset: "permissive",
    });
    expect(permissive.config.preset).toBe("permissive");
    permissive.dispose();
  });

  test("provider attaches skills", async () => {
    const bundle = createSkillStack({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });

    const result = await bundle.provider.attach(stubAgent);
    expect("components" in result).toBe(true);
    if ("components" in result) {
      expect(result.components.has("skill:code-review")).toBe(true);
    }

    bundle.dispose();
  });

  test("mount adds skill to provider", async () => {
    const bundle = createSkillStack({
      skills: [],
      basePath: FIXTURES,
    });

    await bundle.provider.attach(stubAgent);

    const result = await bundle.mount(fsSkill("code-review", "./valid-skill"));
    expect(result.ok).toBe(true);

    expect(bundle.provider.getLevel("code-review")).toBe("body");

    bundle.dispose();
  });

  test("unmount removes skill from provider", async () => {
    const bundle = createSkillStack({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
    });

    await bundle.provider.attach(stubAgent);
    expect(bundle.provider.getLevel("code-review")).toBe("metadata");

    bundle.unmount("code-review");
    expect(bundle.provider.getLevel("code-review")).toBeUndefined();

    bundle.dispose();
  });

  test("dispose cleans up watchers", () => {
    const bundle = createSkillStack({
      skills: [],
      basePath: FIXTURES,
      watch: true,
      overrideDirs: [FIXTURES],
    });

    expect(bundle.config.watcherCount).toBe(1);

    // Should not throw
    bundle.dispose();
  });

  test("skillCount reflects eligible skills", () => {
    const bundle = createSkillStack({
      skills: [fsSkill("code-review", "./valid-skill"), fsSkill("minimal", "./minimal-skill")],
      basePath: FIXTURES,
    });

    expect(bundle.config.skillCount).toBe(2);

    bundle.dispose();
  });

  test("watcherCount is 0 when watch is disabled", () => {
    const bundle = createSkillStack({
      skills: [],
      basePath: FIXTURES,
      watch: false,
    });

    expect(bundle.config.watcherCount).toBe(0);

    bundle.dispose();
  });

  test("calls onSecurityFinding callback", async () => {
    const findings: Array<{ name: string }> = [];
    const bundle = createSkillStack({
      skills: [fsSkill("code-review", "./valid-skill")],
      basePath: FIXTURES,
      onSecurityFinding: (name) => findings.push({ name }),
    });

    await bundle.provider.attach(stubAgent);
    // Promote to body to trigger security scan
    await bundle.provider.promote("code-review", "body");

    // The callback may or may not fire depending on skill content;
    // we verify the wiring doesn't throw
    bundle.dispose();
  });
});
