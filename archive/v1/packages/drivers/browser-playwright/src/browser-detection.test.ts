/**
 * Unit tests for detectInstalledBrowsers().
 *
 * Does not require any browser to be installed — tests structure and
 * resilience (never throws, always returns typed results).
 */

import { describe, expect, it } from "bun:test";
import type { DetectedBrowser } from "./browser-detection.js";
import { detectInstalledBrowsers } from "./browser-detection.js";

describe("detectInstalledBrowsers()", () => {
  it("returns a readonly array (never throws)", async () => {
    // Should complete without throwing even on a machine with no browsers
    const result = await detectInstalledBrowsers();
    expect(Array.isArray(result)).toBe(true);
  });

  it("every detected browser has required fields", async () => {
    const result = await detectInstalledBrowsers();
    for (const browser of result) {
      expect(typeof browser.name).toBe("string");
      expect(browser.name.length).toBeGreaterThan(0);
      expect(typeof browser.executablePath).toBe("string");
      expect(browser.executablePath.length).toBeGreaterThan(0);
      expect(["system", "playwright-bundled"]).toContain(browser.source);
    }
  });

  it("executablePath points to an existing file for every result", async () => {
    const { existsSync } = await import("node:fs");
    const result = await detectInstalledBrowsers();
    for (const browser of result) {
      expect(existsSync(browser.executablePath)).toBe(true);
    }
  });

  it("system browsers appear before playwright-bundled", async () => {
    const result = await detectInstalledBrowsers();
    if (result.length < 2) return; // can't test order with < 2 results

    const firstBundledIdx = result.findIndex((b) => b.source === "playwright-bundled");
    const lastSystemIdx =
      result.length - 1 - [...result].reverse().findIndex((b) => b.source === "system");

    // All system browsers should appear before any bundled browser
    if (firstBundledIdx !== -1 && lastSystemIdx !== -1) {
      expect(lastSystemIdx).toBeLessThan(firstBundledIdx);
    }
  });

  it("satisfies DetectedBrowser type contract", async () => {
    const result: readonly DetectedBrowser[] = await detectInstalledBrowsers();
    expect(result).toBeDefined();
  });
});
