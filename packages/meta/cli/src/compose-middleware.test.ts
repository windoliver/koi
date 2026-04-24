import { describe, expect, test } from "bun:test";
import type { KoiMiddleware } from "@koi/core";
import { buildInheritedMiddlewareForChildren } from "./compose-middleware.js";

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
