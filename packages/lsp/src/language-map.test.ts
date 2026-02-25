import { describe, expect, test } from "bun:test";
import { detectLanguageId } from "./language-map.js";

describe("detectLanguageId", () => {
  test("detects TypeScript from .ts extension", () => {
    expect(detectLanguageId("file:///src/index.ts")).toBe("typescript");
  });

  test("detects TypeScript React from .tsx extension", () => {
    expect(detectLanguageId("file:///src/App.tsx")).toBe("typescriptreact");
  });

  test("detects JavaScript from .js extension", () => {
    expect(detectLanguageId("file:///lib/utils.js")).toBe("javascript");
  });

  test("detects Python from .py extension", () => {
    expect(detectLanguageId("file:///scripts/run.py")).toBe("python");
  });

  test("detects Go from .go extension", () => {
    expect(detectLanguageId("file:///main.go")).toBe("go");
  });

  test("detects Rust from .rs extension", () => {
    expect(detectLanguageId("file:///src/lib.rs")).toBe("rust");
  });

  test("returns undefined for unknown extension", () => {
    expect(detectLanguageId("file:///data.xyz")).toBeUndefined();
  });

  test("returns undefined for paths without extension", () => {
    expect(detectLanguageId("file:///Makefile")).toBeUndefined();
  });

  test("handles case-insensitive extensions", () => {
    expect(detectLanguageId("file:///README.MD")).toBe("markdown");
  });

  test("handles simple file paths", () => {
    expect(detectLanguageId("/home/user/src/main.go")).toBe("go");
  });

  test("detects ESM extensions", () => {
    expect(detectLanguageId("file:///lib.mjs")).toBe("javascript");
    expect(detectLanguageId("file:///lib.mts")).toBe("typescript");
  });
});
