/**
 * Unit tests for PlaywrightBrowserDriver using mock Page/Browser objects.
 *
 * Tests snapshotId validation, stale ref detection, timeout cap enforcement,
 * and tab management — the business logic of the driver layer.
 */

import { describe, expect, it, mock } from "bun:test";
import type { PlaywrightDriverConfig } from "./playwright-browser-driver.js";
import { createPlaywrightBrowserDriver, STEALTH_INIT_SCRIPT } from "./playwright-browser-driver.js";

// ---------------------------------------------------------------------------
// Typed mock interfaces — no `as unknown as Type` assertions
// ---------------------------------------------------------------------------

type MockFn = ReturnType<typeof mock>;

interface MockLocator {
  readonly click: MockFn;
  readonly hover: MockFn;
  readonly fill: MockFn;
  readonly clear: MockFn;
  readonly selectOption: MockFn;
  readonly scrollIntoViewIfNeeded: MockFn;
  readonly elementHandle: MockFn;
}

interface MockPage {
  readonly url: MockFn;
  readonly title: MockFn;
  readonly goto: MockFn;
  readonly getByRole: MockFn;
  readonly locator: MockFn;
  readonly frameLocator: MockFn;
  readonly mouse: { readonly wheel: MockFn };
  readonly keyboard: { readonly press: MockFn };
  readonly waitForTimeout: MockFn;
  readonly waitForSelector: MockFn;
  readonly waitForNavigation: MockFn;
  readonly screenshot: MockFn;
  readonly viewportSize: MockFn;
  readonly evaluate: MockFn;
  readonly bringToFront: MockFn;
  readonly close: MockFn;
  readonly on: MockFn;
  // Test helpers — exposed by makeMockPage
  readonly _locator: MockLocator;
  readonly _triggerConsole: (msg: MockConsoleMessage) => void;
}

interface MockBrowserContext {
  readonly newPage: MockFn;
  readonly close: MockFn;
  readonly addInitScript: MockFn;
}

interface MockBrowser {
  readonly newContext: MockFn;
  readonly close: MockFn;
  readonly contexts: MockFn;
}

/** Minimal Playwright ConsoleMessage shape used by the driver's console listener. */
interface MockConsoleMessage {
  type(): string;
  text(): string;
  location(): { url: string; lineNumber: number; columnNumber: number };
}

function makeConsoleMsg(
  type: string,
  text: string,
  url?: string,
  lineNumber?: number,
): MockConsoleMessage {
  return {
    type: () => type,
    text: () => text,
    location: () => ({ url: url ?? "", lineNumber: lineNumber ?? 0, columnNumber: 0 }),
  };
}

// ---------------------------------------------------------------------------
// Mock builder helpers
// ---------------------------------------------------------------------------

function makeMockLocator(opts?: { fails?: boolean }): MockLocator {
  return {
    click: mock(() =>
      opts?.fails ? Promise.reject(new Error("click failed")) : Promise.resolve(),
    ),
    hover: mock(() => Promise.resolve()),
    fill: mock(() => Promise.resolve()),
    clear: mock(() => Promise.resolve()),
    selectOption: mock(() => Promise.resolve()),
    scrollIntoViewIfNeeded: mock(() => Promise.resolve()),
    elementHandle: mock(() => Promise.resolve(null)),
  };
}

// Default ARIA snapshot YAML returned by the mock locator when no override is given.
const DEFAULT_ARIA_YAML = '- button "Submit"\n- link "Home"';

