/**
 * E2E: @koi/filesystem SkillComponent through the full createKoi runtime.
 *
 * Verifies that:
 * 1. skill:filesystem is attached to the agent's component map alongside fs tools.
 * 2. The skill content covers the key guidance (edit vs write, search vs list,
 *    read-before-edit, path safety).
 * 3. fs_read and fs_edit execute correctly through the full middleware stack
 *    against a stateful in-memory backend.
 * 4. The read-before-edit pattern (fs_read → fs_edit, not fs_write) completes
 *    successfully when forced via a deterministic model handler.
 *
 * Fully deterministic — no ANTHROPIC_API_KEY needed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  FileEditResult,
  FileListResult,
  FileReadResult,
  FileSearchResult,
  FileSystemBackend,
  FileWriteResult,
  KoiError,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Result,
  SkillComponent,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { skillToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createFileSystemProvider, FS_SKILL_NAME } from "@koi/filesystem";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODEL_NAME = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 30_000;

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

/**
 * Stateful in-memory FileSystemBackend.
 * Files are stored in a Map so edits persist across tool calls within a run.
 */
function createStatefulBackend(
  initialFiles: Record<string, string>,
): FileSystemBackend & { getFile: (path: string) => string | undefined } {
  const files = new Map(Object.entries(initialFiles));

  return {
    name: "e2e-in-memory",

    read: (path): Result<FileReadResult, KoiError> => {
      const content = files.get(path);
      if (content === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `File not found: ${path}`, retryable: false },
        };
      }
      return { ok: true, value: { content, path, size: content.length } };
    },

    write: (path, content): Result<FileWriteResult, KoiError> => {
      files.set(path, content);
      return { ok: true, value: { path, bytesWritten: content.length } };
    },

    edit: (path, edits): Result<FileEditResult, KoiError> => {
      let content = files.get(path);
      if (content === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `File not found: ${path}`, retryable: false },
        };
      }
      let hunksApplied = 0;
      for (const edit of edits) {
        if (content.includes(edit.oldText)) {
          content = content.replace(edit.oldText, edit.newText);
          hunksApplied++;
        }
      }
      files.set(path, content);
      return { ok: true, value: { path, hunksApplied } };
    },

    list: (_path): Result<FileListResult, KoiError> => ({
      ok: true,
      value: { entries: [], truncated: false },
    }),

    search: (_pattern): Result<FileSearchResult, KoiError> => ({
      ok: true,
      value: { matches: [], truncated: false },
    }),

    getFile: (path) => files.get(path),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("e2e: @koi/filesystem SkillComponent through full createKoi runtime", () => {
  let runtime: Awaited<ReturnType<typeof createKoi>> | undefined; // let justified: set per test, disposed in afterEach

  afterEach(async () => {
    await runtime?.dispose?.();
    runtime = undefined;
  });

  test(
    "skill:filesystem is attached to agent component map alongside fs tools",
    async () => {
      const backend = createStatefulBackend({ "/config.json": '{ "port": 3000 }' });
      const fsProvider = createFileSystemProvider({ backend });

      let _modelCallCount = 0; // let justified: tracks phase
      const modelCall = async (_request: ModelRequest): Promise<ModelResponse> => {
        _modelCallCount++;
        // Single phase: agent says done immediately (no tool calls needed)
        return {
          content: "Skill component verified.",
          model: MODEL_NAME,
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      runtime = await createKoi({
        manifest: {
          name: "e2e-fs-skill-presence",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        providers: [fsProvider],
      });

      // Verify the skill is attached to the agent's component map
      const skill = runtime.agent.component<SkillComponent>(skillToken(FS_SKILL_NAME));
      expect(skill).toBeDefined();
      expect(skill?.name).toBe(FS_SKILL_NAME);
      expect(skill?.description.length).toBeGreaterThan(0);
      expect(skill?.content.length).toBeGreaterThan(0);

      // Verify skill covers all key guidance areas
      expect(skill?.content).toContain("fs_edit");
      expect(skill?.content).toContain("fs_write");
      expect(skill?.content).toContain("fs_search");
      expect(skill?.content).toContain("fs_list");
      expect(skill?.content).toContain("fs_read");

      // Run to verify assembly is valid (agent completes without errors)
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Check component map." }),
      );
      expect(events.find((e) => e.kind === "done")).toBeDefined();
    },
    TIMEOUT_MS,
  );

  test(
    "fs_read executes through full runtime and returns file content",
    async () => {
      const initialContent = '{ "port": 3000, "host": "localhost" }';
      const backend = createStatefulBackend({ "/app/config.json": initialContent });
      const fsProvider = createFileSystemProvider({ backend });

      let toolResult: ToolResponse | undefined; // let justified: captured by middleware
      let modelCallCount = 0; // let justified: tracks phase

      const toolObserver: KoiMiddleware = {
        name: "e2e-fs-read-observer",
        wrapToolCall: async (
          _ctx,
          request: ToolRequest,
          next: ToolHandler,
        ): Promise<ToolResponse> => {
          const result = await next(request);
          if (request.toolId === "fs_read") {
            toolResult = result;
          }
          return result;
        },
      };

      const modelCall = async (_request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          // Phase 1: force fs_read
          return {
            content: "Let me read the config file first.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "fs_read",
                  callId: "call-read-1",
                  input: { path: "/app/config.json" },
                },
              ],
            },
          };
        }
        // Phase 2: done
        return {
          content: "File read successfully.",
          model: MODEL_NAME,
          usage: { inputTokens: 20, outputTokens: 5 },
        };
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      runtime = await createKoi({
        manifest: {
          name: "e2e-fs-read",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [toolObserver],
        providers: [fsProvider],
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Read the config file." }),
      );

      // Agent completed
      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();

      // fs_read was called and returned the file content
      expect(toolResult).toBeDefined();
      const output = toolResult?.output as { content: string; path: string };
      expect(output.content).toBe(initialContent);
      expect(output.path).toBe("/app/config.json");
    },
    TIMEOUT_MS,
  );

  test(
    "read-before-edit pattern: fs_read then fs_edit modifies the file correctly",
    async () => {
      const initialContent = '{ "port": 3000 }';
      const backend = createStatefulBackend({ "/app/config.json": initialContent });
      const fsProvider = createFileSystemProvider({ backend });

      const calledTools: string[] = []; // let justified: ordered call log
      let modelCallCount = 0; // let justified: tracks phase

      const toolObserver: KoiMiddleware = {
        name: "e2e-fs-skill-observer",
        wrapToolCall: async (
          _ctx,
          request: ToolRequest,
          next: ToolHandler,
        ): Promise<ToolResponse> => {
          calledTools.push(request.toolId);
          return next(request);
        },
      };

      const modelCall = async (_request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          // Phase 1: read first (skill says: always read before edit)
          return {
            content: "I will read the file first to confirm the exact text.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "fs_read",
                  callId: "call-read-1",
                  input: { path: "/app/config.json" },
                },
              ],
            },
          };
        }
        if (modelCallCount === 2) {
          // Phase 2: edit using exact text seen in phase 1
          // (skill says: use fs_edit for small changes, not fs_write)
          return {
            content: "Now I will apply the targeted edit.",
            model: MODEL_NAME,
            usage: { inputTokens: 30, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "fs_edit",
                  callId: "call-edit-1",
                  input: {
                    path: "/app/config.json",
                    edits: [{ oldText: '"port": 3000', newText: '"port": 8080' }],
                  },
                },
              ],
            },
          };
        }
        // Phase 3: done
        return {
          content: "Updated port to 8080.",
          model: MODEL_NAME,
          usage: { inputTokens: 50, outputTokens: 10 },
        };
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      runtime = await createKoi({
        manifest: {
          name: "e2e-fs-read-before-edit",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [toolObserver],
        providers: [fsProvider],
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Update the port to 8080 in /app/config.json." }),
      );

      // Agent completed
      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent?.kind === "done") {
        expect(doneEvent.output.stopReason).toBe("completed");
      }

      // read-before-edit pattern: fs_read came before fs_edit (not fs_write)
      expect(calledTools).toEqual(["fs_read", "fs_edit"]);
      expect(calledTools).not.toContain("fs_write");

      // File was actually modified in the in-memory backend
      expect(backend.getFile("/app/config.json")).toBe('{ "port": 8080 }');

      // Skill is present on the agent
      const skill = runtime.agent.component<SkillComponent>(skillToken(FS_SKILL_NAME));
      expect(skill).toBeDefined();
      expect(skill?.content).toContain("fs_edit");
    },
    TIMEOUT_MS,
  );
});
