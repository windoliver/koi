/**
 * Playwright implementation of BrowserDriver.
 *
 * Single persistent Browser + BrowserContext per driver instance.
 * Pages (tabs) are tracked in a Map<tabId, Page>.
 *
 * snapshotId is invalidated on navigate() and tabFocus().
 * Interaction tools validate snapshotId and return NOT_FOUND if stale.
 */

import type {
  BrowserActionOptions,
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
  BrowserTypeOptions,
  BrowserWaitOptions,
  KoiError,
  Result,
} from "@koi/core";
import { internal, notFound, validation } from "@koi/core";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { chromium } from "playwright";
import { parseAriaYaml } from "./a11y-serializer.js";

export interface PlaywrightDriverConfig {
  /**
   * Inject an already-launched Browser instance.
   * When provided, `dispose()` will NOT close this browser — the caller manages lifecycle.
   */
  readonly browser?: Browser;
  /** Run headless (default: true). Ignored when `browser` is provided. */
  readonly headless?: boolean;
  /** Browser launch timeout in ms (default: 30000). Ignored when `browser` is provided. */
  readonly launchTimeout?: number;
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

/** Validate a timeout against a maximum cap and return a VALIDATION error if exceeded. */
function checkTimeout(
  ms: number,
  maxMs: number,
  label: string,
): { readonly ok: false; readonly error: KoiError } | null {
  if (ms > maxMs) {
    return {
      ok: false,
      error: validation(`${label} timeout ${ms}ms exceeds maximum ${maxMs}ms`),
    };
  }
  return null;
}

export function createPlaywrightBrowserDriver(config: PlaywrightDriverConfig = {}): BrowserDriver {
  // State (all mutable, closure-managed)
  let browser: Browser | null = config.browser ?? null;
  let browserContext: BrowserContext | null = null;
  let tabCounter = 0;
  let snapshotCounter = 0;
  const tabs = new Map<string, Page>();
  let currentTabId: string | null = null;
  let currentSnapshotId: string | null = null;
  // refs stored as BrowserRefInfo (role + optional name)
  let currentRefs: Record<string, BrowserRefInfo> = {};

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function newTabId(): string {
    return `tab-${++tabCounter}`;
  }

  function newSnapshotId(): string {
    return `snap-${++snapshotCounter}`;
  }

  function invalidateSnapshot(): void {
    currentSnapshotId = null;
    currentRefs = {};
  }

  async function ensureBrowser(): Promise<Browser> {
    if (!browser) {
      browser = await chromium.launch({
        headless: config.headless ?? true,
        timeout: config.launchTimeout ?? LAUNCH_DEFAULT_MS,
      });
    }
    return browser;
  }

  async function ensureContext(): Promise<BrowserContext> {
    if (!browserContext) {
      const b = await ensureBrowser();
      browserContext = await b.newContext();
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
    }
    const page = tabs.get(currentTabId);
    if (!page) {
      throw new Error(`internal: currentTabId "${currentTabId}" has no page`);
    }
    return page;
  }

  /** Returns an error Result if snapshotId is provided but stale. */
  function checkSnapshotId(snapshotId: string | undefined): Result<void, KoiError> | null {
    if (snapshotId === undefined) return null;
    if (snapshotId !== currentSnapshotId) {
      return {
        ok: false,
        error: notFound("Snapshot is stale — call browser_snapshot to refresh refs"),
      };
    }
    return null;
  }

  /** Look up a ref and return a Playwright Locator, or null if not found. */
  function getLocator(page: Page, ref: string): Locator | null {
    const refInfo = currentRefs[ref];
    if (!refInfo) return null;
    // Cast to the first parameter type of getByRole (Playwright's internal AriaRole union)
    type Role = Parameters<Page["getByRole"]>[0];
    if (refInfo.name) {
      return page.getByRole(refInfo.role as Role, { name: refInfo.name, exact: true }).first();
    }
    return page.getByRole(refInfo.role as Role).first();
  }

  /** Get a ref or return a NOT_FOUND error Result. */
  function requireLocator(
    page: Page,
    ref: string,
  ): { locator: Locator } | { error: Result<never, KoiError> } {
    const locator = getLocator(page, ref);
    if (!locator) {
      return {
        error: {
          ok: false,
          error: notFound(
            `ref "${ref}" not found in current snapshot — call browser_snapshot to refresh refs`,
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

        // Use Playwright 1.44+ locator.ariaSnapshot() — page.accessibility was removed.
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

        const { text, refs, truncated } = parseAriaYaml(yamlText, options);

        const snapshotId = newSnapshotId();
        currentSnapshotId = snapshotId;
        currentRefs = refs as Record<string, BrowserRefInfo>;

        return {
          ok: true,
          value: {
            snapshot: text,
            snapshotId,
            refs,
            truncated,
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_snapshot failed", e) };
      }
    },

    async navigate(
      url: string,
      options?: BrowserNavigateOptions,
    ): Promise<Result<BrowserNavigateResult, KoiError>> {
      try {
        const page = await ensurePage();
        const timeoutMs = options?.timeout ?? NAVIGATE_DEFAULT_MS;
        const cap = checkTimeout(timeoutMs, NAVIGATE_MAX_MS, "navigate");
        if (cap) return cap;

        invalidateSnapshot();

        await page.goto(url, {
          waitUntil: options?.waitUntil ?? "load",
          timeout: timeoutMs,
        });

        return {
          ok: true,
          value: {
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_navigate failed", e) };
      }
    },

    async click(ref: string, options?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref);
        if ("error" in found) return found.error;

        const timeoutMs = options?.timeout ?? ACTION_DEFAULT_MS;
        const cap = checkTimeout(timeoutMs, ACTION_MAX_MS, "click");
        if (cap) return cap;

        await found.locator.click({ timeout: timeoutMs });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_click failed", e) };
      }
    },

    async hover(ref: string, options?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref);
        if ("error" in found) return found.error;

        const timeoutMs = options?.timeout ?? ACTION_DEFAULT_MS;
        const cap = checkTimeout(timeoutMs, ACTION_MAX_MS, "hover");
        if (cap) return cap;

        await found.locator.hover({ timeout: timeoutMs });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_hover failed", e) };
      }
    },

    async press(key: string, options?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const timeoutMs = options?.timeout ?? ACTION_DEFAULT_MS;
        const cap = checkTimeout(timeoutMs, ACTION_MAX_MS, "press");
        if (cap) return cap;

        await page.keyboard.press(key);
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_press failed", e) };
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

        const found = requireLocator(page, ref);
        if ("error" in found) return found.error;

        const timeoutMs = options?.timeout ?? ACTION_DEFAULT_MS;
        const cap = checkTimeout(timeoutMs, ACTION_MAX_MS, "type");
        if (cap) return cap;

        if (options?.clear) {
          await found.locator.clear({ timeout: timeoutMs });
        }
        await found.locator.fill(value, { timeout: timeoutMs });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_type failed", e) };
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

        const found = requireLocator(page, ref);
        if ("error" in found) return found.error;

        const timeoutMs = options?.timeout ?? ACTION_DEFAULT_MS;
        const cap = checkTimeout(timeoutMs, ACTION_MAX_MS, "select");
        if (cap) return cap;

        await found.locator.selectOption(value, { timeout: timeoutMs });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_select failed", e) };
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

        const timeoutMs = options?.timeout ?? ACTION_DEFAULT_MS;
        const cap = checkTimeout(timeoutMs, ACTION_MAX_MS, "fill_form");
        if (cap) return cap;

        for (const field of fields) {
          const found = requireLocator(page, field.ref);
          if ("error" in found) return found.error;

          if (field.clear) {
            await found.locator.clear({ timeout: timeoutMs });
          }
          await found.locator.fill(field.value, { timeout: timeoutMs });
        }
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_fill_form failed", e) };
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

          const timeoutMs = options.timeout ?? ACTION_DEFAULT_MS;
          const cap = checkTimeout(timeoutMs, ACTION_MAX_MS, "scroll");
          if (cap) return cap;

          await found.locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
        } else {
          // page scroll
          const directionMap: Record<string, [number, number]> = {
            up: [0, -1],
            down: [0, 1],
            left: [-1, 0],
            right: [1, 0],
          };
          const [x, y] = directionMap[options.direction] ?? [0, 1];
          const amount = options.amount ?? 400;
          await page.mouse.wheel(x * amount, y * amount);
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_scroll failed", e) };
      }
    },

    async screenshot(
      options?: BrowserScreenshotOptions,
    ): Promise<Result<BrowserScreenshotResult, KoiError>> {
      try {
        const page = await ensurePage();
        const timeoutMs = options?.timeout ?? ACTION_DEFAULT_MS;
        const cap = checkTimeout(timeoutMs, ACTION_MAX_MS, "screenshot");
        if (cap) return cap;

        const quality = options?.quality ?? 80;
        const fullPage = options?.fullPage ?? false;

        const buffer = await page.screenshot({
          fullPage,
          type: quality < 100 ? "jpeg" : "png",
          // exactOptionalPropertyTypes: only pass quality when it's meaningful (JPEG)
          ...(quality < 100 ? { quality } : {}),
          timeout: timeoutMs,
        });

        const mimeType = quality < 100 ? "image/jpeg" : "image/png";
        const viewportSize = page.viewportSize();
        const width = viewportSize?.width ?? 1280;
        const height = viewportSize?.height ?? 720;

        return {
          ok: true,
          value: {
            data: Buffer.from(buffer).toString("base64"),
            mimeType,
            width,
            height,
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_screenshot failed", e) };
      }
    },

    async wait(options: BrowserWaitOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();

        if (options.kind === "timeout") {
          const timeoutMs = options.timeout;
          const cap = checkTimeout(timeoutMs, WAIT_MAX_MS, "wait");
          if (cap) return cap;
          await page.waitForTimeout(timeoutMs);
        } else if (options.kind === "selector") {
          const timeoutMs = options.timeout ?? WAIT_DEFAULT_MS;
          const cap = checkTimeout(timeoutMs, WAIT_MAX_MS, "wait");
          if (cap) return cap;
          await page.waitForSelector(options.selector, {
            state: options.state ?? "visible",
            timeout: timeoutMs,
          });
        } else {
          // navigation
          const timeoutMs = options.timeout ?? WAIT_DEFAULT_MS;
          const cap = checkTimeout(timeoutMs, WAIT_MAX_MS, "wait");
          if (cap) return cap;
          await page.waitForNavigation({
            waitUntil: options.event ?? "load",
            timeout: timeoutMs,
          });
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_wait failed", e) };
      }
    },

    async tabNew(options?: BrowserTabNewOptions): Promise<Result<BrowserTabInfo, KoiError>> {
      try {
        const ctx = await ensureContext();
        const page = await ctx.newPage();
        const tabId = newTabId();
        tabs.set(tabId, page);

        if (options?.url) {
          const timeoutMs = options.timeout ?? NAVIGATE_DEFAULT_MS;
          await page.goto(options.url, { timeout: timeoutMs });
        }

        return {
          ok: true,
          value: {
            tabId,
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_tab_new failed", e) };
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

        if (currentTabId === targetId) {
          // Switch to the most recently added remaining tab
          const remaining = [...tabs.keys()];
          currentTabId = remaining[remaining.length - 1] ?? null;
          invalidateSnapshot();
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_tab_close failed", e) };
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
        await page.bringToFront();
        currentTabId = tabId;
        invalidateSnapshot(); // New page content, old refs are stale

        return {
          ok: true,
          value: {
            tabId,
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_tab_focus failed", e) };
      }
    },

    async evaluate(
      script: string,
      options?: BrowserEvaluateOptions,
    ): Promise<Result<BrowserEvaluateResult, KoiError>> {
      try {
        const page = await ensurePage();
        const timeoutMs = options?.timeout ?? EVALUATE_DEFAULT_MS;
        const cap = checkTimeout(timeoutMs, EVALUATE_MAX_MS, "evaluate");
        if (cap) return cap;

        const value: unknown = await page.evaluate(script);
        return { ok: true, value: { value } };
      } catch (e: unknown) {
        return { ok: false, error: internal("browser_evaluate failed", e) };
      }
    },

    async dispose(): Promise<void> {
      invalidateSnapshot();
      // Close all pages
      for (const page of tabs.values()) {
        await page.close().catch(() => undefined);
      }
      tabs.clear();
      currentTabId = null;

      if (browserContext) {
        await browserContext.close().catch(() => undefined);
        browserContext = null;
      }

      // Only close browser if we launched it (not injected)
      if (!config.browser && browser) {
        await browser.close().catch(() => undefined);
        browser = null;
      }
    },
  };
}
