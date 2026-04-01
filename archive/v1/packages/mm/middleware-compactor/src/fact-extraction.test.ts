import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import type { HeuristicPattern } from "./fact-extraction.js";
import {
  DEFAULT_HEURISTIC_PATTERNS,
  extractFacts,
  resolveFactExtractionConfig,
} from "./fact-extraction.js";

function userMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: 1 };
}

function toolMsg(text: string, toolName?: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: 1,
    ...(toolName !== undefined ? { metadata: { toolName } } : {}),
  };
}

describe("heuristic extraction", () => {
  const config = resolveFactExtractionConfig();

  test("extracts artifact facts from write_file tool results", () => {
    const msgs = [toolMsg("Created src/index.ts successfully", "write_file")];
    const facts = extractFacts(msgs, config);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe("artifact");
  });

  test("extracts decision facts from decision keywords", () => {
    const msgs = [userMsg("We decided to use React for the frontend")];
    const facts = extractFacts(msgs, config);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe("decision");
    expect(facts[0]?.text).toContain("decided");
  });

  test("extracts resolution facts from error resolution patterns", () => {
    const msgs = [userMsg("The issue was resolved by updating the dependency version")];
    const facts = extractFacts(msgs, config);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe("resolution");
  });

  test("extracts configuration facts from setting changes", () => {
    const msgs = [userMsg("I configured the timeout to 30 seconds")];
    const facts = extractFacts(msgs, config);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe("configuration");
  });

  test("extracts artifact facts from file paths in tool results", () => {
    const msgs = [toolMsg("Modified /src/components/Button.tsx")];
    const facts = extractFacts(msgs, config);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe("artifact");
    expect(facts[0]?.text).toContain("/src/components/Button.tsx");
  });

  test("skips messages below minFactLength", () => {
    const shortConfig = resolveFactExtractionConfig({ minFactLength: 100 });
    const msgs = [userMsg("We decided X")];
    const facts = extractFacts(msgs, shortConfig);
    expect(facts).toHaveLength(0);
  });

  test("custom patterns override defaults", () => {
    const customPattern: HeuristicPattern = {
      match: /\bcustom\b/i,
      category: "custom-category",
    };
    const customConfig = resolveFactExtractionConfig({
      patterns: [customPattern],
    });
    const msgs = [userMsg("This is a custom message for testing")];
    const facts = extractFacts(msgs, customConfig);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe("custom-category");
  });

  test("returns empty array for messages with no matching patterns", () => {
    const msgs = [userMsg("Hello, how are you today?")];
    const facts = extractFacts(msgs, config);
    expect(facts).toHaveLength(0);
  });

  test("first match wins per message", () => {
    // A message matching both decision and resolution should only produce one fact
    const msgs = [userMsg("We decided the issue was resolved by updating")];
    const facts = extractFacts(msgs, config);
    expect(facts).toHaveLength(1);
    // "decided" matches DECISION_PATTERN first
    expect(facts[0]?.category).toBe("decision");
  });

  test("default patterns are frozen", () => {
    expect(Object.isFrozen(DEFAULT_HEURISTIC_PATTERNS)).toBe(true);
  });

  test("resolveFactExtractionConfig applies defaults", () => {
    const resolved = resolveFactExtractionConfig();
    expect(resolved.strategy).toBe("heuristic");
    expect(resolved.patterns).toBe(DEFAULT_HEURISTIC_PATTERNS);
    expect(resolved.minFactLength).toBe(10);
    expect(resolved.reinforce).toBe(true);
  });

  test("resolveFactExtractionConfig respects overrides", () => {
    const resolved = resolveFactExtractionConfig({
      minFactLength: 50,
      reinforce: false,
    });
    expect(resolved.minFactLength).toBe(50);
    expect(resolved.reinforce).toBe(false);
  });
});
