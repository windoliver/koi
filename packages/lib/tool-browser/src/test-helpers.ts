/**
 * Shared test helpers for @koi/tool-browser tests.
 *
 * Test convention — each tool test file MUST cover:
 *   1. Happy path (success case)
 *   2. Missing required arg (VALIDATION error)
 *   3. Invalid arg type (VALIDATION error)
 *   4. Tool-specific failure mode (e.g., STALE_REF, NOT_FOUND, driver error)
 */

import type {
  Agent,
  BrowserActionOptions,
  BrowserConsoleOptions,
  BrowserConsoleResult,
  BrowserDriver,
  BrowserEvaluateOptions,
  BrowserEvaluateResult,
  BrowserFormField,
  BrowserNavigateOptions,
  BrowserNavigateResult,
  BrowserRefInfo,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserScrollOptions,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserTabCloseOptions,
  BrowserTabFocusOptions,
  BrowserTabInfo,
  BrowserTabNewOptions,
  BrowserTraceOptions,
  BrowserTraceResult,
  BrowserTypeOptions,
  BrowserUploadFile,
  BrowserUploadOptions,
  BrowserWaitOptions,
  KoiError,
  KoiErrorCode,
  Result,
  SubsystemToken,
} from "@koi/core";
import { agentId } from "@koi/core";

export interface MockDriverOptions {
  /** Force all operations to fail with this error code. */
  readonly failWith?: KoiErrorCode;
  /**
   * When set, interaction methods will return a NOT_FOUND stale-ref error
   * if the caller passes this snapshotId value.
   */
  readonly staleSnapshotId?: string;
}

const MOCK_SNAPSHOT_ID = "snap-mock-001";

function makeError(code: KoiErrorCode): KoiError {
  return { code, message: `mock error: ${code}`, retryable: false };
}

function makeStaleError(): KoiError {
  return {
    code: "STALE_REF",
    message:
      "Snapshot is stale — the page has changed since this snapshot was taken. " +
      "Call browser_snapshot to get fresh refs.",
    retryable: false,
  };
}

