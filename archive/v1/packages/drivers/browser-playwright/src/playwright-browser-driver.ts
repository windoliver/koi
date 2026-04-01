/**
 * Playwright implementation of BrowserDriver.
 *
 * Single persistent Browser + BrowserContext per driver instance.
 * Pages (tabs) are tracked in a Map<tabId, Page>.
 *
 * Per-tab snapshot state: each tab has its own snapshotId, refs, and
 * refCounter — switching tabs does not invalidate another tab's refs.
 *
 * Ref resolution priority:
 *   1. Native aria-ref → page.locator('[aria-ref="..."]') — O(1) direct lookup
 *   2. getByRole(role, {name}).nth(nthIndex) — fallback with nth deduplication
 *
 * CDP connection: set cdpEndpoint to connect to an existing Chrome instance.
 * Stealth: set stealth:true to hide navigator.webdriver and disable AutomationControlled.
 */

import { promises as dnsPromises } from "node:dns";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserActionOptions,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
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
  Result,
} from "@koi/core";
import { internal, notFound, staleRef, validation } from "@koi/core";
import type { Browser, BrowserContext, FrameLocator, Locator, Page } from "playwright";
import { chromium } from "playwright";
import { parseAriaYaml, VALID_ROLES } from "./a11y-serializer.js";
import { translatePlaywrightError } from "./error-translator.js";

/** Playwright-typed role guard — same validation as isAriaRole, returns Playwright's AriaRole. */
type AriaRole = Parameters<Page["getByRole"]>[0];
function isAriaRole(role: string): role is AriaRole {
  return VALID_ROLES.has(role);
}

export interface PlaywrightDriverConfig {
  /**
   * Inject an already-launched Browser instance.
   * When provided, `dispose()` will NOT close this browser — the caller manages lifecycle.
   */
  readonly browser?: Browser;
  /**
   * Connect to an existing Chrome/Chromium instance via CDP.
   * Example: "ws://localhost:9222" (start Chrome with --remote-debugging-port=9222).
   * When provided, `dispose()` will NOT close the browser — the caller manages lifecycle.
   * Ignored when `browser` is provided.
   */
  readonly cdpEndpoint?: string;
  /** Run headless (default: true). Ignored when `browser` or `cdpEndpoint` is provided. */
  readonly headless?: boolean;
  /** Browser launch timeout in ms (default: 30000). Ignored when `browser` or `cdpEndpoint` is provided. */
  readonly launchTimeout?: number;
  /**
   * Enable basic stealth mode (default: false).
   * Applies Chromium launch flags and injects navigator/chrome patches.
   * Covers common bot detection: navigator.webdriver, AutomationControlled flag,
   * navigator.plugins, navigator.languages, window.chrome runtime stub.
   * Ignored when `browser` or `cdpEndpoint` is provided (caller controls stealth).
   */
  readonly stealth?: boolean;
  /**
   * Absolute path to a Chromium user data directory for persistent profiles.
   * Reuses cookies, localStorage, IndexedDB, and extensions across driver instances.
   * Uses `chromium.launchPersistentContext()` — mutually exclusive with `browser` and
   * `cdpEndpoint` (those options take precedence if also provided).
   * Example: '/Users/alice/.koi/profiles/work'
   */
  readonly userDataDir?: string;
  /**
   * Block navigations that resolve to private/link-local IP addresses.
   * Prevents DNS rebinding attacks by re-resolving hostnames at request time.
   * Default: true (secure by default).
   */
  readonly blockPrivateAddresses?: boolean;
}

// Timeout defaults and maximum caps (ms)
const NAVIGATE_DEFAULT_MS = 15_000;
const NAVIGATE_MAX_MS = 60_000;
const ACTION_DEFAULT_MS = 3_000;
const ACTION_MAX_MS = 10_000;
const WAIT_DEFAULT_MS = 5_000;
const WAIT_MAX_MS = 30_000;
const EVALUATE_DEFAULT_MS = 5_000;
const EVALUATE_MAX_MS = 10_000;
const LAUNCH_DEFAULT_MS = 30_000;

