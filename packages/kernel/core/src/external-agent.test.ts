import { describe, expect, test } from "bun:test";
import type { ExternalAgentDescriptor, ExternalAgentProtocol } from "./external-agent.js";

describe("ExternalAgentDescriptor", () => {
  test("backward compat — descriptors without protocol default to undefined", () => {
    const legacy: ExternalAgentDescriptor = {
      name: "legacy-agent",
      transport: "cli",
      capabilities: ["code-generation"],
      source: "path",
    };
    expect(legacy.protocol).toBeUndefined();
  });

  test("descriptors with acp protocol compile correctly", () => {
    const agent: ExternalAgentDescriptor = {
      name: "claude-code",
      transport: "cli",
      command: "claude",
      capabilities: ["code-generation"],
      source: "path",
      protocol: "acp",
    };
    expect(agent.protocol).toBe("acp");
  });

  test("descriptors with stdio protocol compile correctly", () => {
    const agent: ExternalAgentDescriptor = {
      name: "aider",
      transport: "cli",
      command: "aider",
      capabilities: ["code-generation"],
      source: "path",
      protocol: "stdio",
    };
    expect(agent.protocol).toBe("stdio");
  });

  test("ExternalAgentProtocol type is string union", () => {
    const protocols: readonly ExternalAgentProtocol[] = ["acp", "stdio"];
    expect(protocols).toHaveLength(2);
  });
});