export function createMockDriver(options: MockDriverOptions = {}): BrowserDriver {
  const { failWith, staleSnapshotId } = options;

  function fail<T>(): Result<T, KoiError> {
    return { ok: false, error: makeError(failWith ?? "INTERNAL") };
  }

  function checkStale(snapshotId?: string): KoiError | undefined {
    if (staleSnapshotId !== undefined && snapshotId === staleSnapshotId) {
      return makeStaleError();
    }
    return undefined;
  }

  return {
    name: "mock",

    snapshot: (_options?: BrowserSnapshotOptions): Result<BrowserSnapshotResult, KoiError> => {
      if (failWith) return fail();
      const refs: Record<string, BrowserRefInfo> = {
        e1: { role: "button", name: "Submit" },
        e2: { role: "link", name: "Home" },
        e3: { role: "textbox", name: "Email" },
      };
      return {
        ok: true,
        value: {
          snapshot:
            "[heading] Welcome [level=1]\n  [button] Submit [ref=e1]\n  [link] Home [ref=e2]\n  [textbox] Email [ref=e3]",
          snapshotId: MOCK_SNAPSHOT_ID,
          refs,
          truncated: false,
          url: "https://example.com",
          title: "Example Page",
        },
      };
    },

    navigate: (
      _url: string,
      _options?: BrowserNavigateOptions,
    ): Result<BrowserNavigateResult, KoiError> => {
      if (failWith) return fail();
      return { ok: true, value: { url: _url, title: "Navigated Page" } };
    },

    click: (_ref: string, options?: { snapshotId?: string }): Result<void, KoiError> => {
      if (failWith) return fail();
      const staleErr = checkStale(options?.snapshotId);
      if (staleErr) return { ok: false, error: staleErr };
      return { ok: true, value: undefined };
    },

    hover: (_ref: string, options?: { snapshotId?: string }): Result<void, KoiError> => {
      if (failWith) return fail();
      const staleErr = checkStale(options?.snapshotId);
      if (staleErr) return { ok: false, error: staleErr };
      return { ok: true, value: undefined };
    },

    press: (_key: string, _options?: BrowserActionOptions): Result<void, KoiError> => {
      if (failWith) return fail();
      return { ok: true, value: undefined };
    },

    type: (_ref: string, _value: string, options?: BrowserTypeOptions): Result<void, KoiError> => {
      if (failWith) return fail();
      const staleErr = checkStale(options?.snapshotId);
      if (staleErr) return { ok: false, error: staleErr };
      return { ok: true, value: undefined };
    },

    select: (
      _ref: string,
      _value: string,
      options?: { snapshotId?: string },
    ): Result<void, KoiError> => {
      if (failWith) return fail();
      const staleErr = checkStale(options?.snapshotId);
      if (staleErr) return { ok: false, error: staleErr };
      return { ok: true, value: undefined };
    },

    fillForm: (
      _fields: readonly BrowserFormField[],
      options?: { snapshotId?: string },
    ): Result<void, KoiError> => {
      if (failWith) return fail();
      const staleErr = checkStale(options?.snapshotId);
      if (staleErr) return { ok: false, error: staleErr };
      return { ok: true, value: undefined };
    },

    scroll: (_options: BrowserScrollOptions): Result<void, KoiError> => {
      if (failWith) return fail();
      return { ok: true, value: undefined };
    },

    screenshot: (
      _options?: BrowserScreenshotOptions,
    ): Result<BrowserScreenshotResult, KoiError> => {
      if (failWith) return fail();
      return {
        ok: true,
        value: {
          data: "base64encodedmockimage",
          mimeType: "image/jpeg",
          width: 1280,
          height: 720,
        },
      };
    },

    wait: (_options: BrowserWaitOptions): Result<void, KoiError> => {
      if (failWith) return fail();
      return { ok: true, value: undefined };
    },

    tabNew: (_options?: BrowserTabNewOptions): Result<BrowserTabInfo, KoiError> => {
      if (failWith) return fail();
      return {
        ok: true,
        value: { tabId: "tab-new-1", url: _options?.url ?? "about:blank", title: "New Tab" },
      };
    },

    tabClose: (_tabId?: string, _options?: BrowserTabCloseOptions): Result<void, KoiError> => {
      if (failWith) return fail();
      return { ok: true, value: undefined };
    },

    tabFocus: (
      tabId: string,
      _options?: BrowserTabFocusOptions,
    ): Result<BrowserTabInfo, KoiError> => {
      if (failWith) return fail();
      return {
        ok: true,
        value: { tabId, url: "https://example.com", title: "Focused Tab" },
      };
    },

    evaluate: (
      _script: string,
      _options?: BrowserEvaluateOptions,
    ): Result<BrowserEvaluateResult, KoiError> => {
      if (failWith) return fail();
      return { ok: true, value: { value: "mock-eval-result" } };
    },

    tabList: (): Result<readonly BrowserTabInfo[], KoiError> => {
      if (failWith) return fail();
      return {
        ok: true,
        value: [{ tabId: "tab-1", url: "https://example.com", title: "Example Page" }],
      };
    },

    console: async (
      _options?: BrowserConsoleOptions,
    ): Promise<Result<BrowserConsoleResult, KoiError>> => {
      if (failWith) return fail();
      return { ok: true, value: { entries: [], total: 0 } };
    },

    upload: (
      _ref: string,
      _files: readonly BrowserUploadFile[],
      _options?: BrowserUploadOptions,
    ): Result<void, KoiError> => {
      if (failWith) return fail();
      return { ok: true, value: undefined };
    },

    traceStart: (_options?: BrowserTraceOptions): Result<void, KoiError> => {
      if (failWith) return fail();
      return { ok: true, value: undefined };
    },

    traceStop: (): Result<BrowserTraceResult, KoiError> => {
      if (failWith) return fail();
      return { ok: true, value: { path: "/tmp/koi-trace-mock.zip" } };
    },
  };
}

export function createMockAgent(): Agent {
  const components = new Map<string, unknown>();
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
