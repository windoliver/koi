/**
 * Unit tests for PlaywrightBrowserDriver using mock Page/Browser objects.
 *
 * Tests snapshotId validation, stale ref detection, timeout cap enforcement,
 * and tab management — the business logic of the driver layer.
 */

import { describe, expect, it, mock } from "bun:test";
import type { Browser, BrowserContext, ElementHandle, Page } from "playwright";
import { createPlaywrightBrowserDriver } from "./playwright-browser-driver.js";

// ---------------------------------------------------------------------------
// Mock builder helpers
// ---------------------------------------------------------------------------

function makeMockLocator(opts?: { fails?: boolean }) {
  return {
    click: mock(() =>
      opts?.fails ? Promise.reject(new Error("click failed")) : Promise.resolve(),
    ),
    hover: mock(() => Promise.resolve()),
    fill: mock(() => Promise.resolve()),
    clear: mock(() => Promise.resolve()),
    selectOption: mock(() => Promise.resolve()),
    scrollIntoViewIfNeeded: mock(() => Promise.resolve()),
    elementHandle: mock(() => Promise.resolve(null as ElementHandle | null)),
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
}) {
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
  const page = {
    url: mock(() => opts?.urlValue ?? "https://example.com"),
    title: mock(() => Promise.resolve(opts?.titleValue ?? "Test Page")),
    goto: mock(() =>
      opts?.gotoFails
        ? Promise.reject(new Error("navigation failed"))
        : Promise.resolve({ ok: () => true, status: () => 200 }),
    ),
    getByRole: mock((_role: string, _opts?: object) => {
      return {
        first: () => locator,
        ...locator,
      };
    }),
    locator: mock(() => bodyLocator),
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
    _locator: locator, // expose for assertions
  } as unknown as Page & { _locator: ReturnType<typeof makeMockLocator> };
  return page;
}

function makeMockContext(page: Page) {
  return {
    newPage: mock(() => Promise.resolve(page)),
    close: mock(() => Promise.resolve()),
  } as unknown as BrowserContext;
}

function makeMockBrowser(context: BrowserContext) {
  return {
    newContext: mock(() => Promise.resolve(context)),
    close: mock(() => Promise.resolve()),
  } as unknown as Browser;
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
  const driver = createPlaywrightBrowserDriver({ browser });
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
      expect(result.value.snapshotId).toMatch(/^snap-\d+$/);
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
      expect(result.error.code).toBe("NOT_FOUND");
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
      expect(click.error.code).toBe("NOT_FOUND");
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
      const driver = createPlaywrightBrowserDriver({ browser });

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

    it("returns NOT_FOUND for unknown ref", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.type("e99", "hello");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
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
      expect(result.error.code).toBe("NOT_FOUND");
    });

    it("clears before filling when clear=true", async () => {
      const { driver, page } = buildDriver();
      await driver.snapshot();
      await driver.type("e1", "hello", { clear: true });
      const p = page as unknown as ReturnType<typeof makeMockPage>;
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

    it("returns NOT_FOUND for unknown ref", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.select("e99", "opt-value");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });

    it("rejects stale snapshotId", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.select("e1", "v", { snapshotId: "stale-id" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
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

    it("returns NOT_FOUND when any field ref is missing", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.fillForm([
        { ref: "e1", value: "ok" },
        { ref: "e99", value: "missing" },
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
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
      const p = page as unknown as ReturnType<typeof makeMockPage>;
      expect(p.mouse.wheel).toHaveBeenCalled();
    });

    it("element scroll calls scrollIntoViewIfNeeded", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.scroll({ kind: "element", ref: "e1" });
      expect(result.ok).toBe(true);
    });

    it("element scroll returns NOT_FOUND for unknown ref", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.scroll({ kind: "element", ref: "e99" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });

    it("scroll up direction inverts Y axis", async () => {
      const { driver, page } = buildDriver();
      await driver.scroll({ kind: "page", direction: "up", amount: 200 });
      const p = page as unknown as ReturnType<typeof makeMockPage>;
      const [, y] = (p.mouse.wheel as ReturnType<typeof mock>).mock.calls[0] as [number, number];
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
      const p = page as unknown as ReturnType<typeof makeMockPage>;
      expect(p.waitForTimeout).toHaveBeenCalledWith(100);
    });

    it("waits for selector kind", async () => {
      const { driver, page } = buildDriver();
      const result = await driver.wait({ kind: "selector", selector: ".btn" });
      expect(result.ok).toBe(true);
      const p = page as unknown as ReturnType<typeof makeMockPage>;
      expect(p.waitForSelector).toHaveBeenCalled();
    });

    it("waits for navigation kind", async () => {
      const { driver, page } = buildDriver();
      const result = await driver.wait({ kind: "navigation" });
      expect(result.ok).toBe(true);
      const p = page as unknown as ReturnType<typeof makeMockPage>;
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
      const p = page as unknown as ReturnType<typeof makeMockPage>;
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
      const p = page as unknown as ReturnType<typeof makeMockPage>;
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
    it("switches to an existing tab and invalidates snapshot", async () => {
      const { driver, page } = buildDriver();
      // Take snapshot to get tab-1 and a snapshotId
      await driver.snapshot();
      const snap = await driver.snapshot();
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      const { snapshotId } = snap.value;

      // Open tab-2
      await driver.tabNew();

      // Focus back on tab-1
      const result = await driver.tabFocus("tab-1");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tabId).toBe("tab-1");
      const p = page as unknown as ReturnType<typeof makeMockPage>;
      expect(p.bringToFront).toHaveBeenCalled();

      // tabFocus invalidates snapshot — old snapshotId should be stale
      const click = await driver.click("e1", { snapshotId });
      expect(click.ok).toBe(false);
      if (click.ok) return;
      expect(click.error.code).toBe("NOT_FOUND");
    });
  });

  describe("hover()", () => {
    it("hovers an element after snapshot", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.hover("e1");
      expect(result.ok).toBe(true);
    });

    it("returns NOT_FOUND for unknown ref", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.hover("e99");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });

    it("rejects stale snapshotId", async () => {
      const { driver } = buildDriver();
      await driver.snapshot();
      const result = await driver.hover("e1", { snapshotId: "snap-999" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
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
      const p = page as unknown as ReturnType<typeof makeMockPage>;
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
      const p = page as unknown as ReturnType<typeof makeMockPage>;
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
});
