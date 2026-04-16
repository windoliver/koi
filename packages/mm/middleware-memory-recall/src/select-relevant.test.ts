import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core";
import type { MemoryManifestEntry } from "./select-relevant.js";
import {
  buildSelectorPrompt,
  parseSelectorResponse,
  selectRelevantMemories,
} from "./select-relevant.js";

// ---------------------------------------------------------------------------
// parseSelectorResponse
// ---------------------------------------------------------------------------

describe("parseSelectorResponse", () => {
  test("parses raw JSON array", () => {
    const result = parseSelectorResponse('["file1.md", "file2.md"]');
    expect(result).toEqual(["file1.md", "file2.md"]);
  });

  test("parses JSON in markdown code block", () => {
    const result = parseSelectorResponse('```json\n["a.md", "b.md"]\n```');
    expect(result).toEqual(["a.md", "b.md"]);
  });

  test("parses JSON in plain code block", () => {
    const result = parseSelectorResponse('```\n["x.md"]\n```');
    expect(result).toEqual(["x.md"]);
  });

  test("extracts JSON array from surrounding text", () => {
    const result = parseSelectorResponse(
      'The most relevant files are:\n["one.md", "two.md"]\nThese cover your query.',
    );
    expect(result).toEqual(["one.md", "two.md"]);
  });

  test("returns empty array for empty JSON array", () => {
    const result = parseSelectorResponse("[]");
    expect(result).toEqual([]);
  });

  test("returns empty array for non-JSON response", () => {
    const result = parseSelectorResponse("I cannot determine relevant files.");
    expect(result).toEqual([]);
  });

  test("returns empty array for non-string array", () => {
    const result = parseSelectorResponse("[1, 2, 3]");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildSelectorPrompt
// ---------------------------------------------------------------------------

describe("buildSelectorPrompt", () => {
  test("includes manifest entries and user message", () => {
    const manifest: readonly MemoryManifestEntry[] = [
      { name: "Role", description: "User is an engineer", type: "user", id: "role.md" },
      { name: "DB tip", description: "Use integration tests", type: "feedback", id: "db.md" },
    ];
    const prompt = buildSelectorPrompt(manifest, "How do I test the database?", 3);

    expect(prompt).toContain('[user] "Role"');
    expect(prompt).toContain('[feedback] "DB tip"');
    expect(prompt).toContain("How do I test the database?");
    expect(prompt).toContain("3");
  });
});

// ---------------------------------------------------------------------------
// selectRelevantMemories
// ---------------------------------------------------------------------------

describe("selectRelevantMemories", () => {
  const manifest: readonly MemoryManifestEntry[] = [
    { name: "Role", description: "User is a senior engineer", type: "user", id: "role.md" },
    {
      name: "DB testing",
      description: "Use integration tests for DB",
      type: "feedback",
      id: "db.md",
    },
    { name: "Dark mode", description: "User prefers dark mode", type: "user", id: "dark.md" },
    {
      name: "Deploy notes",
      description: "Deploy to staging first",
      type: "project",
      id: "deploy.md",
    },
    {
      name: "Slack ref",
      description: "Bugs in #eng-bugs channel",
      type: "reference",
      id: "slack.md",
    },
    {
      name: "API key",
      description: "OpenRouter key in .env",
      type: "reference",
      id: "api.md",
    },
  ];

  test("returns all paths when manifest fits within maxFiles", async () => {
    const small = manifest.slice(0, 3);
    const result = await selectRelevantMemories(small, "anything", {
      modelCall: async () => ({ content: "[]", model: "test" }),
      maxFiles: 5,
    });
    expect(result).toEqual(["role.md", "db.md", "dark.md"]);
  });

  test("returns empty for empty manifest", async () => {
    const result = await selectRelevantMemories([], "query", {
      modelCall: async () => ({ content: "[]", model: "test" }),
    });
    expect(result).toEqual([]);
  });

  test("calls model and parses selected paths", async () => {
    const mockModelCall = async (_req: ModelRequest): Promise<ModelResponse> => ({
      content: '["db.md", "deploy.md"]',
      model: "test",
    });

    const result = await selectRelevantMemories(manifest, "database testing", {
      modelCall: mockModelCall,
      maxFiles: 3,
    });

    expect(result).toEqual(["db.md", "deploy.md"]);
  });

  test("filters out paths not in manifest", async () => {
    const mockModelCall = async (_req: ModelRequest): Promise<ModelResponse> => ({
      content: '["db.md", "nonexistent.md", "role.md"]',
      model: "test",
    });

    const result = await selectRelevantMemories(manifest, "query", {
      modelCall: mockModelCall,
      maxFiles: 5,
    });

    expect(result).toEqual(["db.md", "role.md"]);
  });

  test("returns empty on model error (graceful degradation)", async () => {
    const mockModelCall = async (): Promise<ModelResponse> => {
      throw new Error("model unavailable");
    };

    const result = await selectRelevantMemories(manifest, "query", {
      modelCall: mockModelCall,
      maxFiles: 3,
    });

    expect(result).toEqual([]);
  });

  test("returns empty when model returns no selections", async () => {
    const mockModelCall = async (_req: ModelRequest): Promise<ModelResponse> => ({
      content: "[]",
      model: "test",
    });

    const result = await selectRelevantMemories(manifest, "unrelated topic", {
      modelCall: mockModelCall,
      maxFiles: 3,
    });

    expect(result).toEqual([]);
  });
});
