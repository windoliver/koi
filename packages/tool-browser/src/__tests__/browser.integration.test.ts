/**
 * Integration tests for @koi/tool-browser.
 *
 * These tests verify that the ComponentProvider correctly attaches tools
 * to an agent using a real MockBrowserDriver.
 *
 * For real Playwright integration tests, see @koi/browser-playwright.
 */

import { describe, expect, test } from "bun:test";
import type { AttachResult, SkillComponent } from "@koi/core";
import { BROWSER, isAttachResult, skillToken, toolToken } from "@koi/core";
import {
  BROWSER_SKILL_NAME,
  createBrowserProvider,
  createMockAgent,
  createMockDriver,
  OPERATIONS,
} from "../index.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

describe("createBrowserProvider (integration)", () => {
  test("attaches all default tools to agent component map", async () => {
    const driver = createMockDriver();
    const provider = createBrowserProvider({ backend: driver });
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));

    // BROWSER singleton token should be present
    expect(components.has(BROWSER as string)).toBe(true);

    // All 12 default tools should be registered
    for (const op of OPERATIONS) {
      const toolName = `browser_${op}`;
      expect(components.has(toolToken(toolName) as string)).toBe(true);
    }
  });

  test("does not include evaluate in default operations", async () => {
    const driver = createMockDriver();
    const provider = createBrowserProvider({ backend: driver });
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));

    expect(components.has(toolToken("browser_evaluate") as string)).toBe(false);
  });

  test("includes evaluate when explicitly requested", async () => {
    const driver = createMockDriver();
    const provider = createBrowserProvider({
      backend: driver,
      operations: [...OPERATIONS, "evaluate"],
    });
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));

    expect(components.has(toolToken("browser_evaluate") as string)).toBe(true);
    // evaluate must use promoted tier regardless of config
    const evalTool = components.get(toolToken("browser_evaluate") as string) as {
      trustTier: string;
    };
    expect(evalTool.trustTier).toBe("promoted");
  });

  test("respects custom prefix", async () => {
    const driver = createMockDriver();
    const provider = createBrowserProvider({ backend: driver, prefix: "web" });
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));

    expect(components.has(toolToken("web_snapshot") as string)).toBe(true);
    expect(components.has(toolToken("browser_snapshot") as string)).toBe(false);
  });

  test("calls dispose on detach", async () => {
    let disposed = false;
    const driver = {
      ...createMockDriver(),
      dispose: () => {
        disposed = true;
      },
    };
    const provider = createBrowserProvider({ backend: driver });
    const agent = createMockAgent();
    await provider.attach(agent);
    await provider.detach?.(agent);
    expect(disposed).toBe(true);
  });

  test("attaches browser skill component with name and content", async () => {
    const driver = createMockDriver();
    const provider = createBrowserProvider({ backend: driver });
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));

    expect(components.has(skillToken(BROWSER_SKILL_NAME) as string)).toBe(true);
    const skill = components.get(skillToken(BROWSER_SKILL_NAME) as string) as SkillComponent;
    expect(skill.name).toBe(BROWSER_SKILL_NAME);
    expect(skill.content).toContain("browser_snapshot");
  });
});
