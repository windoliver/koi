import { describe, expect, test } from "bun:test";

import * as publicApi from "../index.js";

describe("@koi/browser-a11y public API surface", () => {
  test("exports serializeA11yTree function", () => {
    expect(typeof publicApi.serializeA11yTree).toBe("function");
  });

  test("exports parseAriaYaml function", () => {
    expect(typeof publicApi.parseAriaYaml).toBe("function");
  });

  test("exports isAriaRole type guard", () => {
    expect(typeof publicApi.isAriaRole).toBe("function");
    expect(publicApi.isAriaRole("button")).toBe(true);
    expect(publicApi.isAriaRole("not-a-role")).toBe(false);
  });

  test("exports VALID_ROLES ReadonlySet", () => {
    expect(publicApi.VALID_ROLES).toBeInstanceOf(Set);
    expect(publicApi.VALID_ROLES.has("button")).toBe(true);
  });

  test("exports translatePlaywrightError function", () => {
    expect(typeof publicApi.translatePlaywrightError).toBe("function");
  });

  test("exported names do not leak internal helpers", () => {
    // Internal helpers like extractMsg/hasName/msgIncludes must NOT be exported.
    expect(Object.keys(publicApi).sort()).toEqual([
      "VALID_ROLES",
      "isAriaRole",
      "parseAriaYaml",
      "serializeA11yTree",
      "translatePlaywrightError",
    ]);
  });
});