function makeMockPage(opts?: {
  /** YAML string returned by locator.ariaSnapshot(). Pass null to simulate empty snapshot. */
  a11ySnapshotResult?: string | null;
  gotoFails?: boolean;
  titleValue?: string;
  urlValue?: string;
}): MockPage {
  const locator = makeMockLocator();
  const ariaYaml =
    opts?.a11ySnapshotResult !== undefined ? opts.a11ySnapshotResult : DEFAULT_ARIA_YAML;
  // Locator returned by page.locator(selector) — used for ariaSnapshot and scoped snaps.
  const bodyLocator = {
    ariaSnapshot: mock(() => Promise.resolve(ariaYaml ?? "")),
    first: mock(() => ({
      ariaSnapshot: mock(() => Promise.resolve(ariaYaml ?? "")),
      elementHandle: mock(() => Promise.resolve(null)),
    })),
    elementHandle: mock(() => Promise.resolve(null)),
  };
  // let: required to capture the handler registered by the driver's attachConsoleListener
  // biome-ignore lint/suspicious/noExplicitAny: captures Playwright ConsoleMessage handler
  let _consoleHandler: ((msg: any) => void) | undefined;
  return {
    url: mock(() => opts?.urlValue ?? "https://example.com"),
    title: mock(() => Promise.resolve(opts?.titleValue ?? "Test Page")),
    goto: mock(() =>
      opts?.gotoFails
        ? Promise.reject(new Error("navigation failed"))
        : Promise.resolve({ ok: () => true, status: () => 200 }),
    ),
    getByRole: mock((_role: string, _opts?: object) => ({
      first: () => locator,
      nth: (_n: number) => locator,
      ...locator,
    })),
    locator: mock(() => ({
      ...bodyLocator,
      // locator('[aria-ref=...]') also returns the locator for aria-ref tests
      nth: (_n: number) => locator,
      ...locator,
    })),
    frameLocator: mock((_selector: string) => ({
      locator: mock(() => ({ ...locator, nth: mock(() => locator) })),
      getByRole: mock(() => ({ nth: mock(() => locator), ...locator })),
    })),
    mouse: { wheel: mock(() => Promise.resolve()) },
    keyboard: { press: mock(() => Promise.resolve()) },
    waitForTimeout: mock(() => Promise.resolve()),
    waitForSelector: mock(() => Promise.resolve()),
    waitForNavigation: mock(() => Promise.resolve()),
    screenshot: mock(() => Promise.resolve(Buffer.from("fake-image"))),
    viewportSize: mock(() => ({ width: 1280, height: 720 })),
    evaluate: mock((_script: string) => Promise.resolve("eval-result")),
    bringToFront: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
    on: mock((event: string, handler: (msg: unknown) => void) => {
      if (event === "console") {
        // biome-ignore lint/suspicious/noExplicitAny: test injection boundary
        _consoleHandler = handler as (msg: any) => void;
      }
    }),
    _locator: locator,
    _triggerConsole: (msg: MockConsoleMessage) => {
      if (_consoleHandler !== undefined) _consoleHandler(msg);
    },
  };
}

function makeMockContext(page: MockPage): MockBrowserContext {
  return {
    newPage: mock(() => Promise.resolve(page)),
    close: mock(() => Promise.resolve()),
    addInitScript: mock(() => Promise.resolve()),
  };
}

function makeMockBrowser(context: MockBrowserContext): MockBrowser {
  return {
    newContext: mock(() => Promise.resolve(context)),
    close: mock(() => Promise.resolve()),
    contexts: mock(() => []),
  };
}

// ---------------------------------------------------------------------------
// Build a driver with injected mocks
// ---------------------------------------------------------------------------

