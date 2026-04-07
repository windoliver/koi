/**
 * API surface smoke test — verifies all public exports are defined at import time.
 */
import { describe, expect, test } from "bun:test";
import * as skillsRuntime from "../index.js";

describe("@koi/skills-runtime public API surface", () => {
  test("createSkillsRuntime is exported and callable", () => {
    expect(typeof skillsRuntime.createSkillsRuntime).toBe("function");
    const runtime = skillsRuntime.createSkillsRuntime();
    expect(typeof runtime.discover).toBe("function");
    expect(typeof runtime.load).toBe("function");
    expect(typeof runtime.loadAll).toBe("function");
  });

  test("createSkillsRuntime with no args uses defaults", () => {
    const runtime = skillsRuntime.createSkillsRuntime();
    expect(runtime).toBeDefined();
  });

  test("createSkillsRuntime accepts all config options", () => {
    const runtime = skillsRuntime.createSkillsRuntime({
      projectRoot: "/tmp/project",
      userRoot: "/tmp/user",
      bundledRoot: null,
      blockOnSeverity: "CRITICAL",
      onShadowedSkill: () => {},
      onSecurityFinding: () => {},
    });
    expect(runtime).toBeDefined();
  });

  test("discover() returns a Promise", () => {
    const runtime = skillsRuntime.createSkillsRuntime({ bundledRoot: null });
    const result = runtime.discover();
    expect(result instanceof Promise).toBe(true);
    // Consume the promise to avoid unhandled rejection warnings
    void result;
  });

  test("load() returns a Promise", () => {
    const runtime = skillsRuntime.createSkillsRuntime({ bundledRoot: null });
    const result = runtime.load("nonexistent");
    expect(result instanceof Promise).toBe(true);
    void result;
  });

  test("loadAll() returns a Promise", () => {
    const runtime = skillsRuntime.createSkillsRuntime({ bundledRoot: null });
    const result = runtime.loadAll();
    expect(result instanceof Promise).toBe(true);
    void result;
  });
});
