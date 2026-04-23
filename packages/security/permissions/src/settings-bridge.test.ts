import { describe, expect, test } from "bun:test";
import type { KoiSettings } from "@koi/settings";
import { mapSettingsToSourcedRules } from "./settings-bridge.js";

describe("mapSettingsToSourcedRules", () => {
  test("empty permissions returns empty array", () => {
    const rules = mapSettingsToSourcedRules({}, "user");
    expect(rules).toHaveLength(0);
  });

  test("allow strings become SourcedRules with effect=allow and action=invoke", () => {
    const settings: KoiSettings = {
      permissions: { allow: ["Read(*)", "Glob(*)"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "user");
    const allowRules = rules.filter((r) => r.effect === "allow");
    // Each bare/(*) entry emits 2 rules (exact + enriched)
    expect(allowRules).toHaveLength(4);
    // "Read(*)" → exact "Read" and enriched "Read:**"
    expect(allowRules[0]?.pattern).toBe("Read");
    expect(allowRules[1]?.pattern).toBe("Read:**");
    expect(allowRules[0]?.action).toBe("invoke");
    expect(allowRules[0]?.source).toBe("user");
  });

  test("deny strings become SourcedRules with effect=deny and command in pattern", () => {
    const settings: KoiSettings = {
      permissions: { deny: ["Bash(rm -rf*)"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "local");
    // Command-scoped: single rule
    expect(rules).toHaveLength(1);
    expect(rules[0]?.effect).toBe("deny");
    // "Bash(rm -rf*)" → pattern "Bash:rm -rf*" matches enriched resource "Bash:rm -rf /tmp"
    expect(rules[0]?.pattern).toBe("Bash:rm -rf*");
    expect(rules[0]?.action).toBe("invoke");
    expect(rules[0]?.source).toBe("local");
  });

  test("ask strings become SourcedRules with effect=ask and command in pattern", () => {
    const settings: KoiSettings = {
      permissions: { ask: ["Bash(git push*)"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.effect).toBe("ask");
    expect(rules[0]?.pattern).toBe("Bash:git push*");
    expect(rules[0]?.action).toBe("invoke");
  });

  test("bare tool name emits exact + enriched rules to avoid prefix bleed", () => {
    const settings: KoiSettings = {
      permissions: { deny: ["WebFetch"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "policy");
    // Two rules: "WebFetch" (exact) and "WebFetch:**" (enriched) — does NOT match "WebFetchProxy"
    expect(rules).toHaveLength(2);
    expect(rules[0]?.pattern).toBe("WebFetch");
    expect(rules[1]?.pattern).toBe("WebFetch:**");
    expect(rules[0]?.action).toBe("invoke");
  });

  test("bare deny does not match unrelated tool with same prefix", () => {
    const settings: KoiSettings = {
      permissions: { deny: ["Read"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "user");
    const patterns = rules.map((r) => r.pattern);
    expect(patterns).toContain("Read");
    expect(patterns).toContain("Read:**");
    // Must NOT contain a pattern that would match "ReadSecret"
    // i.e. no "Read**" which compiles to /^Read.*$/
    expect(patterns).not.toContain("Read**");
  });

  test("wildcard '*' becomes pattern='**' action='invoke'", () => {
    const settings: KoiSettings = {
      permissions: { allow: ["*"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "flag");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern).toBe("**");
    expect(rules[0]?.action).toBe("invoke");
  });

  test("source is preserved on all rules", () => {
    const settings: KoiSettings = {
      permissions: {
        allow: ["Read(*)"],
        deny: ["Bash(*)"],
        ask: ["WebFetch(*)"],
      },
    };
    const rules = mapSettingsToSourcedRules(settings, "project");
    expect(rules.every((r) => r.source === "project")).toBe(true);
  });

  test("rules are emitted deny-first so denies shadow broad allows within a layer", () => {
    const settings: KoiSettings = {
      permissions: {
        allow: ["Bash:**"],
        deny: ["Bash:rm -rf**"],
      },
    };
    const rules = mapSettingsToSourcedRules(settings, "local");
    // deny must appear before allow so first-match-wins evaluator hits deny first
    const denyIdx = rules.findIndex((r) => r.effect === "deny");
    const allowIdx = rules.findIndex((r) => r.effect === "allow");
    expect(denyIdx).toBeLessThan(allowIdx);
  });
});
