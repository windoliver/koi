/**
 * Test helpers for @koi/code-mode — mock FileSystemBackend and Agent.
 */

import type {
  Agent,
  FileDeleteResult,
  FileEditResult,
  FileListResult,
  FileReadResult,
  FileRenameResult,
  FileSearchResult,
  FileSystemBackend,
  FileWriteResult,
  KoiError,
  Result,
  SubsystemToken,
} from "@koi/core";
import { agentId, FILESYSTEM } from "@koi/core";

/**
 * Create an in-memory mock FileSystemBackend with configurable initial files.
 */
export function createMockBackend(
  initialFiles: Record<string, string> = {},
  name = "mock",
): FileSystemBackend {
  /* let justified: mutable store representing filesystem state */
  const files = new Map<string, string>(Object.entries(initialFiles));

  return {
    name,

    read: (path: string): Result<FileReadResult, KoiError> => {
      const content = files.get(path);
      if (content === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `File not found: ${path}`,
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        value: { content, path, size: new TextEncoder().encode(content).byteLength },
      };
    },

    write: (path: string, content: string): Result<FileWriteResult, KoiError> => {
      files.set(path, content);
      return {
        ok: true,
        value: { path, bytesWritten: new TextEncoder().encode(content).byteLength },
      };
    },

    edit: (
      path: string,
      edits: readonly { readonly oldText: string; readonly newText: string }[],
    ): Result<FileEditResult, KoiError> => {
      const existing = files.get(path);
      if (existing === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `File not found: ${path}`,
            retryable: false,
          },
        };
      }
      /* let justified: accumulate edits into file content */
      let content = existing;
      for (const edit of edits) {
        content = content.replace(edit.oldText, edit.newText);
      }
      files.set(path, content);
      return { ok: true, value: { path, hunksApplied: edits.length } };
    },

    list: (path: string): Result<FileListResult, KoiError> => {
      const entries = [...files.keys()]
        .filter((p) => p.startsWith(path))
        .map((p) => ({ path: p, kind: "file" as const, size: 0 }));
      return { ok: true, value: { entries, truncated: false } };
    },

    search: (pattern: string): Result<FileSearchResult, KoiError> => {
      const matches = [...files.entries()]
        .filter(([, content]) => content.includes(pattern))
        .map(([path]) => ({ path, line: 1, text: pattern }));
      return { ok: true, value: { matches, truncated: false } };
    },

    delete: (path: string): Result<FileDeleteResult, KoiError> => {
      if (!files.has(path)) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `File not found: ${path}`,
            retryable: false,
          },
        };
      }
      files.delete(path);
      return { ok: true, value: { path } };
    },

    rename: (from: string, to: string): Result<FileRenameResult, KoiError> => {
      const content = files.get(from);
      if (content === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `File not found: ${from}`,
            retryable: false,
          },
        };
      }
      if (files.has(to)) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Destination already exists: ${to}`,
            retryable: false,
          },
        };
      }
      files.delete(from);
      files.set(to, content);
      return { ok: true, value: { from, to } };
    },
  };
}

/**
 * Create a backend that fails all operations.
 */
export function createFailingBackend(name = "failing"): FileSystemBackend {
  const error: KoiError = {
    code: "INTERNAL",
    message: "backend unavailable",
    retryable: false,
  };
  return {
    name,
    read: () => ({ ok: false, error }),
    write: () => ({ ok: false, error }),
    edit: () => ({ ok: false, error }),
    list: () => ({ ok: false, error }),
    search: () => ({ ok: false, error }),
    delete: () => ({ ok: false, error }),
    rename: () => ({ ok: false, error }),
  };
}

/**
 * Create a mock Agent with an optional FileSystemBackend component.
 */
export function createMockAgent(backend?: FileSystemBackend): Agent {
  const components = new Map<string, unknown>();
  if (backend !== undefined) {
    components.set(FILESYSTEM as string, backend);
  }

  return {
    pid: { id: agentId("test-agent"), name: "test", type: "worker", depth: 0 },
    manifest: {
      name: "test-agent",
      version: "0.0.0",
      model: { name: "test-model" },
    },
    state: "running",
    component: <T>(token: { toString: () => string }): T | undefined =>
      components.get(token.toString()) as T | undefined,
    has: (token: { toString: () => string }): boolean => components.has(token.toString()),
    hasAll: (...tokens: readonly { toString: () => string }[]): boolean =>
      tokens.every((t) => components.has(t.toString())),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}
