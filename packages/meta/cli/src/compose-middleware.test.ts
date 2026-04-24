import { describe, expect, test } from "bun:test";
import type { KoiMiddleware } from "@koi/core";
import {
  buildInheritedMiddlewareForChildren,
  composeRuntimeMiddleware,
} from "./compose-middleware.js";

function stub(name: string): KoiMiddleware {
  return { name, phase: "resolve", priority: 0, describeCapabilities: () => undefined };
}

describe("buildInheritedMiddlewareForChildren", () => {
  const permissions = stub("permissions");
  const exfiltrationGuard = stub("exfiltration-guard");
  const hook = stub("hook");

  test("includes required middleware in correct order", () => {
    const result = buildInheritedMiddlewareForChildren({
      permissions,
      exfiltrationGuard,
      hook,
    });
    expect(result).toEqual([permissions, exfiltrationGuard, hook]);
  });

  test("appends optional systemPrompt when provided", () => {
    const systemPrompt = stub("system-prompt");
    const result = buildInheritedMiddlewareForChildren({
      permissions,
      exfiltrationGuard,
      hook,
      systemPrompt,
    });
    expect(result).toContain(systemPrompt);
    expect(result.indexOf(systemPrompt)).toBeGreaterThan(result.indexOf(hook));
  });

  test("appends skillInjector when provided — regression for #1986 child skill loss", () => {
    const skillInjector = stub("skill-injector");
    const result = buildInheritedMiddlewareForChildren({
      permissions,
      exfiltrationGuard,
      hook,
      skillInjector,
    });
    expect(result).toContain(skillInjector);
  });

  test("skillInjector appears after required middleware", () => {
    const skillInjector = stub("skill-injector");
    const result = buildInheritedMiddlewareForChildren({
      permissions,
      exfiltrationGuard,
      hook,
      skillInjector,
    });
    const requiredIdx = Math.max(
      result.indexOf(permissions),
      result.indexOf(exfiltrationGuard),
      result.indexOf(hook),
    );
    expect(result.indexOf(skillInjector)).toBeGreaterThan(requiredIdx);
  });

  test("skillInjector appears BEFORE systemPrompt — matches root agent effective ordering", () => {
    // Regression: if skillInjector is after systemPrompt, children get
    // "<skills>\n\nbase" while root gets "base\n\n<skills>" — prompt-order drift.
    const skillInjector = stub("skill-injector");
    const systemPrompt = stub("system-prompt");
    const result = buildInheritedMiddlewareForChildren({
      permissions,
      exfiltrationGuard,
      hook,
      skillInjector,
      systemPrompt,
    });
    expect(result.indexOf(skillInjector)).toBeLessThan(result.indexOf(systemPrompt));
  });

  test("omits skillInjector when not provided", () => {
    const result = buildInheritedMiddlewareForChildren({
      permissions,
      exfiltrationGuard,
      hook,
    });
    expect(result.some((mw) => mw.name === "skill-injector")).toBe(false);
  });

  test("includes both systemPrompt and skillInjector when both provided", () => {
    const systemPrompt = stub("system-prompt");
    const skillInjector = stub("skill-injector");
    const result = buildInheritedMiddlewareForChildren({
      permissions,
      exfiltrationGuard,
      hook,
      systemPrompt,
      skillInjector,
    });
    expect(result).toContain(systemPrompt);
    expect(result).toContain(skillInjector);
  });
});

describe("composeRuntimeMiddleware — skill injector ordering", () => {
  function stub(name: string): KoiMiddleware {
    return { name, phase: "resolve", priority: 0, describeCapabilities: () => undefined };
  }

  const hook = stub("hook");
  const permissions = stub("permissions");
  const exfiltrationGuard = stub("exfiltration-guard");

  test("skillInjector slot appears after permissions (post-permissions zone)", () => {
    // Regression for #1986: root agent skill injector must not check request.tools
    // before permissions has filtered them. Placing it after permissions ensures
    // the Skill tool gate operates on the final filtered tool list.
    const skillInjector = stub("skill-injector");
    const result = composeRuntimeMiddleware({
      hook,
      permissions,
      exfiltrationGuard,
      skillInjector,
    });
    expect(result.indexOf(skillInjector)).toBeGreaterThan(result.indexOf(permissions));
  });

  test("skillInjector appears before systemPrompt in root chain", () => {
    const skillInjector = stub("skill-injector");
    const systemPrompt = stub("system-prompt");
    const result = composeRuntimeMiddleware({
      hook,
      permissions,
      exfiltrationGuard,
      skillInjector,
      systemPrompt,
    });
    expect(result.indexOf(skillInjector)).toBeLessThan(result.indexOf(systemPrompt));
  });

  test("omits skillInjector when not provided", () => {
    const result = composeRuntimeMiddleware({ hook, permissions, exfiltrationGuard });
    expect(result.some((mw) => mw.name === "skill-injector")).toBe(false);
  });
});
