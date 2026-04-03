import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import { createDefaultReflector } from "./reflector.js";
import type { ReflectorInput, StructuredPlaybook, TrajectoryEntry } from "./types.js";

function makeTrajectoryEntry(overrides?: Partial<TrajectoryEntry>): TrajectoryEntry {
  return {
    turnIndex: 0,
    timestamp: 1000,
    kind: "tool_call",
    identifier: "read-file",
    outcome: "success",
    durationMs: 50,
    ...overrides,
  };
}

function makePlaybook(): StructuredPlaybook {
  return {
    id: "pb-1",
    title: "Test",
    sections: [
      {
        name: "Strategy",
        slug: "str",
        bullets: [
          {
            id: "[str-00001]",
            content: "Cache reads",
            helpful: 3,
            harmful: 0,
            createdAt: 1000,
            updatedAt: 1000,
          },
          {
            id: "[str-00002]",
            content: "Retry errors",
            helpful: 1,
            harmful: 2,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
      },
    ],
    tags: [],
    source: "curated",
    createdAt: 1000,
    updatedAt: 1000,
    sessionCount: 1,
  };
}

function makeInput(overrides?: Partial<ReflectorInput>): ReflectorInput {
  return {
    trajectory: [
      makeTrajectoryEntry({ outcome: "success" }),
      makeTrajectoryEntry({ identifier: "write-file", outcome: "failure" }),
    ],
    citedBulletIds: ["[str-00001]"],
    outcome: "mixed",
    playbook: makePlaybook(),
    ...overrides,
  };
}

describe("createDefaultReflector", () => {
  test("parses valid JSON reflection response", async () => {
    const modelCall = async (_msgs: readonly InboundMessage[]): Promise<string> =>
      JSON.stringify({
        rootCause: "Write operations failed due to permissions",
        keyInsight: "Check file permissions before writing",
        bulletTags: [{ id: "[str-00001]", tag: "helpful" }],
      });

    const reflector = createDefaultReflector(modelCall);
    const result = await reflector.analyze(makeInput());

    expect(result.rootCause).toBe("Write operations failed due to permissions");
    expect(result.keyInsight).toBe("Check file permissions before writing");
    expect(result.bulletTags).toHaveLength(1);
    expect(result.bulletTags[0]?.id).toBe("[str-00001]");
    expect(result.bulletTags[0]?.tag).toBe("helpful");
  });

  test("returns empty reflection for empty trajectory", async () => {
    const modelCall = async (): Promise<string> =>
      JSON.stringify({
        rootCause: "",
        keyInsight: "",
        bulletTags: [],
      });

    const reflector = createDefaultReflector(modelCall);
    const result = await reflector.analyze(makeInput({ trajectory: [], citedBulletIds: [] }));

    expect(result.rootCause).toBe("");
    expect(result.keyInsight).toBe("");
    expect(result.bulletTags).toHaveLength(0);
  });

  test("throws on malformed LLM response", async () => {
    const modelCall = async (): Promise<string> => "not valid json at all {{{}}}";

    const reflector = createDefaultReflector(modelCall);
    await expect(reflector.analyze(makeInput())).rejects.toThrow(
      "ACE reflector: failed to parse LLM response",
    );
  });

  test("propagates error when LLM throws", async () => {
    const modelCall = async (): Promise<string> => {
      throw new Error("API timeout");
    };

    const reflector = createDefaultReflector(modelCall);
    await expect(reflector.analyze(makeInput())).rejects.toThrow("API timeout");
  });

  test("maps cited bullets correctly to tags", async () => {
    const modelCall = async (): Promise<string> =>
      JSON.stringify({
        rootCause: "Mixed results",
        keyInsight: "Refine approach",
        bulletTags: [
          { id: "[str-00001]", tag: "helpful" },
          { id: "[str-00002]", tag: "harmful" },
        ],
      });

    const reflector = createDefaultReflector(modelCall);
    const result = await reflector.analyze(
      makeInput({ citedBulletIds: ["[str-00001]", "[str-00002]"] }),
    );

    expect(result.bulletTags).toHaveLength(2);
    expect(result.bulletTags[0]).toEqual({ id: "[str-00001]", tag: "helpful" });
    expect(result.bulletTags[1]).toEqual({ id: "[str-00002]", tag: "harmful" });
  });

  test("filters out invalid bullet tags", async () => {
    const modelCall = async (): Promise<string> =>
      JSON.stringify({
        rootCause: "Test",
        keyInsight: "Test",
        bulletTags: [
          { id: "[str-00001]", tag: "helpful" },
          { id: "[unknown-99999]", tag: "helpful" },
          { id: "[str-00001]", tag: "invalid-tag" },
          "not-an-object",
        ],
      });

    const reflector = createDefaultReflector(modelCall);
    const result = await reflector.analyze(makeInput());

    // Only the first tag is valid (known ID + valid tag)
    expect(result.bulletTags).toHaveLength(1);
    expect(result.bulletTags[0]?.id).toBe("[str-00001]");
  });

  test("produces root cause and insight even without cited bullets", async () => {
    const modelCall = async (): Promise<string> =>
      JSON.stringify({
        rootCause: "No specific pattern",
        keyInsight: "Gather more data",
        bulletTags: [],
      });

    const reflector = createDefaultReflector(modelCall);
    const result = await reflector.analyze(makeInput({ citedBulletIds: [] }));

    expect(result.rootCause).toBe("No specific pattern");
    expect(result.keyInsight).toBe("Gather more data");
    expect(result.bulletTags).toHaveLength(0);
  });

  test("handles markdown-fenced JSON response", async () => {
    const modelCall = async (): Promise<string> =>
      '```json\n{"rootCause": "test", "keyInsight": "test", "bulletTags": []}\n```';

    const reflector = createDefaultReflector(modelCall);
    const result = await reflector.analyze(makeInput());

    expect(result.rootCause).toBe("test");
    expect(result.keyInsight).toBe("test");
  });

  test("passes trajectory to model call message", async () => {
    let capturedMessages: readonly InboundMessage[] = [];
    const modelCall = async (msgs: readonly InboundMessage[]): Promise<string> => {
      capturedMessages = msgs;
      return JSON.stringify({ rootCause: "", keyInsight: "", bulletTags: [] });
    };

    const reflector = createDefaultReflector(modelCall);
    await reflector.analyze(makeInput());

    expect(capturedMessages).toHaveLength(1);
    const content = capturedMessages[0]?.content[0];
    expect(content?.kind).toBe("text");
    if (content?.kind === "text") {
      expect(content.text).toContain("read-file");
      expect(content.text).toContain("write-file");
      expect(content.text).toContain("[str-00001]");
    }
  });
});
