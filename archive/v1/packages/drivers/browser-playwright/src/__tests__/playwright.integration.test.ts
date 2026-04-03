/**
 * Integration tests for PlaywrightBrowserDriver with a real Chromium browser.
 *
 * Gated by TEST_BROWSER=1 environment variable.
 * Requires: bunx playwright install chromium
 *
 * Run: TEST_BROWSER=1 bun test packages/browser-playwright
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { BrowserDriver } from "@koi/core";
import { createPlaywrightBrowserDriver } from "../playwright-browser-driver.js";

const SKIP = !process.env.TEST_BROWSER;

describe.skipIf(SKIP)("PlaywrightBrowserDriver (integration)", () => {
  let driver: BrowserDriver;

  beforeAll(async () => {
    driver = createPlaywrightBrowserDriver({ headless: true });
  });

  afterAll(async () => {
    await driver.dispose?.();
  });

  it("snapshots about:blank", async () => {
    const nav = await driver.navigate("about:blank");
    expect(nav.ok).toBe(true);

    const snap = await driver.snapshot();
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    expect(typeof snap.value.snapshot).toBe("string");
    expect(snap.value.snapshotId).toMatch(/^snap-tab-\d+-\d+$/);
    expect(snap.value.truncated).toBe(false);
    expect(snap.value.url).toBe("about:blank");
  });

  it("snapshots a data: URI page with interactive elements", async () => {
    const html = `<!DOCTYPE html>
<html>
  <body>
    <h1>Test Page</h1>
    <button>Click Me</button>
    <a href="#">Go Home</a>
    <input type="text" placeholder="Search" aria-label="Search" />
  </body>
</html>`;
    const nav = await driver.navigate(`data:text/html,${encodeURIComponent(html)}`);
    expect(nav.ok).toBe(true);

    const snap = await driver.snapshot();
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    // Should contain interactive elements with refs
    expect(snap.value.snapshot).toContain("button");
    expect(snap.value.snapshot).toContain("ref=e");
    expect(Object.keys(snap.value.refs).length).toBeGreaterThan(0);
    expect(snap.value.truncated).toBe(false);
  });

  it("type() fills a text input", async () => {
    const html = `<!DOCTYPE html>
<html>
  <body>
    <input type="text" aria-label="Username" id="user" />
  </body>
</html>`;
    await driver.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const snap = await driver.snapshot();
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    const textboxRef = Object.entries(snap.value.refs).find(([, info]) => info.role === "textbox");
    expect(textboxRef).toBeDefined();
    if (!textboxRef) return;

    const typeResult = await driver.type(textboxRef[0], "hello world", {
      snapshotId: snap.value.snapshotId,
    });
    expect(typeResult.ok).toBe(true);
  });

  it("navigate() invalidates snapshot — old snapshotId is stale", async () => {
    await driver.navigate("about:blank");
    const snap1 = await driver.snapshot();
    expect(snap1.ok).toBe(true);
    if (!snap1.ok) return;

    const oldSnapshotId = snap1.value.snapshotId;

    await driver.navigate("about:blank#other");

    // Now try to use old snapshotId
    const click = await driver.click("e1", { snapshotId: oldSnapshotId });
    expect(click.ok).toBe(false);
    if (click.ok) return;
    expect(click.error.code).toBe("NOT_FOUND");
    expect(click.error.message).toContain("stale");
  });

  it("screenshot() returns base64 image data", async () => {
    await driver.navigate("about:blank");
    const result = await driver.screenshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.data).toBeTruthy();
    expect(["image/jpeg", "image/png"]).toContain(result.value.mimeType);
    expect(result.value.width).toBeGreaterThan(0);
    expect(result.value.height).toBeGreaterThan(0);
  });

  it("tabNew() opens a second tab and tabFocus() switches back", async () => {
    const tab2 = await driver.tabNew({ url: "about:blank" });
    expect(tab2.ok).toBe(true);
    if (!tab2.ok) return;

    const focus = await driver.tabFocus(tab2.value.tabId);
    expect(focus.ok).toBe(true);

    const snap = await driver.snapshot();
    expect(snap.ok).toBe(true);
  });

  it("per-tab ref caching: tab-1 refs survive while working on tab-2", async () => {
    // Navigate tab-1 to a page with a known interactive element
    const html1 = `<!DOCTYPE html><html><body><button>Tab1Button</button></body></html>`;
    await driver.navigate(`data:text/html,${encodeURIComponent(html1)}`);

    const snap1 = await driver.snapshot();
    expect(snap1.ok).toBe(true);
    if (!snap1.ok) return;

    const { snapshotId: snap1Id, refs: refs1 } = snap1.value;
    const tab1ButtonRef = Object.entries(refs1).find(
      ([, info]) => info.role === "button" && info.name === "Tab1Button",
    );
    expect(tab1ButtonRef).toBeDefined();
    if (!tab1ButtonRef) return;

    // Open tab-2 and do work there
    const tab2 = await driver.tabNew({ url: "about:blank" });
    expect(tab2.ok).toBe(true);
    if (!tab2.ok) return;

    await driver.snapshot(); // creates a snapshot for tab-2

    // Switch back to tab-1 — tab-1's refs should still be cached
    const focusResult = await driver.tabFocus("tab-1");
    expect(focusResult.ok).toBe(true);

    // Old snapshotId from tab-1 should still be valid (per-tab caching)
    const clickResult = await driver.click(tab1ButtonRef[0], { snapshotId: snap1Id });
    expect(clickResult.ok).toBe(true);
  });

  it("tabList() returns all open tabs", async () => {
    await driver.navigate("about:blank");

    const tab2 = await driver.tabNew({ url: "about:blank" });
    expect(tab2.ok).toBe(true);

    const listResult = await driver.tabList();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    expect(listResult.value.length).toBeGreaterThanOrEqual(2);
    expect(listResult.value.some((t) => t.tabId === "tab-1")).toBe(true);
  });
});
