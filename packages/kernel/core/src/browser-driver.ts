/**
 * Browser driver contract — cross-engine abstraction for browser automation.
 *
 * Engines discover browser tools via `agent.query<Tool>("tool:")` — the
 * driver is wrapped as Tool components by an L2 ComponentProvider. Both
 * engine-claude and engine-pi consume it with zero engine changes.
 *
 * Return types use `T | Promise<T>` so implementations can be sync (mock)
 * or async (Playwright, CDP) without interface changes.
 *
 * All interaction methods accept an optional `snapshotId` in their options.
 * If provided and stale (page changed since last snapshot), the driver
 * returns NOT_FOUND with a message guiding the agent to re-snapshot.
 */

import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface BrowserSnapshotOptions {
  /** Max tokens to include in the serialized text tree (default: 4000). */
  readonly maxTokens?: number;
  /** Max nesting depth to include (default: 8). */
  readonly maxDepth?: number;
  /** Scope snapshot to a CSS selector (returns partial subtree). */
  readonly selector?: string;
}

/** Minimal info about a ref'd element — role + accessible name. */
export interface BrowserRefInfo {
  readonly role: string;
  readonly name?: string;
  /**
   * Playwright's native aria-ref attribute value (e.g. "e3") from
   * locator.ariaSnapshot() YAML. When present, used for direct
   * `page.locator('[aria-ref="e3"]')` lookup — O(1) vs getByRole O(n).
   */
  readonly ariaRef?: string;
  /**
   * 0-based occurrence index for getByRole() fallback when multiple
   * elements share the same role+name. Ensures `.nth(nthIndex)` picks
   * the correct element instead of silently using `.first()`.
   */
  readonly nthIndex?: number;
}

export interface BrowserSnapshotResult {
  /** Text tree with [ref=eN] markers for interactive elements. */
  readonly snapshot: string;
  /**
   * Opaque ID that changes on each new snapshot call and after navigation.
   * Pass back to interaction tools via their `snapshotId` option to guard
   * against stale refs after DOM changes.
   */
  readonly snapshotId: string;
  /** Mapping of ref key (e.g., "e1") to minimal element info. */
  readonly refs: Readonly<Record<string, BrowserRefInfo>>;
  /** True if the tree was truncated due to maxTokens or maxDepth. */
  readonly truncated: boolean;
  /** Current page URL at snapshot time. */
  readonly url: string;
  /** Current page title at snapshot time. */
  readonly title: string;
}

// ---------------------------------------------------------------------------
// Navigate
// ---------------------------------------------------------------------------

export type BrowserWaitUntil = "load" | "networkidle" | "commit" | "domcontentloaded";

export interface BrowserNavigateOptions {
  readonly waitUntil?: BrowserWaitUntil;
  readonly timeout?: number;
}

export interface BrowserNavigateResult {
  readonly url: string;
  readonly title: string;
}

// ---------------------------------------------------------------------------
// Interactions (click, type, select, fillForm)
// ---------------------------------------------------------------------------

export interface BrowserActionOptions {
  /**
   * Snapshot ID from the last browser_snapshot call.
   * If stale (page changed since snapshot was taken), the driver returns
   * NOT_FOUND: "Snapshot is stale — call browser_snapshot to refresh refs".
   */
  readonly snapshotId?: string;
  readonly timeout?: number;
  /**
   * Fill form fields in parallel using Promise.all (default: false — sequential).
   * Only set to true when fields are independent (no JS field-interdependencies).
   * Applies to fillForm only.
   */
  readonly parallel?: boolean;
  /**
   * CSS selector for an <iframe> or <frame> to scope this action within.
   * Example: 'iframe[name="payment"]', '#checkout-frame', 'iframe:first-of-type'.
   * Uses Playwright's frameLocator() — supports cross-origin iframes without
   * needing to switch browsing context explicitly.
   */
  readonly frameSelector?: string;
}

export interface BrowserTypeOptions extends BrowserActionOptions {
  /** Clear existing content before typing (default: false). */
  readonly clear?: boolean;
}

export interface BrowserFormField {
  readonly ref: string;
  readonly value: string;
  /** Clear existing content before typing (default: false). */
  readonly clear?: boolean;
}

// ---------------------------------------------------------------------------
// Scroll
// ---------------------------------------------------------------------------

