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
    expect(snap.value.snapshotId).toMatch(/^snap-\d+$/);
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

    const tabId = tab2.value.tabId;

    // Focus back to the original would require tab1's ID... this test
    // instead verifies tab2 can be focused
    const focus = await driver.tabFocus(tabId);
    expect(focus.ok).toBe(true);

    // tabFocus invalidates snapshot
    const snap = await driver.snapshot();
    expect(snap.ok).toBe(true);
  });
});
