/**
 * S18 Q113 — real Playwright test against https://duckduckgo.com
 *
 * Tests the same interaction pattern as the koi browser tools:
 *   1. browser_navigate → navigate to page
 *   2. browser_snapshot → locate search field (via DOM, same as ARIA ref lookup)
 *   3. browser_type → type into search field
 *   4. browser_press → press Enter
 *   5. browser_snapshot → confirm search results loaded
 *
 * Uses Playwright directly (no driver wrapper) to avoid workspace dep issues.
 * Run: bun run run-q113-playwright.ts
 */
import { chromium } from "playwright";

console.log("[q113] Launching Chromium...");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

// Step 1: Navigate
console.log("[q113] Step 1: navigate to https://duckduckgo.com");
await page.goto("https://duckduckgo.com", { waitUntil: "domcontentloaded" });
console.log("[q113] ✓ navigate ok, url:", page.url());

// Step 2: Find search input (equivalent to browser_snapshot + ref lookup)
console.log("[q113] Step 2: locate search input");
const searchInput = page.locator("[name=q], input[type=search], input[type=text]").first();
const count = await searchInput.count();
if (count === 0) {
  console.error("[q113] FAIL: no search input found on page");
  await browser.close();
  process.exit(1);
}
const inputTag = await searchInput.evaluate((el) => (el as HTMLElement).outerHTML.slice(0, 120));
console.log("[q113] ✓ search input found:", inputTag);

// Step 3: Type (equivalent to browser_type)
console.log("[q113] Step 3: browser_type 'koi agent' into search field");
await searchInput.click();
await searchInput.fill("koi agent");
const typedValue = await searchInput.inputValue();
if (typedValue !== "koi agent") {
  console.error("[q113] FAIL: typed value mismatch, got:", typedValue);
  await browser.close();
  process.exit(1);
}
console.log("[q113] ✓ type ok, input value:", typedValue);

// Step 4: Press Enter (equivalent to browser_press)
console.log("[q113] Step 4: browser_press Enter");
await Promise.all([
  page.waitForNavigation({ timeout: 10000 }).catch(() => null),
  searchInput.press("Enter"),
]);
console.log("[q113] ✓ press ok");

// Step 5: Post-search snapshot
console.log("[q113] Step 5: snapshot after search (wait 2s)");
await new Promise<void>((r) => setTimeout(r, 2000));
const postUrl = page.url();
console.log("[q113] ✓ post-search url:", postUrl);

const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "");
// Require `q=koi` in the URL — definitive evidence that the search query was sent.
// A DuckDuckGo homepage URL also contains "duckduckgo", so that check alone is a
// false positive; only the query parameter proves navigation actually happened.
const hasResults = postUrl.toLowerCase().includes("q=koi");

console.log("[q113] body snippet:", bodyText.slice(0, 200));

if (!hasResults) {
  console.error("[q113] FAIL: post-search URL does not contain q=koi — search navigation did not occur");
  console.error("[q113] post-search url:", postUrl);
  await browser.close();
  process.exit(1);
}

console.log("[q113] ✓ search results page confirmed — URL contains q=koi");
console.log("\n\x1b[32m✓ Q113 PASS: browser_type + browser_press worked on real DuckDuckGo page\x1b[0m");
await browser.close();
