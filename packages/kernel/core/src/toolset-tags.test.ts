import { describe, expect, test } from "bun:test";
import { isToolsetTag, TOOLSET_TAGS } from "./ecs.js";

describe("TOOLSET_TAGS", () => {
  test("all values start with 'toolset:'", () => {
    for (const key of Object.keys(TOOLSET_TAGS)) {
      const value = TOOLSET_TAGS[key as keyof typeof TOOLSET_TAGS];
      expect(value.startsWith("toolset:")).toBe(true);
    }
  });

  test("contains expected well-known categories", () => {
    expect(TOOLSET_TAGS.SCHEDULING).toBe("toolset:scheduling");
    expect(TOOLSET_TAGS.FORGE).toBe("toolset:forge");
    expect(TOOLSET_TAGS.WEB).toBe("toolset:web");
    expect(TOOLSET_TAGS.GITHUB).toBe("toolset:github");
    expect(TOOLSET_TAGS.CATALOG).toBe("toolset:catalog");
    expect(TOOLSET_TAGS.INTERACTION).toBe("toolset:interaction");
    expect(TOOLSET_TAGS.CONTEXT).toBe("toolset:context");
    expect(TOOLSET_TAGS.MEMORY).toBe("toolset:memory");
    expect(TOOLSET_TAGS.FILESYSTEM).toBe("toolset:filesystem");
    expect(TOOLSET_TAGS.OBSERVABILITY).toBe("toolset:observability");
  });
});

describe("isToolsetTag", () => {
  test("returns true for well-known toolset tags", () => {
    for (const key of Object.keys(TOOLSET_TAGS)) {
      const value = TOOLSET_TAGS[key as keyof typeof TOOLSET_TAGS];
      expect(isToolsetTag(value)).toBe(true);
    }
  });

  test("returns true for custom toolset tags", () => {
    expect(isToolsetTag("toolset:custom")).toBe(true);
    expect(isToolsetTag("toolset:my-category")).toBe(true);
  });

  test("returns false for non-toolset tags", () => {
    expect(isToolsetTag("scheduling")).toBe(false);
    expect(isToolsetTag("forge")).toBe(false);
    expect(isToolsetTag("")).toBe(false);
    expect(isToolsetTag("tool:web")).toBe(false);
    expect(isToolsetTag("TOOLSET:web")).toBe(false);
  });
});
