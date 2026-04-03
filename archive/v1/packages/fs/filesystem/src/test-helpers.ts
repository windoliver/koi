/**
 * Shared test helpers for @koi/filesystem tests.
 */

import type {
  FileEditResult,
  FileListResult,
  FileReadResult,
  FileSearchResult,
  FileSystemBackend,
  FileWriteResult,
  KoiError,
  Result,
} from "@koi/core";

export { createMockAgent } from "@koi/test-utils";

export function createMockBackend(name = "mock"): FileSystemBackend {
  return {
    name,
    read: (_path, _options?) =>
      ({
        ok: true,
        value: { content: "file content", path: _path, size: 12 },
      }) satisfies Result<FileReadResult, KoiError>,
    write: (_path, _content, _options?) =>
      ({
        ok: true,
        value: { path: _path, bytesWritten: _content.length },
      }) satisfies Result<FileWriteResult, KoiError>,
    edit: (_path, edits, _options?) =>
      ({
        ok: true,
        value: { path: _path, hunksApplied: edits.length },
      }) satisfies Result<FileEditResult, KoiError>,
    list: (_path, _options?) =>
      ({
        ok: true,
        value: {
          entries: [{ path: `${_path}/file.ts`, kind: "file" as const, size: 100 }],
          truncated: false,
        },
      }) satisfies Result<FileListResult, KoiError>,
    search: (_pattern, _options?) =>
      ({
        ok: true,
        value: {
          matches: [{ path: "/src/index.ts", line: 1, text: _pattern }],
          truncated: false,
        },
      }) satisfies Result<FileSearchResult, KoiError>,
  };
}

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
  };
}
