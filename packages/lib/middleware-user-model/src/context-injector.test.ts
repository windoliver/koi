import { describe, expect, test } from "bun:test";
import type { UserSnapshot } from "@koi/core";
import { buildContextMessage, formatUserContext } from "./context-injector.js";

const budgets = {
  maxPreferenceTokens: 400,
  maxSensorTokens: 100,
  maxMetaTokens: 100,
};

describe("formatUserContext", () => {
  test("renders preferences + sensor state inside [User Context] block", () => {
    const snapshot: UserSnapshot = {
      preferences: [{ content: "prefers YAML" }],
      state: { ide: { lang: "ts" } },
      ambiguityDetected: false,
    };
    const text = formatUserContext(snapshot, budgets);
    expect(text.startsWith("[User Context]")).toBe(true);
    expect(text.endsWith("[/User Context]")).toBe(true);
    expect(text).toContain("Preferences:");
    expect(text).toContain("prefers YAML");
    expect(text).toContain("Sensor State:");
    expect(text).toContain('ide: {"lang":"ts"}');
  });

  test("renders clarification when ambiguity is set", () => {
    const snapshot: UserSnapshot = {
      preferences: [],
      state: {},
      ambiguityDetected: true,
      suggestedQuestion: "Need more context?",
    };
    const text = formatUserContext(snapshot, budgets);
    expect(text).toContain("Clarification:");
    expect(text).toContain("Need more context?");
  });
});

describe("buildContextMessage", () => {
  test("emits a pinned system message", () => {
    const msg = buildContextMessage("hello");
    expect(msg.pinned).toBe(true);
    expect(msg.senderId).toBe("context:user-model");
    expect(msg.content[0]?.kind).toBe("text");
  });
});