export type BrowserScrollOptions =
  | {
      readonly kind: "page";
      readonly direction: "up" | "down" | "left" | "right";
      readonly amount?: number;
      readonly timeout?: number;
    }
  | {
      readonly kind: "element";
      /** Ref key from the most recent snapshot (e.g., "e5"). */
      readonly ref: string;
      readonly snapshotId?: string;
      readonly timeout?: number;
    };

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export interface BrowserScreenshotOptions {
  /** Capture the full scrollable page (default: false — viewport only). */
  readonly fullPage?: boolean;
  /**
   * JPEG quality 1–100 (default: 80).
   * Values below 100 produce JPEG; 100 produces PNG-quality output.
   */
  readonly quality?: number;
  readonly timeout?: number;
}

export interface BrowserScreenshotResult {
  /** Base64-encoded image data. */
  readonly data: string;
  readonly mimeType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Wait
// ---------------------------------------------------------------------------

export type BrowserWaitOptions =
  | { readonly kind: "timeout"; readonly timeout: number }
  | {
      readonly kind: "selector";
      readonly selector: string;
      readonly state?: "visible" | "hidden" | "attached" | "detached";
      readonly timeout?: number;
    }
  | {
      readonly kind: "navigation";
      readonly event?: BrowserWaitUntil;
      readonly timeout?: number;
    };

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export interface BrowserTabInfo {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
}

export interface BrowserTabNewOptions {
  /** Navigate to this URL immediately after opening the new tab. */
  readonly url?: string;
  readonly timeout?: number;
}

export interface BrowserTabCloseOptions {
  readonly timeout?: number;
}

export interface BrowserTabFocusOptions {
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

export interface BrowserEvaluateOptions {
  readonly timeout?: number;
}

export interface BrowserEvaluateResult {
  /** JSON-serializable return value from the script. undefined if void. */
  readonly value: unknown;
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

export type BrowserConsoleLevel = "log" | "warning" | "error" | "debug" | "info";

export interface BrowserConsoleEntry {
  readonly level: BrowserConsoleLevel;
  readonly text: string;
  /** Source URL (from ConsoleMessage.location()). */
  readonly url?: string;
  /** Source line number. */
  readonly line?: number;
}

export interface BrowserConsoleOptions {
  /** Filter by level(s). Default: all levels. */
  readonly levels?: readonly BrowserConsoleLevel[];
  /** Max entries to return, from most recent (default: 50, max: 200). */
  readonly limit?: number;
  /** Clear the console buffer after reading (default: false). */
  readonly clear?: boolean;
}

export interface BrowserConsoleResult {
  readonly entries: readonly BrowserConsoleEntry[];
  /** Total buffered entries before limit/filter was applied. */
  readonly total: number;
}

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

export interface BrowserUploadFile {
  /** Base64-encoded file content. Required when name is provided. */
  readonly content: string;
  /** Filename as it will appear in the input element. */
  readonly name: string;
  /** MIME type (default: application/octet-stream). */
  readonly mimeType?: string;
}

export interface BrowserUploadOptions extends BrowserActionOptions {
  /** Clear any already-attached files before uploading (default: true). */
  readonly clear?: boolean;
}

// ---------------------------------------------------------------------------
// Trace recording
// ---------------------------------------------------------------------------

export interface BrowserTraceOptions {
  /**
   * Include DOM snapshots in the trace (default: true).
   * Disable for lower overhead when only timing/network data is needed.
   */
  readonly snapshots?: boolean;
  /** Include network request/response metadata (default: true). */
  readonly network?: boolean;
  /** Name label written into the trace metadata. */
  readonly title?: string;
}

export interface BrowserTraceResult {
  /**
   * Absolute path to the .zip trace file on the local filesystem.
   * Open with: npx playwright show-trace <path>
   */
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export interface BrowserDriver {
  readonly name: string;

  /** Capture the current page as a [ref=eN] accessibility-tree text snapshot. */
  readonly snapshot: (
    options?: BrowserSnapshotOptions,
  ) => Result<BrowserSnapshotResult, KoiError> | Promise<Result<BrowserSnapshotResult, KoiError>>;

  /** Navigate to a URL. Invalidates all refs from previous snapshots. */
  readonly navigate: (
    url: string,
    options?: BrowserNavigateOptions,
  ) => Result<BrowserNavigateResult, KoiError> | Promise<Result<BrowserNavigateResult, KoiError>>;

  /** Click an element identified by its snapshot ref. */
  readonly click: (
    ref: string,
    options?: BrowserActionOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Type text into an element identified by its snapshot ref. */
  readonly type: (
    ref: string,
    value: string,
    options?: BrowserTypeOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Select an option in a combobox/listbox identified by its snapshot ref. */
  readonly select: (
    ref: string,
    value: string,
    options?: BrowserActionOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /**
   * Fill multiple form fields in one call.
   * More efficient than calling type/select N times for a multi-field form.
   */
  readonly fillForm: (
    fields: readonly BrowserFormField[],
    options?: BrowserActionOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Scroll the page in a direction, or scroll to bring an element into view. */
  readonly scroll: (
    options: BrowserScrollOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Capture a screenshot of the current viewport or full page. */
  readonly screenshot: (
    options?: BrowserScreenshotOptions,
  ) =>
    | Result<BrowserScreenshotResult, KoiError>
    | Promise<Result<BrowserScreenshotResult, KoiError>>;

  /** Wait for a timeout duration, a selector to appear, or a navigation event. */
  readonly wait: (
    options: BrowserWaitOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Open a new browser tab, optionally navigating to a URL. */
  readonly tabNew: (
    options?: BrowserTabNewOptions,
  ) => Result<BrowserTabInfo, KoiError> | Promise<Result<BrowserTabInfo, KoiError>>;

  /**
   * Close a browser tab.
   * @param tabId - The tab to close. Closes the current tab if omitted.
   */
  readonly tabClose: (
    tabId?: string,
    options?: BrowserTabCloseOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Switch focus to the specified tab, making it the active page. */
  readonly tabFocus: (
    tabId: string,
    options?: BrowserTabFocusOptions,
  ) => Result<BrowserTabInfo, KoiError> | Promise<Result<BrowserTabInfo, KoiError>>;

  /**
   * Execute arbitrary JavaScript in the current page context.
   *
   * PROMOTED trust tier. Not included in default OPERATIONS — must be
   * explicitly enabled in BrowserProviderConfig to avoid accidental exposure.
   */
  readonly evaluate: (
    script: string,
    options?: BrowserEvaluateOptions,
  ) => Result<BrowserEvaluateResult, KoiError> | Promise<Result<BrowserEvaluateResult, KoiError>>;

  /** Hover over an element to trigger hover effects (dropdowns, tooltips, context menus). */
  readonly hover: (
    ref: string,
    options?: BrowserActionOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /**
   * Press a keyboard key globally (Enter, Tab, Escape, ArrowDown, etc.).
   * Key names follow Playwright conventions: https://playwright.dev/docs/api/class-keyboard
   */
  readonly press: (
    key: string,
    options?: BrowserActionOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** List all open tabs. */
  readonly tabList: () =>
    | Result<readonly BrowserTabInfo[], KoiError>
    | Promise<Result<readonly BrowserTabInfo[], KoiError>>;

  /** Read buffered console messages from the current page. */
  readonly console: (
    options?: BrowserConsoleOptions,
  ) => Result<BrowserConsoleResult, KoiError> | Promise<Result<BrowserConsoleResult, KoiError>>;

  /**
   * Upload files to a file input element identified by its snapshot ref.
   *
   * Opt-in only (not in default OPERATIONS). Must be explicitly enabled in
   * BrowserProviderConfig because it writes files to the server-side process.
   */
  readonly upload?: (
    ref: string,
    files: readonly BrowserUploadFile[],
    options?: BrowserUploadOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /**
   * Start recording a Playwright trace for debugging.
   * Stop with traceStop() to save the .zip file.
   *
   * Debug-only — opt-in only (not in default OPERATIONS).
   */
  readonly traceStart?: (
    options?: BrowserTraceOptions,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /**
   * Stop the active trace and save it to a .zip file.
   * Returns the absolute path to the trace file.
   *
   * Debug-only — opt-in only (not in default OPERATIONS).
   */
  readonly traceStop?: () =>
    | Result<BrowserTraceResult, KoiError>
    | Promise<Result<BrowserTraceResult, KoiError>>;

  readonly dispose?: () => void | Promise<void>;
}
