/**
 * On-demand relevance selector — picks the most relevant memory files
 * for the current user query using a lightweight model side-query.
 *
 * Pattern: CC's findRelevantMemories() but model-agnostic.
 * The caller injects any ModelHandler (Haiku for cost, Sonnet for quality,
 * local model for privacy).
 */

import type { ModelHandler } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A memory manifest entry — lightweight metadata for the selector prompt. */
export interface MemoryManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly filePath: string;
}

/** Configuration for the relevance selector. */
export interface RelevanceSelectorConfig {
  /** Model call function for the side-query. */
  readonly modelCall: ModelHandler;
  /** Maximum files to select. Default: 5. */
  readonly maxFiles?: number | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILES = 5;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the selector prompt. The model receives a manifest of memory
 * file descriptions and the user's current message, then returns a
 * JSON array of selected file paths.
 */
export function buildSelectorPrompt(
  manifest: readonly MemoryManifestEntry[],
  userMessage: string,
  maxFiles: number,
): string {
  const entries = manifest
    .map((m) => `- [${m.type}] "${m.name}" (${m.filePath}): ${m.description}`)
    .join("\n");

  return `You are a memory relevance selector. Given a user's message and a list of stored memory files, pick the ${String(maxFiles)} most relevant files.

## Memory files

${entries}

## User's current message

${userMessage}

## Instructions

Return ONLY a JSON array of file paths for the most relevant memories. Pick at most ${String(maxFiles)}.
Only include memories you are confident will be helpful based on their name and description.
If none are relevant, return an empty array.

Example response: ["/path/file1.md", "/path/file2.md"]`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parses the selector model's response into an array of file paths.
 * Handles both raw JSON arrays and JSON embedded in markdown code blocks.
 * Returns empty array on parse failure (graceful degradation).
 */
export function parseSelectorResponse(response: string): readonly string[] {
  const trimmed = response.trim();

  // Try direct JSON parse first
  const direct = tryParseJsonArray(trimmed);
  if (direct !== undefined) return direct;

  // Try extracting from markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1] !== undefined) {
    const inner = tryParseJsonArray(codeBlockMatch[1].trim());
    if (inner !== undefined) return inner;
  }

  // Try finding a JSON array anywhere in the response
  const arrayMatch = trimmed.match(/\[[\s\S]*?\]/);
  if (arrayMatch !== null) {
    const found = tryParseJsonArray(arrayMatch[0]);
    if (found !== undefined) return found;
  }

  return [];
}

function tryParseJsonArray(text: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as readonly string[];
    }
  } catch {
    // Not valid JSON
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

/**
 * Selects the most relevant memory files for the current user query.
 *
 * Calls a lightweight model with the memory manifest + user message,
 * returns the file paths of selected memories. Errors are swallowed
 * (returns empty array on failure).
 */
export async function selectRelevantMemories(
  manifest: readonly MemoryManifestEntry[],
  userMessage: string,
  selectorConfig: RelevanceSelectorConfig,
): Promise<readonly string[]> {
  if (manifest.length === 0) return [];

  const maxFiles = selectorConfig.maxFiles ?? DEFAULT_MAX_FILES;

  // Skip selector if manifest fits within maxFiles — all are relevant
  if (manifest.length <= maxFiles) {
    return manifest.map((m) => m.filePath);
  }

  const prompt = buildSelectorPrompt(manifest, userMessage, maxFiles);

  try {
    const response = await selectorConfig.modelCall({
      messages: [
        {
          content: [{ kind: "text", text: prompt }],
          senderId: "system:memory-selector",
          timestamp: Date.now(),
        },
      ],
      maxTokens: 256,
    });

    const responseText = response.content;

    const selected = parseSelectorResponse(responseText);

    // Validate paths exist in the manifest
    const validPaths = new Set(manifest.map((m) => m.filePath));
    return selected.filter((p) => validPaths.has(p));
  } catch (_e: unknown) {
    console.warn("[memory-recall] relevance selector failed (swallowed)");
    return [];
  }
}
