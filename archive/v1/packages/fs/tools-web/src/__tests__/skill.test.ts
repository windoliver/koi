/**
 * Tests for the web skill component attachment via createWebProvider.
 *
 * Validates that the SkillComponent is correctly attached alongside tools
 * when the provider's attach() method is called.
 */

import { describe, expect, test } from "bun:test";
import type { AttachResult, SkillComponent } from "@koi/core";
import { isAttachResult, skillToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createWebProvider } from "../web-component-provider.js";
import type { WebExecutor } from "../web-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal WebExecutor mock — both methods return validation errors.
 * Sufficient for testing provider attach() since no tools are invoked.
 */
function createMockWebExecutor(): WebExecutor {
  return {
    fetch: async () => ({
      ok: false as const,
      error: { code: "VALIDATION" as const, message: "mock", retryable: false },
    }),
    search: async () => ({
      ok: false as const,
      error: { code: "VALIDATION" as const, message: "mock", retryable: false },
    }),
  };
}

/** Extract ReadonlyMap from attach() result (handles both AttachResult and bare Map). */
function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillComponent attachment", () => {
  test("attach() includes SkillComponent with correct name and non-empty content", async () => {
    const provider = createWebProvider({
      executor: createMockWebExecutor(),
    });
    const raw = await provider.attach(createMockAgent());
    const result = extractMap(raw);

    const skill = result.get(skillToken("web") as string);
    expect(skill).toBeDefined();
    expect((skill as SkillComponent).name).toBe("web");
    expect((skill as SkillComponent).content.length).toBeGreaterThan(200);
    expect((skill as SkillComponent).content).toContain("## ");
  });

  test("skill tags include web, fetch, search, and http", async () => {
    const provider = createWebProvider({
      executor: createMockWebExecutor(),
    });
    const raw = await provider.attach(createMockAgent());
    const result = extractMap(raw);

    const skill = result.get(skillToken("web") as string) as SkillComponent;
    expect(skill.tags).toEqual(["web", "fetch", "search", "http"]);
  });

  test("attach() includes both tools and the skill component", async () => {
    const provider = createWebProvider({
      executor: createMockWebExecutor(),
    });
    const raw = await provider.attach(createMockAgent());
    const result = extractMap(raw);

    // 2 tools (web_fetch, web_search) + 1 skill = 3 entries
    expect(result.size).toBe(3);

    // Verify tool entries exist
    const keys = [...result.keys()];
    expect(keys.some((k) => k.startsWith("tool:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("skill:"))).toBe(true);
  });

  test("skill description is non-empty and informative", async () => {
    const provider = createWebProvider({
      executor: createMockWebExecutor(),
    });
    const raw = await provider.attach(createMockAgent());
    const result = extractMap(raw);

    const skill = result.get(skillToken("web") as string) as SkillComponent;
    expect(skill.description.length).toBeGreaterThan(10);
    expect(skill.description).toContain("fetch");
  });
});
