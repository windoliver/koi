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
    expect(allowRules).toHaveLength(2);
    // "Read(*)" → pattern "Read**" matches plain "Read" and enriched "Read:/path"
    expect(allowRules[0]?.pattern).toBe("Read**");
    expect(allowRules[0]?.action).toBe("invoke");
    expect(allowRules[0]?.source).toBe("user");
  });

  test("deny strings become SourcedRules with effect=deny and command in pattern", () => {
    const settings: KoiSettings = {
      permissions: { deny: ["Bash(rm -rf*)"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "local");
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
    expect(rules[0]?.effect).toBe("ask");
    expect(rules[0]?.pattern).toBe("Bash:git push*");
    expect(rules[0]?.action).toBe("invoke");
  });

  test("bare tool name (no parens) uses double-star pattern to match any invocation", () => {
    const settings: KoiSettings = {
      permissions: { deny: ["WebFetch"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "policy");
    // "WebFetch" → "WebFetch**" matches plain "WebFetch" and enriched "WebFetch:url"
    expect(rules[0]?.pattern).toBe("WebFetch**");
    expect(rules[0]?.action).toBe("invoke");
  });

  test("wildcard '*' becomes pattern='**' action='invoke'", () => {
    const settings: KoiSettings = {
      permissions: { allow: ["*"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "flag");
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
        allow: ["Bash**"],
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