/**
 * Maximum entries per tab before FIFO eviction kicks in.
 * 200 entries is enough context for agent debugging without unbounded growth.
 * In practice, agents inspect the last 50 entries (console() default limit).
 */
const CONSOLE_BUFFER_CAP = 200;

// ---------------------------------------------------------------------------
// DNS rebinding protection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the IP address falls within a private, loopback, or link-local range.
 * Used by the DNS rebinding route guard to block navigations that resolve to
 * internal addresses — catches post-TTL rebinding that bypasses static URL analysis.
 *
 * Inlined here (not imported from @koi/tool-browser) to avoid L2 peer violations.
 */
function isPrivateIp(ip: string): boolean {
  return (
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    ip === "::1" ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip === "0.0.0.0"
  );
}

// ---------------------------------------------------------------------------
// Console helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a Playwright ConsoleMessage type string to a BrowserConsoleLevel.
 * Returns null for structural/grouping types that carry no signal for agents.
 */
function normalizeConsoleType(type: string): BrowserConsoleLevel | null {
  switch (type) {
    case "log":
    case "trace":
      return "log";
    case "warning":
      return "warning";
    case "error":
      return "error";
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "assert":
      // assert fires when assertion fails — map to error for agent visibility
      return "error";
    case "dir":
    case "dirxml":
    case "table":
    case "group":
    case "groupCollapsed":
    case "groupEnd":
    case "count":
    case "countReset":
    case "time":
    case "timeLog":
    case "timeEnd":
    case "clear":
    case "startGroup":
    case "startGroupCollapsed":
    case "endGroup":
      return null;
    default:
      return "log";
  }
}

// ---------------------------------------------------------------------------
// Stealth init script — injected at BrowserContext level
// ---------------------------------------------------------------------------

/**
 * JavaScript snippet injected into every page at BrowserContext level when stealth is enabled.
 * Covers the most commonly checked bot-detection signals without any extra dependencies.
 * Exported so CDP callers can apply the same patches to their own contexts.
 */
