/**
 * Tests for the forge companion skill.
 *
 * Covers: Decision #15B (always load full skill).
 */

import { describe, expect, test } from "bun:test";
import type { Agent } from "@koi/core";
import { isAttachResult, skillToken } from "@koi/core";
import { createForgeCompanionSkillProvider, FORGE_COMPANION_SKILL } from "./companion-skill.js";

const STUB_AGENT = {} as Agent;

describe("FORGE_COMPANION_SKILL", () => {
  test("has required fields", () => {
    expect(FORGE_COMPANION_SKILL.name).toBe("forge-self-improvement");
    expect(FORGE_COMPANION_SKILL.description).toBeTruthy();
    expect(FORGE_COMPANION_SKILL.content).toBeTruthy();
    expect(FORGE_COMPANION_SKILL.tags).toBeDefined();
  });

  test("content mentions forge_skill and forge_tool", () => {
    expect(FORGE_COMPANION_SKILL.content).toContain("forge_skill");
    expect(FORGE_COMPANION_SKILL.content).toContain("forge_tool");
  });

  test("content describes when to create vs when not to create", () => {
    expect(FORGE_COMPANION_SKILL.content).toContain("When to Create");
    expect(FORGE_COMPANION_SKILL.content).toContain("When NOT to Create");
  });

  test("content describes skill vs tool decision", () => {
    expect(FORGE_COMPANION_SKILL.content).toContain("Skill vs Tool");
  });

  test("has forge-related tags", () => {
    expect(FORGE_COMPANION_SKILL.tags).toContain("forge");
    expect(FORGE_COMPANION_SKILL.tags).toContain("self-improvement");
  });
});

describe("createForgeCompanionSkillProvider", () => {
  test("returns provider with correct name", () => {
    const provider = createForgeCompanionSkillProvider();
    expect(provider.name).toBe("forge-companion-skill");
  });

  test("attach returns components with forge skill token", async () => {
    const provider = createForgeCompanionSkillProvider();
    const raw = await provider.attach(STUB_AGENT);
    expect(isAttachResult(raw)).toBe(true);
    if (!isAttachResult(raw)) return;

    expect(raw.components.size).toBe(1);

    const token = skillToken("forge-self-improvement");
    expect(raw.components.has(token)).toBe(true);

    const skill = raw.components.get(token) as {
      name: string;
      description: string;
      content: string;
    };
    expect(skill.name).toBe("forge-self-improvement");
    expect(skill.content).toContain("forge_skill");
  });

  test("attach returns empty skipped array", async () => {
    const provider = createForgeCompanionSkillProvider();
    const raw = await provider.attach(STUB_AGENT);
    expect(isAttachResult(raw)).toBe(true);
    if (!isAttachResult(raw)) return;
    expect(raw.skipped).toEqual([]);
  });
});
