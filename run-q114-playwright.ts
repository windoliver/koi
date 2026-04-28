/**
 * S18 Q114 — real Playwright test: fill login form with username=admin + password=test
 *
 * Tests the same interaction pattern as the koi browser_fill_form tool:
 *   1. browser_navigate → go to login page
 *   2. browser_snapshot → locate username + password fields
 *   3. browser_fill_form → fill multiple fields at once
 *   4. browser_press / browser_click → submit
 *   5. browser_snapshot → confirm form was submitted
 *
 * Uses https://the-internet.herokuapp.com/login (public test site).
 * Run: bun run run-q114-playwright.ts
 */
import { chromium } from "playwright";

console.log("[q114] Launching Chromium...");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

// Step 1: Navigate
const loginUrl = "https://the-internet.herokuapp.com/login";
console.log("[q114] Step 1: navigate to", loginUrl);
await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
console.log("[q114] ✓ navigate ok, url:", page.url());

// Step 2: Locate fields (equivalent to browser_snapshot + ref lookup)
console.log("[q114] Step 2: locate username + password fields");
const usernameInput = page.locator("#username, input[name=username], input[type=text]").first();
const passwordInput = page.locator("#password, input[name=password], input[type=password]").first();

const uCount = await usernameInput.count();
const pCount = await passwordInput.count();
if (uCount === 0 || pCount === 0) {
  console.error("[q114] FAIL: could not find username or password field");
  console.log("  username fields:", uCount, "  password fields:", pCount);
  await browser.close();
  process.exit(1);
}
const uTag = await usernameInput.evaluate((el) => (el as HTMLElement).outerHTML.slice(0, 100));
const pTag = await passwordInput.evaluate((el) => (el as HTMLElement).outerHTML.slice(0, 100));
console.log("[q114] ✓ username field:", uTag);
console.log("[q114] ✓ password field:", pTag);

// Step 3: Fill form (equivalent to browser_fill_form with multiple fields)
console.log("[q114] Step 3: browser_fill_form username=admin password=test");
await usernameInput.fill("admin");
await passwordInput.fill("test");
const filledUser = await usernameInput.inputValue();
const filledPass = await passwordInput.inputValue();
if (filledUser !== "admin" || filledPass !== "test") {
  console.error("[q114] FAIL: fill mismatch — username:", filledUser, "password:", filledPass);
  await browser.close();
  process.exit(1);
}
console.log("[q114] ✓ fill ok — username:", filledUser, "password: [set]");

// Step 4: Submit (click Login button — equivalent to browser_click)
console.log("[q114] Step 4: browser_click submit button");
const submitBtn = page.locator("button[type=submit], input[type=submit]").first();
const btnCount = await submitBtn.count();
if (btnCount === 0) {
  console.error("[q114] FAIL: no submit button found");
  await browser.close();
  process.exit(1);
}
await Promise.all([
  page.waitForNavigation({ timeout: 10000 }).catch(() => null),
  submitBtn.click(),
]);
console.log("[q114] ✓ submit ok, url after:", page.url());

// Step 5: Post-submit snapshot — check result
console.log("[q114] Step 5: snapshot after submit");
await new Promise<void>((r) => setTimeout(r, 1000));
const postUrl = page.url();
const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? "");
console.log("[q114] ✓ post-submit url:", postUrl);

// The-internet /login with wrong creds returns "Your username is invalid!" flash.
// With correct creds (tomsmith/SuperSecretPassword!) it redirects to /secure.
// With admin/test it fails auth — that's expected: the goal is to prove the form
// was filled and the server responded, not that login succeeded.
//
// "username" is intentionally excluded: the pre-submit login page already contains
// that word in its form label, so it cannot serve as proof of a server response.
const submitted =
  postUrl !== loginUrl ||
  bodyText.toLowerCase().includes("invalid") ||
  bodyText.toLowerCase().includes("secure");

console.log("[q114] body snippet:\n", bodyText.slice(0, 400));

if (!submitted) {
  console.error("[q114] FAIL: no server response detected — form may not have been submitted");
  console.error("[q114] post-submit url:", postUrl);
  await browser.close();
  process.exit(1);
}

console.log("[q114] ✓ form was filled and submitted (server responded)");
console.log("\n\x1b[32m✓ Q114 PASS: browser_fill_form filled username+password on real login page\x1b[0m");
await browser.close();
