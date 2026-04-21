import { describe, expect, test } from "bun:test";

import * as publicApi from "../index.js";

describe("@koi/browser-playwright public API surface", () => {
  test("exports createPlaywrightBrowserDriver factory", () => {
    expect(typeof publicApi.createPlaywrightBrowserDriver).toBe("function");
  });

  test("exports detectInstalledBrowsers function", () => {
    expect(typeof publicApi.detectInstalledBrowsers).toBe("function");
  });

  test("exports STEALTH_INIT_SCRIPT as a non-empty string", () => {
    expect(typeof publicApi.STEALTH_INIT_SCRIPT).toBe("string");
    expect(publicApi.STEALTH_INIT_SCRIPT.length).toBeGreaterThan(0);
  });

  test("exported names pin to exactly three runtime symbols", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "STEALTH_INIT_SCRIPT",
      "createPlaywrightBrowserDriver",
      "detectInstalledBrowsers",
    ]);
  });
});