export const STEALTH_INIT_SCRIPT = `
// 1. navigator.webdriver — primary automation flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// 2. navigator.plugins — real Chrome always has at least one plugin; headless has none
if (navigator.plugins.length === 0) {
  Object.defineProperty(navigator, 'plugins', {
    get: () => Object.setPrototypeOf(
      [{ name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 0 }],
      PluginArray.prototype
    ),
  });
}

// 3. navigator.languages — ensure realistic browser language preferences
Object.defineProperty(navigator, 'languages', { get: () => Object.freeze(['en-US', 'en']) });

// 4. window.chrome — real Chrome exposes a runtime stub; headless Chromium does not
if (typeof window.chrome === 'undefined') {
  Object.defineProperty(window, 'chrome', { value: Object.freeze({ runtime: {} }), configurable: true });
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a raw timeout option to a validated ms value.
 * Returns {ok: false} if the value exceeds maxMs, {ok: true, value: ms} otherwise.
 */
function resolveTimeout(
  raw: number | undefined,
  defaultMs: number,
  maxMs: number,
  label: string,
):
  | { readonly ok: false; readonly error: KoiError }
  | { readonly ok: true; readonly value: number } {
  const ms = raw ?? defaultMs;
  if (ms > maxMs) {
    return {
      ok: false,
      error: validation(`${label} timeout ${ms}ms exceeds maximum ${maxMs}ms`),
    };
  }
  return { ok: true, value: ms };
}

// ---------------------------------------------------------------------------
// Per-tab snapshot state
// ---------------------------------------------------------------------------

interface TabSnapshot {
  readonly snapshotId: string;
  readonly refs: Readonly<Record<string, BrowserRefInfo>>;
  readonly refCounter: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlaywrightBrowserDriver(config: PlaywrightDriverConfig = {}): BrowserDriver {
  // Whether we own the browser lifecycle (launched it ourselves)
  const ownsLifecycle = !config.browser && !config.cdpEndpoint;

  let browser: Browser | null = config.browser ?? null;
  let browserContext: BrowserContext | null = null;
  // Promise caches prevent concurrent callers from launching two browsers/contexts.
  // Without these, two simultaneous ensureBrowser() calls would both see null and both launch.
  let browserInitPromise: Promise<Browser> | null = null; // intentional mutation: set once on first call
  let contextInitPromise: Promise<BrowserContext> | null = null; // intentional mutation: set once on first call
  let tabCounter = 0;
  const tabs = new Map<string, Page>();
  let currentTabId: string | null = null;

  // Per-tab snapshot state — replaces the old single global currentSnapshotId / currentRefs
  const tabSnapshots = new Map<string, TabSnapshot>();

  // Per-tab console log buffer (FIFO, capped at CONSOLE_BUFFER_CAP entries per tab)
  const tabConsoleLogs = new Map<string, BrowserConsoleEntry[]>();

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function newTabId(): string {
    return `tab-${++tabCounter}`;
  }

  function invalidateTabSnapshot(tabId: string): void {
    tabSnapshots.delete(tabId);
  }

  function attachConsoleListener(page: Page, tabId: string): void {
    tabConsoleLogs.set(tabId, []);
    page.on("console", (msg) => {
      const level = normalizeConsoleType(msg.type());
      if (level === null) return;
      const loc = msg.location();
      const entry: BrowserConsoleEntry = {
        level,
        text: msg.text(),
        ...(loc.url ? { url: loc.url } : {}),
        ...(loc.lineNumber ? { line: loc.lineNumber } : {}),
      };
      const buf = tabConsoleLogs.get(tabId);
      if (buf === undefined) return;
      buf.push(entry); // intentional mutation: buf is a private per-tab ring buffer owned by this closure
      if (buf.length > CONSOLE_BUFFER_CAP) buf.shift(); // intentional mutation: FIFO eviction of oldest entry
    });
  }

  async function ensureBrowser(): Promise<Browser> {
    if (browser) return browser;
    // Promise cache: concurrent callers share one launch and all await the same result.
    if (!browserInitPromise) {
      browserInitPromise = (async (): Promise<Browser> => {
        // intentional assignment: set promise cache once
        if (config.cdpEndpoint) {
          return chromium.connectOverCDP(config.cdpEndpoint, {
            timeout: config.launchTimeout ?? LAUNCH_DEFAULT_MS,
          });
        }
        const launchArgs = config.stealth
          ? [
              "--disable-blink-features=AutomationControlled",
              "--no-first-run",
              "--no-default-browser-check",
            ]
          : [];
        return chromium.launch({
          headless: config.headless ?? true,
          timeout: config.launchTimeout ?? LAUNCH_DEFAULT_MS,
          args: launchArgs,
          ...(config.stealth ? { ignoreDefaultArgs: ["--enable-automation"] } : {}),
        });
      })();
    }
    try {
      browser = await browserInitPromise; // intentional assignment: cache resolved browser for sync access
    } catch (e: unknown) {
      browserInitPromise = null; // intentional reset: allow retry on next call instead of caching rejection forever
      throw e;
    }
    return browser;
  }

  async function ensureContext(): Promise<BrowserContext> {
    if (browserContext) return browserContext;
    // Promise cache: concurrent callers share one context creation and all await the same result.
    if (!contextInitPromise) {
      contextInitPromise = (async (): Promise<BrowserContext> => {
        // intentional assignment: set promise cache once
        let ctx: BrowserContext;
        // Persistent context path: userDataDir bypasses ensureBrowser() entirely.
        // chromium.launchPersistentContext() returns a BrowserContext directly.
        if (config.userDataDir && !config.browser && !config.cdpEndpoint) {
          const launchArgs = config.stealth
            ? [
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
              ]
            : [];
          ctx = await chromium.launchPersistentContext(config.userDataDir, {
            headless: config.headless ?? true,
            timeout: config.launchTimeout ?? LAUNCH_DEFAULT_MS,
            args: launchArgs,
            ...(config.stealth ? { ignoreDefaultArgs: ["--enable-automation"] } : {}),
          });
        } else {
          const b = await ensureBrowser();
          // For CDP connections, reuse the default context if one exists
          if (config.cdpEndpoint) {
            const contexts = b.contexts();
            ctx = contexts[0] ?? (await b.newContext());
          } else {
            ctx = await b.newContext();
          }
        }
        // Inject stealth script at context level — covers all pages and window.open() tabs
        if (config.stealth && !config.browser && !config.cdpEndpoint) {
          await ctx.addInitScript(STEALTH_INIT_SCRIPT);
        }

        // DNS rebinding guard — re-resolve hostnames at request time for document navigations.
        // Catches post-TTL rebinding that bypasses the static URL check in url-security.ts.
        // Default: enabled (blockPrivateAddresses !== false).
        if (config.blockPrivateAddresses !== false) {
          await ctx.route("**", async (route) => {
            const req = route.request();
            // Only intercept main-frame document navigations — sub-resources are not rebinding vectors
            if (req.resourceType() !== "document" || !req.isNavigationRequest()) {
              await route.continue();
              return;
            }
            try {
              const url = new URL(req.url());
              // Skip non-HTTP(S) schemes — file://, data://, etc. are not rebinding targets
              if (url.protocol !== "http:" && url.protocol !== "https:") {
                await route.continue();
                return;
              }
              const hostname = url.hostname;
              // IP literals are already checked by url-security.ts at the tool layer
              if (/^[\d.:[\]]+$/.test(hostname)) {
                await route.continue();
                return;
              }
              const { address } = await dnsPromises.lookup(hostname);
              if (isPrivateIp(address)) {
                await route.abort("accessdenied");
                return;
              }
            } catch {
              // DNS lookup failure → fail closed (deny the request)
              await route.abort("accessdenied");
              return;
            }
            await route.continue();
          });
        }

        return ctx;
      })();
    }
    try {
      browserContext = await contextInitPromise; // intentional assignment: cache resolved context for sync access
    } catch (e: unknown) {
      contextInitPromise = null; // intentional reset: allow retry on next call instead of caching rejection forever
      throw e;
    }
    return browserContext;
  }

  async function ensurePage(): Promise<Page> {
    if (currentTabId === null) {
      const ctx = await ensureContext();
      const page = await ctx.newPage();
      const tabId = newTabId();
      tabs.set(tabId, page);
      currentTabId = tabId;
      attachConsoleListener(page, tabId);
    }
    const page = tabs.get(currentTabId);
    if (!page) {
      throw new Error(`internal: currentTabId "${currentTabId}" has no page`);
    }
    return page;
  }

  function getActiveTabId(): string | null {
    return currentTabId;
  }

  /** Returns a STALE_REF error if snapshotId is provided but doesn't match the active tab's. */
  function checkSnapshotId(snapshotId: string | undefined): Result<void, KoiError> | null {
    if (snapshotId === undefined) return null;
    const tabId = getActiveTabId();
    if (!tabId) return null;
    const snap = tabSnapshots.get(tabId);
    if (!snap || snapshotId !== snap.snapshotId) {
      return {
        ok: false,
        error: staleRef(
          snapshotId,
          "call browser_snapshot to get fresh refs — the page changed since this snapshot was taken",
        ),
      };
    }
    return null;
  }

  /**
   * Resolve a ref to a Playwright Locator, optionally scoped inside an iframe.
   *
   * Priority:
   *   1. Native aria-ref → direct attribute selector (O(1))
   *   2. getByRole(role, {name}).nth(nthIndex) — with deduplication
   *
   * When frameSelector is provided, all resolution is done via page.frameLocator(),
   * which supports cross-origin iframes without explicit context switching.
   */
  function getLocator(page: Page, ref: string, frameSelector?: string): Locator | null {
    const tabId = getActiveTabId();
    if (!tabId) return null;
    const snap = tabSnapshots.get(tabId);
    if (!snap) return null;
    const refInfo = snap.refs[ref];
    if (!refInfo) return null;

    const root: Page | FrameLocator = frameSelector ? page.frameLocator(frameSelector) : page;

    // Strategy 1: native aria-ref direct attribute lookup
    if (refInfo.ariaRef) {
      return root.locator(`[aria-ref="${refInfo.ariaRef}"]`);
    }

    // Strategy 2: getByRole with nth deduplication
    if (!isAriaRole(refInfo.role)) return null;
    const role = refInfo.role; // narrowed to AriaRole by isAriaRole guard above
    const nthIndex = refInfo.nthIndex ?? 0;
    if (refInfo.name) {
      return root.getByRole(role, { name: refInfo.name, exact: true }).nth(nthIndex);
    }
    return root.getByRole(role).nth(nthIndex);
  }

  /** Get a Locator or return a STALE_REF/NOT_FOUND error Result. */
  function requireLocator(
    page: Page,
    ref: string,
    frameSelector?: string,
  ): { readonly locator: Locator } | { readonly error: Result<never, KoiError> } {
    const locator = getLocator(page, ref, frameSelector);
    if (!locator) {
      return {
        error: {
          ok: false,
          error: staleRef(
            ref,
            "call browser_snapshot to refresh refs — this ref is not in the current snapshot",
          ),
        },
      };
    }
    return { locator };
  }

  // ---------------------------------------------------------------------------
  // BrowserDriver implementation
  // ---------------------------------------------------------------------------

  return {
    name: "playwright",

    async snapshot(
      options?: BrowserSnapshotOptions,
    ): Promise<Result<BrowserSnapshotResult, KoiError>> {
      try {
        const page = await ensurePage();
        const tabId = currentTabId;
        if (!tabId) return { ok: false, error: internal("No active tab") };

        const locator = options?.selector
          ? page.locator(options.selector).first()
          : page.locator("body");
        const yamlText = await locator.ariaSnapshot();

        if (!yamlText) {
          return {
            ok: false,
            error: internal("Accessibility snapshot returned empty — page may not be fully loaded"),
          };
        }

        const { text, refs, truncated, title: yamlTitle } = parseAriaYaml(yamlText, options);

        // Generate a new snapshotId and store per-tab state
        const prevCounter = tabSnapshots.get(tabId)?.refCounter ?? 0;
        const refCounter = prevCounter + 1;
        const snapshotId = `snap-${tabId}-${refCounter}`;
        tabSnapshots.set(tabId, {
          snapshotId,
          refs,
          refCounter,
        });

        // Use title from YAML if extracted, fall back to IPC only when absent
        const title = yamlTitle ?? (await page.title());

        return {
          ok: true,
          value: {
            snapshot: text,
            snapshotId,
            refs,
            truncated,
            url: page.url(),
            title,
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_snapshot", e) };
      }
    },

    async navigate(
      url: string,
      options?: BrowserNavigateOptions,
    ): Promise<Result<BrowserNavigateResult, KoiError>> {
      try {
        const page = await ensurePage();
        const tabId = currentTabId;
        if (!tabId) return { ok: false, error: internal("No active tab") };

        const t = resolveTimeout(
          options?.timeout,
          NAVIGATE_DEFAULT_MS,
          NAVIGATE_MAX_MS,
          "navigate",
        );
        if (!t.ok) return t;

        invalidateTabSnapshot(tabId);

        await page.goto(url, {
          waitUntil: options?.waitUntil ?? "load",
          timeout: t.value,
        });

        return {
          ok: true,
          value: {
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_navigate", e) };
      }
    },

    async click(ref: string, options?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "click");
        if (!t.ok) return t;

        await found.locator.click({ timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_click", e) };
      }
    },

    async hover(ref: string, options?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "hover");
        if (!t.ok) return t;

        await found.locator.hover({ timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_hover", e) };
      }
    },

    async press(key: string, options?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "press");
        if (!t.ok) return t;

        await page.keyboard.press(key);
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_press", e) };
      }
    },

    async type(
      ref: string,
      value: string,
      options?: BrowserTypeOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "type");
        if (!t.ok) return t;

        if (options?.clear) {
          await found.locator.clear({ timeout: t.value });
        }
        await found.locator.fill(value, { timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_type", e) };
      }
    },

    async select(
      ref: string,
      value: string,
      options?: BrowserActionOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "select");
        if (!t.ok) return t;

        await found.locator.selectOption(value, { timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_select", e) };
      }
    },

    async fillForm(
      fields: readonly BrowserFormField[],
      options?: BrowserActionOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "fill_form");
        if (!t.ok) return t;

        // Pass 1: validate all refs before touching any field (atomic guarantee)
        const resolved: Array<{ readonly locator: Locator; readonly field: BrowserFormField }> = [];
        for (const field of fields) {
          const found = requireLocator(page, field.ref, options?.frameSelector);
          if ("error" in found) return found.error;
          resolved.push({ locator: found.locator, field });
        }

        // Pass 2: fill — parallel when caller opts in, sequential otherwise
        if (options?.parallel) {
          await Promise.all(
            resolved.map(async ({ locator, field }) => {
              if (field.clear) await locator.clear({ timeout: t.value });
              await locator.fill(field.value, { timeout: t.value });
            }),
          );
        } else {
          for (const { locator, field } of resolved) {
            if (field.clear) await locator.clear({ timeout: t.value });
            await locator.fill(field.value, { timeout: t.value });
          }
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_fill_form", e) };
      }
    },

    async scroll(options: BrowserScrollOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();

        if (options.kind === "element") {
          const stale = checkSnapshotId(options.snapshotId);
          if (stale) return stale;

          const found = requireLocator(page, options.ref);
          if ("error" in found) return found.error;

          const t = resolveTimeout(options.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "scroll");
          if (!t.ok) return t;

          await found.locator.scrollIntoViewIfNeeded({ timeout: t.value });
        } else {
          const directionMap: Readonly<Record<string, readonly [number, number]>> = {
            up: [0, -1],
            down: [0, 1],
            left: [-1, 0],
            right: [1, 0],
          };
          const dir = directionMap[options.direction] ?? ([0, 1] as const);
          const amount = options.amount ?? 400;
          await page.mouse.wheel(dir[0] * amount, dir[1] * amount);
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_scroll", e) };
      }
    },

    async screenshot(
      options?: BrowserScreenshotOptions,
    ): Promise<Result<BrowserScreenshotResult, KoiError>> {
      try {
        const page = await ensurePage();
        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "screenshot");
        if (!t.ok) return t;

        const quality = options?.quality ?? 80;
        const fullPage = options?.fullPage ?? false;

        const buffer = await page.screenshot({
          fullPage,
          type: quality < 100 ? "jpeg" : "png",
          ...(quality < 100 ? { quality } : {}),
          timeout: t.value,
        });

        const mimeType = quality < 100 ? "image/jpeg" : "image/png";
        const viewportSize = page.viewportSize();
        const width = viewportSize?.width ?? 1280;
        const height = viewportSize?.height ?? 720;

        return {
          ok: true,
          value: {
            data: buffer.toString("base64"),
            mimeType,
            width,
            height,
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_screenshot", e) };
      }
    },

    async wait(options: BrowserWaitOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();

        if (options.kind === "timeout") {
          const t = resolveTimeout(options.timeout, WAIT_DEFAULT_MS, WAIT_MAX_MS, "wait");
          if (!t.ok) return t;
          await page.waitForTimeout(t.value);
        } else if (options.kind === "selector") {
          const t = resolveTimeout(options.timeout, WAIT_DEFAULT_MS, WAIT_MAX_MS, "wait");
          if (!t.ok) return t;
          await page.waitForSelector(options.selector, {
            state: options.state ?? "visible",
            timeout: t.value,
          });
        } else {
          const t = resolveTimeout(options.timeout, WAIT_DEFAULT_MS, WAIT_MAX_MS, "wait");
          if (!t.ok) return t;
          await page.waitForNavigation({
            waitUntil: options.event ?? "load",
            timeout: t.value,
          });
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_wait", e) };
      }
    },

    async tabNew(options?: BrowserTabNewOptions): Promise<Result<BrowserTabInfo, KoiError>> {
      try {
        const ctx = await ensureContext();
        const page = await ctx.newPage();
        const tabId = newTabId();
        tabs.set(tabId, page);
        attachConsoleListener(page, tabId);
        const previousTabId = currentTabId;

        if (options?.url) {
          const t = resolveTimeout(
            options.timeout,
            NAVIGATE_DEFAULT_MS,
            NAVIGATE_MAX_MS,
            "tab_new",
          );
          if (!t.ok) {
            await page.close();
            tabs.delete(tabId);
            tabConsoleLogs.delete(tabId);
            return t;
          }
          try {
            await page.goto(options.url, { timeout: t.value });
          } catch (gotoErr: unknown) {
            // Navigation failed — clean up the new page and restore previous tab focus
            await page.close().catch(() => undefined);
            tabs.delete(tabId);
            tabConsoleLogs.delete(tabId);
            currentTabId = previousTabId; // intentional restore: goto() failed, revert to previous tab
            throw gotoErr;
          }
        }

        // New tab becomes the active tab only after successful navigation (or no URL requested).
        currentTabId = tabId;

        return {
          ok: true,
          value: {
            tabId,
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_tab_new", e) };
      }
    },

    async tabClose(
      tabId?: string,
      _options?: BrowserTabCloseOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const targetId = tabId ?? currentTabId;
        if (!targetId) {
          return { ok: false, error: notFound("No tab to close") };
        }
        const page = tabs.get(targetId);
        if (!page) {
          return { ok: false, error: notFound(`Tab "${targetId}" not found`) };
        }
        await page.close();
        tabs.delete(targetId);
        invalidateTabSnapshot(targetId);
        tabConsoleLogs.delete(targetId);

        if (currentTabId === targetId) {
          // Single-pass iterator — avoids allocating a full array just to get the last key.
          let lastKey: string | null = null;
          for (const k of tabs.keys()) lastKey = k;
          currentTabId = lastKey;
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_tab_close", e) };
      }
    },

    async tabFocus(
      tabId: string,
      _options?: BrowserTabFocusOptions,
    ): Promise<Result<BrowserTabInfo, KoiError>> {
      try {
        const page = tabs.get(tabId);
        if (!page) {
          return { ok: false, error: notFound(`Tab "${tabId}" not found`) };
        }
        // bringToFront() has no built-in timeout; guard against infinite hangs.
        // Timer handle is cleared on normal resolution to avoid dangling rejections.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("bringToFront timed out")), 10_000);
          page.bringToFront().then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (e: unknown) => {
              clearTimeout(timer);
              reject(e);
            },
          );
        });
        currentTabId = tabId;
        // Note: we do NOT invalidate the tab's snapshot — per-tab caching preserves it

        return {
          ok: true,
          value: {
            tabId,
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_tab_focus", e) };
      }
    },

    async tabList(): Promise<Result<readonly BrowserTabInfo[], KoiError>> {
      try {
        // Fire all CDP title() calls in parallel — one round-trip per tab concurrently.
        const entries = [...tabs.entries()];
        const value = await Promise.all(
          entries.map(async ([tabId, page]) => ({
            tabId,
            url: page.url(),
            title: await page.title(),
          })),
        );
        return { ok: true, value };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_tab_list", e) };
      }
    },

    async console(
      options?: BrowserConsoleOptions,
    ): Promise<Result<BrowserConsoleResult, KoiError>> {
      const buf = currentTabId !== null ? (tabConsoleLogs.get(currentTabId) ?? []) : [];
      const MAX_LIMIT = 200;
      const limit = Math.min(options?.limit ?? 50, MAX_LIMIT);
      const levels = options?.levels;
      const filtered = levels ? buf.filter((e) => levels.includes(e.level)) : buf;
      const total = filtered.length;
      const entries = filtered.slice(-limit);
      if (options?.clear === true && currentTabId !== null) {
        tabConsoleLogs.set(currentTabId, []);
      }
      return { ok: true, value: { entries, total } };
    },

    async evaluate(
      script: string,
      options?: BrowserEvaluateOptions,
    ): Promise<Result<BrowserEvaluateResult, KoiError>> {
      try {
        const page = await ensurePage();
        const t = resolveTimeout(
          options?.timeout,
          EVALUATE_DEFAULT_MS,
          EVALUATE_MAX_MS,
          "evaluate",
        );
        if (!t.ok) return t;

        // page.evaluate() has no native timeout option — wrap with a race to honour the validated timeout.
        const value: unknown = await Promise.race([
          page.evaluate(script),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`evaluate timed out after ${t.value}ms`)), t.value);
          }),
        ]);
        return { ok: true, value: { value } };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_evaluate", e) };
      }
    },

    async upload(
      ref: string,
      files: readonly BrowserUploadFile[],
      options?: BrowserUploadOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "upload");
        if (!t.ok) return t;

        // Convert base64 content to Buffer payloads for Playwright setInputFiles
        const payloads = files.map((f) => ({
          name: f.name,
          mimeType: f.mimeType ?? "application/octet-stream",
          buffer: Buffer.from(f.content, "base64"),
        }));

        await found.locator.setInputFiles(payloads, { timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_upload", e) };
      }
    },

    async traceStart(options?: BrowserTraceOptions): Promise<Result<void, KoiError>> {
      try {
        const ctx = await ensureContext();
        await ctx.tracing.start({
          snapshots: options?.snapshots ?? true,
          screenshots: true,
          sources: false,
          ...(options?.title !== undefined ? { title: options.title } : {}),
        });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_trace_start", e) };
      }
    },

    async traceStop(): Promise<Result<BrowserTraceResult, KoiError>> {
      try {
        const ctx = await ensureContext();
        const tracePath = join(tmpdir(), `koi-trace-${Date.now()}.zip`);
        await ctx.tracing.stop({ path: tracePath });
        return { ok: true, value: { path: tracePath } };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_trace_stop", e) };
      }
    },

    async dispose(): Promise<void> {
      // Invalidate all tab snapshots and console buffers
      tabSnapshots.clear();
      tabConsoleLogs.clear();

      for (const page of tabs.values()) {
        await page.close().catch(() => undefined);
      }
      tabs.clear();
      currentTabId = null;

      if (browserContext) {
        await browserContext.close().catch(() => undefined);
        browserContext = null;
        contextInitPromise = null; // intentional mutation: reset so a new driver can be re-initialized after dispose
      }

      // Only close browser if we launched it (not injected and not CDP)
      if (ownsLifecycle && browser) {
        await browser.close().catch(() => undefined);
        browser = null;
        browserInitPromise = null; // intentional mutation: reset so a new driver can be re-initialized after dispose
      }
    },
  };
}

// Re-export for consumers who want to use VALID_ROLES or isAriaRole directly
export { isAriaRole, VALID_ROLES };