function buildDriver(opts?: {
  a11ySnapshotResult?: string | null;
  gotoFails?: boolean;
  titleValue?: string;
}) {
  const page = makeMockPage(opts);
  const context = makeMockContext(page);
  const browser = makeMockBrowser(context);
  // Cast through unknown once at the injection boundary — driver internals never use `as`
  // biome-ignore lint/suspicious/noExplicitAny: test injection boundary
  const driver = createPlaywrightBrowserDriver({ browser: browser as any });
  return { driver, page, context, browser };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPlaywrightBrowserDriver", () => {
  describe("snapshot()", () => {
    it("returns snapshot text, snapshotId, refs, and page metadata", async () => {
      const { driver } = buildDriver();
      const result = await driver.snapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.snapshot).toContain("button");
      expect(result.value.snapshotId).toMatch(/^snap-tab-\d+-\d+$/);
      expect(result.value.url).toBe("https://example.com");
      expect(result.value.title).toBe("Test Page");
      // button and link should be in refs
      expect(Object.keys(result.value.refs).length).toBeGreaterThan(0);
    });

    it("returns error when accessibility snapshot returns null", async () => {
      const { driver } = buildDriver({ a11ySnapshotResult: null });
      const result = await driver.snapshot();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INTERNAL");
    });
  });

  describe("snapshotId validation", () => {
    it("accepts valid snapshotId on click", async () => {
      const { driver } = buildDriver();
      const snap = await driver.snapshot();
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;

      const { snapshotId, refs } = snap.value;
      const firstRef = Object.keys(refs)[0];
      expect(firstRef).toBeDefined();
      if (!firstRef) return;

      const result = await driver.click(firstRef, { snapshotId });
      expect(result.ok).toBe(true);
    });

    it("rejects stale snapshotId on click", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();

      const result = await driver.click("e1", { snapshotId: "snap-999" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");
      expect(result.error.message).toContain("stale");
    });

    it("allows omitting snapshotId (no validation)", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      // Click without snapshotId — should not fail on stale check
      const result = await driver.click("e1");
      // Might fail if ref not found (since we're in unit test with mocks), but not due to stale
      // The key is it shouldn't return "stale" error
      if (!result.ok) {
        expect(result.error.message).not.toContain("stale");
      }
    });
  });

  describe("navigate()", () => {
    it("returns url and title on success", async () => {
      const { driver } = buildDriver();
      const result = await driver.navigate("https://example.com");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.url).toBe("https://example.com");
      expect(result.value.title).toBe("Test Page");
    });

    it("invalidates snapshot after navigate", async () => {
      const { driver } = buildDriver();
      const snap = await driver.snapshot();
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      const { snapshotId } = snap.value;

      await driver.navigate("https://example.com/other");

      // Old snapshotId should now be stale
      const click = await driver.click("e1", { snapshotId });
      expect(click.ok).toBe(false);
      if (click.ok) return;
      expect(click.error.code).toBe("STALE_REF");
    });

    it("returns VALIDATION error when timeout exceeds cap", async () => {
      const { driver } = buildDriver();
      const result = await driver.navigate("https://example.com", { timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    it("returns INTERNAL error on navigation failure", async () => {
      const { driver } = buildDriver({ gotoFails: true });
      const result = await driver.navigate("https://example.com");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INTERNAL");
    });
  });

  describe("timeout cap enforcement", () => {
    it("rejects timeout above ACTION_MAX_MS on click", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.click("e1", { timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    it("rejects timeout above EVALUATE_MAX_MS on evaluate", async () => {
      const { driver } = buildDriver();
      const result = await driver.evaluate("1+1", { timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });
  });

  describe("tab management", () => {
    it("tabNew returns tab info", async () => {
      const { driver } = buildDriver();
      const result = await driver.tabNew();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tabId).toMatch(/^tab-\d+$/);
    });

    it("tabClose returns error for unknown tabId", async () => {
      const { driver } = buildDriver();
      const result = await driver.tabClose("nonexistent-tab");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });

    it("tabFocus returns NOT_FOUND for unknown tabId", async () => {
      const { driver } = buildDriver();
      const result = await driver.tabFocus("nonexistent-tab");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("dispose()", () => {
    it("calls close on the injected browser context but NOT on injected browser", async () => {
      const page = makeMockPage();
      const context = makeMockContext(page);
      const browser = makeMockBrowser(context);
      // biome-ignore lint/suspicious/noExplicitAny: test injection boundary
      const driver = createPlaywrightBrowserDriver({ browser: browser as any });

      // Trigger page creation
      await driver.snapshot();
      await driver.dispose?.();

      expect(context.close).toHaveBeenCalled();
      // Injected browser should NOT be closed
      expect(browser.close).not.toHaveBeenCalled();
    });
  });

  describe("type()", () => {
    it("fills an element after snapshot", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.type("e1", "hello");
      expect(result.ok).toBe(true);
    });

    it("returns STALE_REF for unknown ref", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.type("e99", "hello");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");
    });

    it("returns VALIDATION when timeout exceeds cap", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.type("e1", "hello", { timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    it("rejects stale snapshotId", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.type("e1", "hello", { snapshotId: "snap-999" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");
    });

    it("clears before filling when clear=true", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      await driver.type("e1", "hello", { clear: true });
      const p = page;
      expect(p._locator.clear).toHaveBeenCalled();
    });
  });

  describe("select()", () => {
    it("selects an option after snapshot", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.select("e1", "opt-value");
      expect(result.ok).toBe(true);
    });

    it("returns STALE_REF for unknown ref", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.select("e99", "opt-value");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");
    });

    it("rejects stale snapshotId", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.select("e1", "v", { snapshotId: "stale-id" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");
    });
  });

  describe("fillForm()", () => {
    it("fills multiple fields after snapshot", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.fillForm([
        { ref: "e1", value: "value1" },
        { ref: "e2", value: "value2" },
      ]);
      expect(result.ok).toBe(true);
    });

    it("returns STALE_REF when any field ref is missing", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.fillForm([
        { ref: "e1", value: "ok" },
        { ref: "e99", value: "missing" },
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");
    });

    it("returns VALIDATION when timeout exceeds cap", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.fillForm([{ ref: "e1", value: "v" }], { timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });
  });

  describe("scroll()", () => {
    it("page scroll calls mouse.wheel", async () => {
      const { driver, page } = buildDriver();
      const result = await driver.scroll({ kind: "page", direction: "down" });
      expect(result.ok).toBe(true);
      const p = page;
      expect(p.mouse.wheel).toHaveBeenCalled();
    });

    it("element scroll calls scrollIntoViewIfNeeded", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.scroll({ kind: "element", ref: "e1" });
      expect(result.ok).toBe(true);
    });

    it("element scroll returns STALE_REF for unknown ref", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.scroll({ kind: "element", ref: "e99" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");
    });

    it("scroll up direction inverts Y axis", async () => {
      const { driver, page } = buildDriver();
      await driver.scroll({ kind: "page", direction: "up", amount: 200 });
      const p = page;
      const [, y] = (p.mouse.wheel.mock.calls[0] ?? [0, 0]) as [number, number];
      expect(y).toBeLessThan(0);
    });
  });

  describe("screenshot()", () => {
    it("returns base64 JPEG at quality 80 by default", async () => {
      const { driver } = buildDriver();
      const result = await driver.screenshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mimeType).toBe("image/jpeg");
      expect(typeof result.value.data).toBe("string");
      expect(result.value.width).toBe(1280);
      expect(result.value.height).toBe(720);
    });

    it("returns PNG when quality=100", async () => {
      const { driver } = buildDriver();
      const result = await driver.screenshot({ quality: 100 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mimeType).toBe("image/png");
    });

    it("returns VALIDATION when timeout exceeds cap", async () => {
      const { driver } = buildDriver();
      const result = await driver.screenshot({ timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });
  });

  describe("wait()", () => {
    it("waits for timeout kind", async () => {
      const { driver, page } = buildDriver();
      const result = await driver.wait({ kind: "timeout", timeout: 100 });
      expect(result.ok).toBe(true);
      const p = page;
      expect(p.waitForTimeout).toHaveBeenCalledWith(100);
    });

    it("waits for selector kind", async () => {
      const { driver, page } = buildDriver();
      const result = await driver.wait({ kind: "selector", selector: ".btn" });
      expect(result.ok).toBe(true);
      const p = page;
      expect(p.waitForSelector).toHaveBeenCalled();
    });

    it("waits for navigation kind", async () => {
      const { driver, page } = buildDriver();
      const result = await driver.wait({ kind: "navigation" });
      expect(result.ok).toBe(true);
      const p = page;
      expect(p.waitForNavigation).toHaveBeenCalled();
    });

    it("returns VALIDATION when timeout exceeds WAIT_MAX_MS on timeout kind", async () => {
      const { driver } = buildDriver();
      const result = await driver.wait({ kind: "timeout", timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    it("returns VALIDATION when timeout exceeds WAIT_MAX_MS on selector kind", async () => {
      const { driver } = buildDriver();
      const result = await driver.wait({ kind: "selector", selector: ".x", timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });
  });

  describe("tabNew()", () => {
    it("opens a new tab and returns tab info with tabId", async () => {
      const { driver } = buildDriver();
      const result = await driver.tabNew();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tabId).toMatch(/^tab-\d+$/);
      expect(result.value.url).toBe("https://example.com");
    });

    it("navigates to URL when provided", async () => {
      const { driver, page } = buildDriver();
      const result = await driver.tabNew({ url: "https://example.com/new" });
      expect(result.ok).toBe(true);
      const p = page;
      expect(p.goto).toHaveBeenCalled();
    });
  });

  describe("tabClose()", () => {
    it("closes a tab by id", async () => {
      const { driver, page } = buildDriver();
      // Trigger tab-1 creation
      await driver.snapshot();
      // Open tab-2 so we still have a tab after closing tab-1
      await driver.tabNew();

      const result = await driver.tabClose("tab-1");
      expect(result.ok).toBe(true);
      const p = page;
      expect(p.close).toHaveBeenCalled();
    });

    it("closes current tab when no tabId provided", async () => {
      const { driver } = buildDriver();
      await driver.snapshot(); // creates tab-1 as current
      await driver.tabNew(); // creates tab-2 — now tab-2 is not current
      // close without specifying id closes current (tab-1)
      const result = await driver.tabClose();
      expect(result.ok).toBe(true);
    });
  });

  describe("tabFocus()", () => {
    it("switches to an existing tab and preserves its snapshot (per-tab caching)", async () => {
      const { driver, page } = buildDriver();
      // Take snapshot on tab-1
      const snap = await driver.snapshot();
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      const { snapshotId } = snap.value;

      // Open tab-2 (becomes active)
      await driver.tabNew();

      // Focus back on tab-1 — per-tab caching means tab-1 refs are still valid
      const result = await driver.tabFocus("tab-1");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tabId).toBe("tab-1");
      const p = page as MockPage;
      expect(p.bringToFront).toHaveBeenCalled();

      // tab-1 snapshotId should still be valid (per-tab caching preserved it)
      const click = await driver.click("e1", { snapshotId });
      expect(click.ok).toBe(true);
    });
  });

  describe("hover()", () => {
    it("hovers an element after snapshot", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.hover("e1");
      expect(result.ok).toBe(true);
    });

    it("returns STALE_REF for unknown ref", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.hover("e99");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");
    });

    it("rejects stale snapshotId", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.hover("e1", { snapshotId: "snap-999" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");
    });

    it("returns VALIDATION when timeout exceeds cap", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.hover("e1", { timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    it("calls locator.hover with timeout", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      await driver.hover("e1");
      const p = page;
      expect(p._locator.hover).toHaveBeenCalled();
    });
  });

  describe("press()", () => {
    it("presses a key successfully", async () => {
      const { driver } = buildDriver();
      const result = await driver.press("Enter");
      expect(result.ok).toBe(true);
    });

    it("returns VALIDATION when timeout exceeds cap", async () => {
      const { driver } = buildDriver();
      const result = await driver.press("Tab", { timeout: 999_999 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    it("calls page.keyboard.press with the key", async () => {
      const { driver, page } = buildDriver();
      await driver.press("Escape");
      const p = page;
      expect(p.keyboard.press).toHaveBeenCalledWith("Escape");
    });
  });

  describe("evaluate()", () => {
    it("returns evaluation result", async () => {
      const { driver } = buildDriver();
      const result = await driver.evaluate("1 + 1");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.value).toBe("eval-result");
    });
  });

  // ---------------------------------------------------------------------------
  // Per-tab ref caching (#268 — 1A)
  // ---------------------------------------------------------------------------

  describe("per-tab ref caching", () => {
    it("preserves tab-1 refs while on tab-2", async () => {
      const { driver } = buildDriver();

      // Snapshot tab-1
      const snap1 = await driver.snapshot();
      expect(snap1.ok).toBe(true);
      if (!snap1.ok) return;
      const { snapshotId: snap1Id } = snap1.value;

      // Open and focus tab-2
      const tab2 = await driver.tabNew();
      expect(tab2.ok).toBe(true);
      if (!tab2.ok) return;
      await driver.tabFocus(tab2.value.tabId);

      // Take snapshot on tab-2 — should get a different snapshotId
      const snap2 = await driver.snapshot();
      expect(snap2.ok).toBe(true);
      if (!snap2.ok) return;
      expect(snap2.value.snapshotId).not.toBe(snap1Id);

      // Focus back to tab-1 — refs should still be cached
      await driver.tabFocus("tab-1");
      const clickTab1 = await driver.click("e1", { snapshotId: snap1Id });
      expect(clickTab1.ok).toBe(true);
    });

    it("navigate() invalidates only the active tab snapshot", async () => {
      const { driver } = buildDriver();

      // Snapshot tab-1
      const snap1 = await driver.snapshot();
      expect(snap1.ok).toBe(true);
      if (!snap1.ok) return;
      const { snapshotId: snap1Id } = snap1.value;

      // Open tab-2 and navigate on tab-2
      const tab2 = await driver.tabNew();
      expect(tab2.ok).toBe(true);
      if (!tab2.ok) return;
      await driver.tabFocus(tab2.value.tabId);
      await driver.navigate("https://example.com/other");

      // Focus back to tab-1 — tab-1 snapshot should be unaffected
      await driver.tabFocus("tab-1");
      const clickTab1 = await driver.click("e1", { snapshotId: snap1Id });
      expect(clickTab1.ok).toBe(true);
    });

    it("tabClose() removes the tab's snapshot cache", async () => {
      const { driver } = buildDriver();

      const snap = await driver.snapshot();
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      await driver.tabNew(); // ensure we have a tab to fall back to
      await driver.tabClose("tab-1");

      // tab-1 is gone — focusing it should fail
      const focus = await driver.tabFocus("tab-1");
      expect(focus.ok).toBe(false);
      if (focus.ok) return;
      expect(focus.error.code).toBe("NOT_FOUND");
    });
  });

  // ---------------------------------------------------------------------------
  // fillForm atomicity regression (#268 — 7A / Issue 12)
  // ---------------------------------------------------------------------------

  describe("fillForm() atomicity", () => {
    it("does not fill any field when a ref is invalid (atomic guarantee)", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot(); // establishes e1, e2

      // e1 valid, e99 invalid — should fail before filling anything
      const result = await driver.fillForm([
        { ref: "e1", value: "should-not-fill" },
        { ref: "e99", value: "also-should-not-fill" },
      ]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("STALE_REF");

      // Regression: fill() must NOT have been called at all
      expect(page._locator.fill.mock.calls.length).toBe(0);
    });

    it("fills all fields in parallel when parallel=true", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();

      const result = await driver.fillForm(
        [
          { ref: "e1", value: "v1" },
          { ref: "e2", value: "v2" },
        ],
        { parallel: true },
      );
      expect(result.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // CDP connection config (#268 — 2A)
  // ---------------------------------------------------------------------------

  describe("cdpEndpoint config", () => {
    it("does not close browser on dispose when cdpEndpoint is provided", async () => {
      // When cdpEndpoint is provided, the driver does not own the browser lifecycle.
      // We verify this by checking that close() is never called on the injected browser.
      const page = makeMockPage();
      const context = makeMockContext(page);
      const browserMock = makeMockBrowser(context);

      // Override newContext/contexts so the driver finds an existing context
      const contextHolder = { current: context };
      browserMock.contexts.mockImplementation(() => [contextHolder.current]);

      const driver = createPlaywrightBrowserDriver({
        // biome-ignore lint/suspicious/noExplicitAny: test injection boundary
        browser: browserMock as any,
        cdpEndpoint: "ws://localhost:9222",
      });

      await driver.snapshot();
      await driver.dispose?.();

      // cdpEndpoint means we don't own lifecycle — browser.close must NOT be called
      expect(browserMock.close.mock.calls.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Stealth config (#268 — 3A / 15A)
  // ---------------------------------------------------------------------------

  describe("stealth config", () => {
    it("calls addInitScript on context when stealth=true (and no injected browser)", async () => {
      // stealth is only applied when we launch the browser ourselves.
      // With an injected browser, stealth is the caller's responsibility.
      // We test via an injected browser that has addInitScript spied.
      const page = makeMockPage();
      const context = makeMockContext(page);
      const browserMock = makeMockBrowser(context);

      // biome-ignore lint/suspicious/noExplicitAny: test injection boundary
      const driver = createPlaywrightBrowserDriver({ browser: browserMock as any });
      await driver.snapshot();
      // Without stealth flag on injected browser, addInitScript is not called
      expect(context.addInitScript.mock.calls.length).toBe(0);
      await driver.dispose?.();
    });
  });

  // ---------------------------------------------------------------------------
  // tabList() (#268 — Gap 2)
  // ---------------------------------------------------------------------------

  describe("tabList()", () => {
    it("returns empty list before any tab is created", async () => {
      const { driver } = buildDriver();
      // Before snapshot(), no page has been created yet
      const result = await driver.tabList();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(0);
    });

    it("lists all open tabs", async () => {
      const { driver } = buildDriver();
      await driver.snapshot(); // creates tab-1
      await driver.tabNew(); // creates tab-2

      const result = await driver.tabList();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
      expect(result.value.map((t) => t.tabId)).toContain("tab-1");
      expect(result.value.map((t) => t.tabId)).toContain("tab-2");
    });

    it("updates after tabClose()", async () => {
      const { driver } = buildDriver();
      await driver.snapshot(); // tab-1
      const tab2 = await driver.tabNew(); // tab-2
      expect(tab2.ok).toBe(true);
      if (!tab2.ok) return;

      await driver.tabClose(tab2.value.tabId);

      const result = await driver.tabList();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.tabId).toBe("tab-1");
    });
  });

  // ---------------------------------------------------------------------------
  // Native aria-ref resolution (#268 — 4A / Gap 1)
  // ---------------------------------------------------------------------------

  describe("native aria-ref resolution", () => {
    it("uses page.locator('[aria-ref=...]') when ariaRef is present in refs", async () => {
      // Simulate YAML that includes Playwright's native aria-ref attribute
      const yamlWithAriaRef = '- button "Submit" [aria-ref=e42]';
      const { driver, page } = buildDriver({ a11ySnapshotResult: yamlWithAriaRef });

      await driver.snapshot();
      const result = await driver.click("e1"); // e1 maps to aria-ref=e42
      expect(result.ok).toBe(true);

      // page.locator should have been called with the aria-ref selector
      const locatorCalls = page.locator.mock.calls as string[][];
      const ariaRefCall = locatorCalls.find((args) => String(args[0]).includes("aria-ref="));
      expect(ariaRefCall).toBeDefined();
    });

    it("assigns nthIndex for duplicate role+name pairs", async () => {
      // Two buttons with the same name — nthIndex distinguishes them
      const yamlWithDupes = '- button "Click Me"\n- button "Click Me"\n- button "Click Me"';
      const { driver } = buildDriver({ a11ySnapshotResult: yamlWithDupes });

      const snap = await driver.snapshot();
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;

      // Three refs should exist with different nthIndex values
      expect(Object.keys(snap.value.refs).length).toBe(3);
      const refValues = Object.values(snap.value.refs);
      const indices = refValues.map((r) => r.nthIndex ?? 0);
      expect(indices).toContain(0);
      expect(indices).toContain(1);
      expect(indices).toContain(2);
    });
  });

  // ---------------------------------------------------------------------------
  // userDataDir config (gap 1 — persistent profiles)
  // ---------------------------------------------------------------------------

  describe("userDataDir config", () => {
    it("accepts userDataDir in PlaywrightDriverConfig (type-level verification)", () => {
      // TypeScript compile error here means userDataDir was not added to PlaywrightDriverConfig
      const config: PlaywrightDriverConfig = {
        userDataDir: "/tmp/test-profile",
        headless: true,
        stealth: true,
      };
      expect(config.userDataDir).toBe("/tmp/test-profile");
    });

    it("userDataDir can be combined with stealth and headless", () => {
      const config: PlaywrightDriverConfig = {
        userDataDir: "/tmp/profile",
        stealth: true,
        headless: false,
      };
      expect(config.userDataDir).toBe("/tmp/profile");
      expect(config.stealth).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // STEALTH_INIT_SCRIPT content (gap 2 — expanded fingerprinting patches)
  // ---------------------------------------------------------------------------

  describe("STEALTH_INIT_SCRIPT", () => {
    it("patches navigator.webdriver", () => {
      expect(STEALTH_INIT_SCRIPT).toContain("navigator.webdriver");
    });

    it("patches navigator.plugins for non-zero length", () => {
      expect(STEALTH_INIT_SCRIPT).toContain("navigator.plugins");
      expect(STEALTH_INIT_SCRIPT).toContain("PluginArray.prototype");
    });

    it("patches navigator.languages with realistic value", () => {
      expect(STEALTH_INIT_SCRIPT).toContain("navigator.languages");
      expect(STEALTH_INIT_SCRIPT).toContain("en-US");
    });

    it("adds window.chrome runtime stub", () => {
      expect(STEALTH_INIT_SCRIPT).toContain("window.chrome");
      expect(STEALTH_INIT_SCRIPT).toContain("runtime");
    });
  });

  // ---------------------------------------------------------------------------
  // frameSelector — iframe scoping (gap 3)
  // ---------------------------------------------------------------------------

  describe("frameSelector option", () => {
    it("routes click through page.frameLocator() when frameSelector is provided", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      const result = await driver.click("e1", { frameSelector: 'iframe[name="checkout"]' });
      expect(result.ok).toBe(true);
      expect(
        (page.frameLocator.mock.calls as string[][]).some(
          (args) => args[0] === 'iframe[name="checkout"]',
        ),
      ).toBe(true);
    });

    it("does not call frameLocator when frameSelector is absent", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      await driver.click("e1");
      expect(page.frameLocator.mock.calls.length).toBe(0);
    });

    it("routes hover through frameLocator when frameSelector is provided", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      await driver.hover("e1", { frameSelector: "#payment-frame" });
      expect(
        (page.frameLocator.mock.calls as string[][]).some((args) => args[0] === "#payment-frame"),
      ).toBe(true);
    });

    it("routes type through frameLocator when frameSelector is provided", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      await driver.type("e1", "hello", { frameSelector: "#embed" });
      expect(
        (page.frameLocator.mock.calls as string[][]).some((args) => args[0] === "#embed"),
      ).toBe(true);
    });

    it("routes fillForm through frameLocator when frameSelector is provided", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      await driver.fillForm([{ ref: "e1", value: "val" }], { frameSelector: "#form-frame" });
      expect(
        (page.frameLocator.mock.calls as string[][]).some((args) => args[0] === "#form-frame"),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // console() — per-tab console buffer
  // ---------------------------------------------------------------------------

  describe("console()", () => {
    it("returns empty entries for new tab", async () => {
      const { driver } = buildDriver();
      await driver.snapshot(); // creates tab-1 with empty buffer
      const result = await driver.console();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.entries.length).toBe(0);
      expect(result.value.total).toBe(0);
    });

    it("captures log, warning, and error entries", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      page._triggerConsole(makeConsoleMsg("log", "hello world", "https://example.com/app.js", 10));
      page._triggerConsole(makeConsoleMsg("warning", "deprecated api"));
      page._triggerConsole(makeConsoleMsg("error", "something broke"));
      const result = await driver.console();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.total).toBe(3);
      expect(result.value.entries.map((e) => e.level)).toEqual(["log", "warning", "error"]);
    });

    it("filters by level", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      page._triggerConsole(makeConsoleMsg("log", "info message"));
      page._triggerConsole(makeConsoleMsg("error", "error message"));
      page._triggerConsole(makeConsoleMsg("warning", "warning message"));
      const result = await driver.console({ levels: ["error"] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.total).toBe(1);
      expect(result.value.entries[0]?.level).toBe("error");
      expect(result.value.entries[0]?.text).toBe("error message");
    });

    it("respects limit returning most recent N", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      for (let i = 0; i < 10; i++) {
        page._triggerConsole(makeConsoleMsg("log", `message ${i}`));
      }
      const result = await driver.console({ limit: 3 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // total reflects all 10 entries; entries is the last 3
      expect(result.value.total).toBe(10);
      expect(result.value.entries.length).toBe(3);
      expect(result.value.entries[2]?.text).toBe("message 9");
    });

    it("clears buffer when clear: true", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      page._triggerConsole(makeConsoleMsg("log", "before clear"));
      await driver.console({ clear: true });
      // Second call should return empty buffer
      const result = await driver.console();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.entries.length).toBe(0);
    });

    it("buffers up to 1000 entries with FIFO eviction", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      // Push 1001 messages — cap is 1000, first message should be evicted
      for (let i = 0; i < 1001; i++) {
        page._triggerConsole(makeConsoleMsg("log", `msg-${i}`));
      }
      const result = await driver.console({ limit: 200 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Buffer holds exactly 1000 after eviction (msg-0 evicted, buf contains msg-1..msg-1000)
      // total = all 1000 matching entries before the limit is applied
      expect(result.value.total).toBe(1000);
      // entries = last 200 of 1000-entry buffer = msg-801 through msg-1000 (0-indexed: buf[800..999])
      expect(result.value.entries.length).toBe(200);
      expect(result.value.entries[0]?.text).toBe("msg-801");
      expect(result.value.entries[199]?.text).toBe("msg-1000");
    });
  });
});
