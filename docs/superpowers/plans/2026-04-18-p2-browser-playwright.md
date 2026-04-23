# P2 — `@koi/browser-playwright` Port + `wsEndpoint` Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port v1's Playwright-based `BrowserDriver` implementation from `archive/v1/packages/drivers/browser-playwright/` to `packages/drivers/browser-playwright/` as an L2 package, rewiring `a11y-serializer` / `error-translator` imports to the L0u `@koi/browser-a11y` package landed in P1, and adding a new `wsEndpoint` transport option that will let the browser-ext driver (P5) pipe CDP through a loopback WebSocket bridged to its native host.

**Architecture:** Single L2 package under `packages/drivers/browser-playwright/`. Depends on `@koi/core` (L0), `@koi/browser-a11y` (L0u, P1), and `playwright` (external). Preserves the existing `PlaywrightDriverConfig` shape (cdpEndpoint, userDataDir, stealth, blockPrivateAddresses, etc.) and adds exactly one new option: `wsEndpoint`. No behavior change to the 20 existing `BrowserDriver` methods. The port is ~90% mechanical (copy + import rewire + register) with one focused feature addition (wsEndpoint).

**Tech Stack:** Bun 1.3.x, TypeScript 6 strict, tsup build, `bun:test`, Biome, Playwright 1.49+. Follows the L2 pattern visible at `packages/drivers/engine-claude/` and `packages/drivers/engine-external/` for scaffold conventions.

**Spec reference:** `docs/superpowers/specs/2026-04-18-issue-1609-browser-ext-design.md` §5.1 (package layout), §6.7 (Playwright transport integration), §10.1 (unit tests).

**Stacking:** This plan runs on top of P1's commits. P1 merges to `main` as its own PR; until that lands, P2 stacks on the same local branch (`worktree-issue-1609-browser-ext`) and rebases onto `main` after P1 merges. Alternative: implementer creates a dedicated `p2-browser-playwright` branch from current HEAD; either works.

---

## File structure

Files this plan creates:

```
packages/drivers/browser-playwright/
  package.json                                              ← L2 manifest
  tsconfig.json                                             ← extends base, references @koi/core + @koi/browser-a11y
  tsup.config.ts                                            ← ESM-only build
  src/
    browser-detection.ts                                    ← ported verbatim from v1 (~117 LOC)
    playwright-browser-driver.ts                            ← ported from v1 (~1133 LOC), with import rewire + wsEndpoint addition
    index.ts                                                ← public API (trimmed vs v1 — a11y re-exports gone)
    __tests__/
      browser-detection.test.ts                             ← ported verbatim (~56 LOC)
      playwright-browser-driver.test.ts                     ← ported with adjusted imports (~1325 LOC)
      ws-endpoint.test.ts                                   ← NEW: covers the wsEndpoint option
      api-surface.test.ts                                   ← NEW: pins public export list
```

Files this plan modifies:

```
scripts/layers.ts                                           ← add "@koi/browser-playwright" to L2_PACKAGES
docs/L2/browser-playwright.md                               ← port v1 doc, annotate wsEndpoint + updated import graph
```

**Deferred to later plans:**
- Runtime wiring into `@koi/runtime` — P7 integration plan.
- Golden-query cassettes — P7.
- Actual use of `wsEndpoint` by a real bridge — P5 (`@koi/browser-ext` driver provides the local WS server that Playwright connects to).

---

## Task 1: Scaffold `@koi/browser-playwright` L2 package

**Files:**
- Create: `packages/drivers/browser-playwright/package.json`
- Create: `packages/drivers/browser-playwright/tsconfig.json`
- Create: `packages/drivers/browser-playwright/tsup.config.ts`
- Create: `packages/drivers/browser-playwright/src/index.ts` (placeholder)
- Create: `packages/drivers/browser-playwright/src/__tests__/` (empty)

- [ ] **Step 1: Create the directory tree**

```bash
mkdir -p packages/drivers/browser-playwright/src/__tests__
```

- [ ] **Step 2: Write `packages/drivers/browser-playwright/package.json`** with EXACT contents:

```json
{
  "name": "@koi/browser-playwright",
  "description": "Playwright implementation of BrowserDriver — CDP-over-Playwright driver for agent browser automation, with optional wsEndpoint transport for extension bridging",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/browser-a11y": "workspace:*",
    "playwright": "^1.49.0"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test",
    "test:api": "bun test src/__tests__/api-surface.test.ts"
  }
}
```

Notes:
- No `@koi/token-estimator` dep (v1 had it only because `a11y-serializer.ts` used `CHARS_PER_TOKEN`; now that file lives in `@koi/browser-a11y` which pulls token-estimator transitively).
- Playwright version matches v1's `^1.49.0`.

- [ ] **Step 3: Write `packages/drivers/browser-playwright/tsconfig.json`**:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../kernel/core" },
    { "path": "../../lib/browser-a11y" }
  ]
}
```

- [ ] **Step 4: Write `packages/drivers/browser-playwright/tsup.config.ts`**:

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
  external: ["playwright"],
});
```

(Playwright is an external — not bundled. Consumers install it themselves via their own deps.)

- [ ] **Step 5: Write placeholder `src/index.ts`**:

```typescript
export {};
```

- [ ] **Step 6: Install workspace deps**

Run: `bun install`
Expected: `@koi/browser-playwright` now resolves. Playwright tarball downloads if not already cached.

- [ ] **Step 7: Verify empty build**

Run: `bun run --cwd packages/drivers/browser-playwright build`
Expected: `dist/index.js` + `dist/index.d.ts` created. Empty output.

- [ ] **Step 8: Commit**

```bash
git add packages/drivers/browser-playwright/ bun.lock
git commit -m "feat(browser-playwright): scaffold L2 package structure"
```

---

## Task 2: Port `browser-detection.ts` with its test first

`browser-detection.ts` is independent of the a11y/error rewire — a fully verbatim port.

**Files:**
- Create: `packages/drivers/browser-playwright/src/__tests__/browser-detection.test.ts`
- Create: `packages/drivers/browser-playwright/src/browser-detection.ts`

- [ ] **Step 1: Copy v1 test**

```bash
cp archive/v1/packages/drivers/browser-playwright/src/browser-detection.test.ts packages/drivers/browser-playwright/src/__tests__/browser-detection.test.ts
```

- [ ] **Step 2: Adjust the test's import path**

Edit `packages/drivers/browser-playwright/src/__tests__/browser-detection.test.ts`:
- Find: `from "./browser-detection"` (or `from "./browser-detection.js"`)
- Replace with: `from "../browser-detection.js"`

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/drivers/browser-playwright/src/__tests__/browser-detection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Copy v1 implementation**

```bash
cp archive/v1/packages/drivers/browser-playwright/src/browser-detection.ts packages/drivers/browser-playwright/src/browser-detection.ts
```

- [ ] **Step 5: Verify imports are v2-compatible**

Open `packages/drivers/browser-playwright/src/browser-detection.ts`. The v1 file uses only Node built-ins (`node:fs`, `node:path`, `node:os`) and no `@koi/*` imports. Confirm no `@koi/*` import lines exist. If any do, STOP and report BLOCKED.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/drivers/browser-playwright/src/__tests__/browser-detection.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `bun run --cwd packages/drivers/browser-playwright typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/drivers/browser-playwright/src/browser-detection.ts packages/drivers/browser-playwright/src/__tests__/browser-detection.test.ts
git commit -m "feat(browser-playwright): port browser-detection from v1"
```

---

## Task 3: Port `playwright-browser-driver.ts` with rewired imports

This is the main port. Two small surgical changes vs v1:

1. Remove the two relative imports `from "./a11y-serializer.js"` and `from "./error-translator.js"`.
2. Add a single import `from "@koi/browser-a11y"` with the five symbols that v1 pulled locally (`parseAriaYaml`, `VALID_ROLES`, `translatePlaywrightError`; the v1 file also internally uses `isAriaRole` as a type narrowing identity, but that's defined locally in the v1 driver file — leave it alone).

**Files:**
- Create: `packages/drivers/browser-playwright/src/__tests__/playwright-browser-driver.test.ts`
- Create: `packages/drivers/browser-playwright/src/playwright-browser-driver.ts`

- [ ] **Step 1: Copy v1 test**

```bash
cp archive/v1/packages/drivers/browser-playwright/src/playwright-browser-driver.test.ts packages/drivers/browser-playwright/src/__tests__/playwright-browser-driver.test.ts
```

- [ ] **Step 2: Adjust test imports**

The v1 test imports from `./playwright-browser-driver.js` and may also import helpers from `./a11y-serializer.js` / `./error-translator.js`. Scan and adjust:
- Find every `from "./playwright-browser-driver"` or `from "./playwright-browser-driver.js"` → replace with `from "../playwright-browser-driver.js"`.
- Find every `from "./a11y-serializer"` / `.js"` → replace with `from "@koi/browser-a11y"`.
- Find every `from "./error-translator"` / `.js"` → replace with `from "@koi/browser-a11y"`.

Run this grep to enumerate matches first:
```bash
grep -n 'from "\.\/' packages/drivers/browser-playwright/src/__tests__/playwright-browser-driver.test.ts
```
Apply the replacements for each reported line.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/drivers/browser-playwright/src/__tests__/playwright-browser-driver.test.ts`
Expected: FAIL — `../playwright-browser-driver.js` not found.

- [ ] **Step 4: Copy v1 implementation**

```bash
cp archive/v1/packages/drivers/browser-playwright/src/playwright-browser-driver.ts packages/drivers/browser-playwright/src/playwright-browser-driver.ts
```

- [ ] **Step 5: Rewire the two a11y/error imports**

Open `packages/drivers/browser-playwright/src/playwright-browser-driver.ts`. Find the two lines (they will be adjacent, around lines 55-56):

```typescript
import { parseAriaYaml, VALID_ROLES } from "./a11y-serializer.js";
import { translatePlaywrightError } from "./error-translator.js";
```

Replace them with a single line:

```typescript
import { parseAriaYaml, translatePlaywrightError, VALID_ROLES } from "@koi/browser-a11y";
```

No other code changes in this task. Do NOT introduce `wsEndpoint` yet — that's Task 5.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/drivers/browser-playwright/src/__tests__/playwright-browser-driver.test.ts`
Expected: PASS. v1 had 1325 LOC of tests — count matters only as rough shape; all should pass.

If any test fails, check whether the failure is because:
(a) the rewire is wrong — re-inspect the import change.
(b) a TS6 strict issue surfaced because v2's strictness differs from v1's. If so, STOP and report BLOCKED with the exact test + error.

Do NOT silently weaken any compile flag.

- [ ] **Step 7: Typecheck**

Run: `bun run --cwd packages/drivers/browser-playwright typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/drivers/browser-playwright/src/playwright-browser-driver.ts packages/drivers/browser-playwright/src/__tests__/playwright-browser-driver.test.ts
git commit -m "feat(browser-playwright): port playwright-browser-driver from v1 (a11y imports → @koi/browser-a11y)"
```

---

## Task 4: Wire public API via `src/index.ts`

v1's `index.ts` re-exported the a11y symbols directly. In v2 those live in `@koi/browser-a11y` — consumers should import them from there. The browser-playwright `index.ts` therefore shrinks to only the driver + detection surface.

**Files:**
- Create: `packages/drivers/browser-playwright/src/__tests__/api-surface.test.ts`
- Modify: `packages/drivers/browser-playwright/src/index.ts`

- [ ] **Step 1: Write the api-surface guard test first**

Create `packages/drivers/browser-playwright/src/__tests__/api-surface.test.ts` with EXACT contents:

```typescript
import { describe, expect, test } from "bun:test";

import * as publicApi from "../index.js";

describe("@koi/browser-playwright public API surface", () => {
  test("exports createPlaywrightBrowserDriver factory", () => {
    expect(typeof publicApi.createPlaywrightBrowserDriver).toBe("function");
  });

  test("exports detectInstalledBrowsers function", () => {
    expect(typeof publicApi.detectInstalledBrowsers).toBe("function");
  });

  test("exports STEALTH_INIT_SCRIPT as a non-empty string", () => {
    expect(typeof publicApi.STEALTH_INIT_SCRIPT).toBe("string");
    expect(publicApi.STEALTH_INIT_SCRIPT.length).toBeGreaterThan(0);
  });

  test("exported names pin to exactly three runtime symbols", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "STEALTH_INIT_SCRIPT",
      "createPlaywrightBrowserDriver",
      "detectInstalledBrowsers",
    ]);
  });
});
```

- [ ] **Step 2: Run the api-surface test to verify it fails**

Run: `bun test packages/drivers/browser-playwright/src/__tests__/api-surface.test.ts`
Expected: FAIL — placeholder `export {};` exposes nothing.

- [ ] **Step 3: Write the real `src/index.ts`**

Replace `packages/drivers/browser-playwright/src/index.ts` with:

```typescript
/**
 * @koi/browser-playwright — Playwright implementation of BrowserDriver.
 *
 * L2 driver package. Depends on:
 *   - @koi/core        (L0)   types + error factories
 *   - @koi/browser-a11y (L0u)  parseAriaYaml / VALID_ROLES / translatePlaywrightError
 *   - playwright        (ext)  Browser / BrowserContext / Page / chromium.connectOverCDP
 *
 * A11y serialization + error translation live in @koi/browser-a11y — import
 * those symbols from there directly, not from this package.
 *
 * Use with @koi/tool-browser to wire the 20 BrowserDriver methods as Koi tools.
 */

export type { DetectedBrowser } from "./browser-detection.js";
export { detectInstalledBrowsers } from "./browser-detection.js";

export type { PlaywrightDriverConfig } from "./playwright-browser-driver.js";
export { createPlaywrightBrowserDriver, STEALTH_INIT_SCRIPT } from "./playwright-browser-driver.js";
```

- [ ] **Step 4: Run the api-surface test to verify it passes**

Run: `bun test packages/drivers/browser-playwright/src/__tests__/api-surface.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Run the full test suite**

Run: `bun test --cwd packages/drivers/browser-playwright`
Expected: all passing — browser-detection + playwright-browser-driver + api-surface.

- [ ] **Step 6: Build**

Run: `bun run --cwd packages/drivers/browser-playwright build`
Inspect: `cat packages/drivers/browser-playwright/dist/index.d.ts` — must contain `createPlaywrightBrowserDriver`, `detectInstalledBrowsers`, `STEALTH_INIT_SCRIPT`. Must NOT contain `parseAriaYaml`, `serializeA11yTree`, `translatePlaywrightError` (those live in `@koi/browser-a11y`).

- [ ] **Step 7: Commit**

```bash
git add packages/drivers/browser-playwright/src/index.ts packages/drivers/browser-playwright/src/__tests__/api-surface.test.ts
git commit -m "feat(browser-playwright): wire public API (driver + detection only; a11y exports moved to @koi/browser-a11y)"
```

---

## Task 5: Add `wsEndpoint` transport option

The one functional change vs v1: a new `wsEndpoint` field on `PlaywrightDriverConfig` that, when set, causes the driver to call `chromium.connectOverCDP({ wsEndpoint })` with a user-supplied loopback WebSocket URL. Needed for the future `@koi/browser-ext` driver (P5): extension-injected sessions expose a local WS bridge for Playwright to connect to.

**Semantics:**
- `wsEndpoint` takes **precedence** over `cdpEndpoint` if both are set. `cdpEndpoint` accepts `http://...` and calls `chromium.connectOverCDP(endpoint, {...})` with a string. `wsEndpoint` accepts `ws://...` and calls the same method with `{ wsEndpoint }` as an options object. They are mutually exclusive: if both are provided, `wsEndpoint` wins and the driver logs a warning once.
- Stealth / userDataDir / launch options are ignored when `wsEndpoint` is set (same rule as `cdpEndpoint`).
- When neither `browser`, `cdpEndpoint`, nor `wsEndpoint` is set, the driver launches its own Chromium (unchanged v1 path).

**Files:**
- Modify: `packages/drivers/browser-playwright/src/playwright-browser-driver.ts`
- Create: `packages/drivers/browser-playwright/src/__tests__/ws-endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/drivers/browser-playwright/src/__tests__/ws-endpoint.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";

import type { Browser } from "playwright";
import { chromium } from "playwright";

import { createPlaywrightBrowserDriver } from "../playwright-browser-driver.js";

describe("createPlaywrightBrowserDriver with wsEndpoint", () => {
  test("wsEndpoint calls chromium.connectOverCDP with { wsEndpoint }", async () => {
    const fakeBrowser = {
      contexts: () => [],
      newContext: async () => ({
        pages: () => [],
        newPage: async () => ({ url: () => "about:blank" }),
        close: async () => {},
      }),
      close: async () => {},
    } as unknown as Browser;

    const connectSpy = mock(async () => fakeBrowser);
    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      connectSpy as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/devtools/browser/abcd",
      });
      // Any operation forces the lazy browser init.
      await driver.tabList();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      const firstArg = connectSpy.mock.calls[0]?.[0];
      expect(firstArg).toEqual({ wsEndpoint: "ws://127.0.0.1:45678/devtools/browser/abcd" });

      await driver.dispose();
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });

  test("wsEndpoint takes precedence over cdpEndpoint when both are set", async () => {
    const fakeBrowser = {
      contexts: () => [],
      newContext: async () => ({
        pages: () => [],
        newPage: async () => ({ url: () => "about:blank" }),
        close: async () => {},
      }),
      close: async () => {},
    } as unknown as Browser;

    const connectSpy = mock(async () => fakeBrowser);
    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      connectSpy as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/x",
        cdpEndpoint: "http://localhost:9222", // should be ignored in favor of wsEndpoint
      });
      await driver.tabList();
      await driver.dispose();

      const firstArg = connectSpy.mock.calls[0]?.[0];
      expect(firstArg).toEqual({ wsEndpoint: "ws://127.0.0.1:45678/x" });
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/drivers/browser-playwright/src/__tests__/ws-endpoint.test.ts`
Expected: FAIL — `wsEndpoint` is not a recognized option; either a TS error at `createPlaywrightBrowserDriver({ wsEndpoint: ... })` or (if the test runner masks TS errors) a runtime failure because the driver launches its own Chromium and `tabList` succeeds for other reasons.

- [ ] **Step 3: Extend `PlaywrightDriverConfig`**

Open `packages/drivers/browser-playwright/src/playwright-browser-driver.ts`. Find the `export interface PlaywrightDriverConfig` declaration (v1 line ~72). Add the new field just below `cdpEndpoint`:

Before (v1 excerpt):
```typescript
  /** Connect to an existing Chrome via CDP. Overrides browser launch. */
  readonly cdpEndpoint?: string;
  /** Run headless (default: true). Ignored when `browser` or `cdpEndpoint` is provided. */
```

After:
```typescript
  /** Connect to an existing Chrome via CDP HTTP endpoint (e.g. http://localhost:9222). */
  readonly cdpEndpoint?: string;
  /**
   * Connect to a CDP WebSocket endpoint (e.g. ws://127.0.0.1:<port>/...). When set,
   * takes precedence over `cdpEndpoint`. Used by `@koi/browser-ext` to connect via a
   * loopback WebSocket bridged to a Chrome extension's chrome.debugger API through
   * a Koi native messaging host.
   */
  readonly wsEndpoint?: string;
  /** Run headless (default: true). Ignored when `browser`, `cdpEndpoint`, or `wsEndpoint` is provided. */
```

Also update `headless`'s later doc comment and any other comment that says `browser or cdpEndpoint` to say `browser, cdpEndpoint, or wsEndpoint` to keep the doc consistent. Specifically:
- The `launchTimeout` field's comment.
- The `stealth` field's comment at line ~86 ("Ignored when `browser` or `cdpEndpoint` is provided").
- Any line using `ownsLifecycle = !config.browser && !config.cdpEndpoint` — change to `!config.browser && !config.cdpEndpoint && !config.wsEndpoint`.
- The `userDataDir` guard at line ~360 similar to ownsLifecycle.
- The stealth guard at line ~385 similar to ownsLifecycle.

Use grep to locate:
```bash
grep -n '!config\.cdpEndpoint\|cdpEndpoint`' packages/drivers/browser-playwright/src/playwright-browser-driver.ts
```
Apply the `&& !config.wsEndpoint` addition and the doc updates for each match.

- [ ] **Step 4: Extend the connect path**

Find the block around line 322 that calls `chromium.connectOverCDP(config.cdpEndpoint, {...})`:

```typescript
if (config.cdpEndpoint) {
  return chromium.connectOverCDP(config.cdpEndpoint, {
    timeout: config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });
}
```

Replace with a `wsEndpoint`-first check:

```typescript
if (config.wsEndpoint) {
  return chromium.connectOverCDP({
    wsEndpoint: config.wsEndpoint,
    timeout: config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });
}
if (config.cdpEndpoint) {
  return chromium.connectOverCDP(config.cdpEndpoint, {
    timeout: config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });
}
```

Note the shape difference: `connectOverCDP` accepts either a string (HTTP endpoint) or an options object `{ wsEndpoint, ... }`. Playwright's type signature overloads both.

Then add a one-time warning when both are set. Near the top of the function that initializes the browser (or just before the connect path), add:

```typescript
if (config.wsEndpoint && config.cdpEndpoint) {
  // eslint-disable-next-line no-console
  console.warn(
    "[@koi/browser-playwright] Both wsEndpoint and cdpEndpoint were provided; wsEndpoint takes precedence.",
  );
}
```

(Biome may flag the eslint comment — if so, drop the comment; the `console.warn` is intentional.)

- [ ] **Step 5: Run the new test to verify it passes**

Run: `bun test packages/drivers/browser-playwright/src/__tests__/ws-endpoint.test.ts`
Expected: both tests PASS. If `connectOverCDP` mocking fails because Playwright's actual implementation details reject the fake browser, simplify the fake to whatever `tabList()` minimally needs. The core assertion — that `chromium.connectOverCDP` was called with `{ wsEndpoint: "..." }` — must still hold.

If the mock approach is brittle, an acceptable alternative is to verify via a Playwright-specific debug callback or by stubbing at a lower level. Do NOT weaken the assertion.

- [ ] **Step 6: Run the full test suite to verify no regression**

Run: `bun test --cwd packages/drivers/browser-playwright`
Expected: all tests PASS. `playwright-browser-driver.test.ts` (1325 LOC of ported tests) must stay green — the new field is opt-in and doesn't touch the existing launch / cdpEndpoint code paths.

- [ ] **Step 7: Typecheck + lint**

Run: `bun run --cwd packages/drivers/browser-playwright typecheck && bun run --cwd packages/drivers/browser-playwright lint`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/drivers/browser-playwright/src/playwright-browser-driver.ts packages/drivers/browser-playwright/src/__tests__/ws-endpoint.test.ts
git commit -m "feat(browser-playwright): add wsEndpoint transport option for browser-ext bridging"
```

---

## Task 6: Register `@koi/browser-playwright` as an L2 package

**Files:**
- Modify: `scripts/layers.ts` (the `L2_PACKAGES` Set)

- [ ] **Step 1: Open `scripts/layers.ts`**

Confirm the `L2_PACKAGES` set contains alphabetically-ordered strings. Find where `@koi/browser-playwright` should go (alphabetically — between `@koi/audit-sink-sqlite` and `@koi/checkpoint`, or similar depending on the current list).

- [ ] **Step 2: Insert `"@koi/browser-playwright"` alphabetically**

Use the Edit tool to insert the new entry in the correct position. Example (verify the surrounding entries are really what's there):

```typescript
  "@koi/audit-sink-sqlite",
  "@koi/browser-playwright",
  "@koi/checkpoint",
```

- [ ] **Step 3: Run the layer check**

Run: `bun run check:layers`
Expected: exit 0. The layer checker should classify `@koi/browser-playwright` as L2 and verify its deps: `@koi/core` (L0) + `@koi/browser-a11y` (L0u) + `playwright` (external). No L1 dep, no peer L2 dep.

- [ ] **Step 4: Typecheck + lint the whole monorepo**

Run: `bun run typecheck && bun run lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/layers.ts
git commit -m "feat(browser-playwright): register @koi/browser-playwright as L2 package"
```

---

## Task 7: Write `docs/L2/browser-playwright.md`

Port v1's doc with updates for the v2 imports and the new `wsEndpoint` option.

**Files:**
- Create: `docs/L2/browser-playwright.md`

- [ ] **Step 1: Port v1's doc**

```bash
cp archive/v1/docs/L2/browser-playwright.md docs/L2/browser-playwright.md
```

If v1 didn't have that doc (the archive may not include L2 docs), skip the copy and write from scratch in the next step.

- [ ] **Step 2: Verify / write the doc**

Open `docs/L2/browser-playwright.md`. It must include these sections (add them if they aren't in the v1 port):

- **Why It Exists** — briefly: LLM agents can't see pixels; this driver translates CDP into a 20-method `BrowserDriver` contract.
- **Public API** — with a note that a11y helpers (`parseAriaYaml`, `VALID_ROLES`, `translatePlaywrightError`) are imported from `@koi/browser-a11y`, NOT from this package.
- **Transport options** — a new or expanded section covering the three ways to get a Playwright `Browser`:
  - `browser` (pre-built Browser passed in — caller owns lifecycle).
  - `cdpEndpoint` (HTTP endpoint to an existing Chrome launched with `--remote-debugging-port`).
  - **`wsEndpoint`** (CDP WebSocket endpoint — **new in v2**, used by `@koi/browser-ext` to connect via a loopback WS bridged to a Chrome extension through a Koi native messaging host).
  - Default: launch own Chromium.
- **Layer Compliance** — shows the deps graph with `@koi/browser-a11y` pulled in explicitly.

Aim for ~100–200 lines total. Follow the structure of `docs/L2/browser-a11y.md` as a pattern if helpful.

- [ ] **Step 3: Commit**

```bash
git add docs/L2/browser-playwright.md
git commit -m "docs(browser-playwright): port L2 doc with wsEndpoint + browser-a11y notes"
```

---

## Task 8: Final gate — monorepo CI + PR

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: exit 0.

- [ ] **Step 3: Layer check**

Run: `bun run check:layers`
Expected: exit 0. `@koi/browser-playwright` classified L2.

- [ ] **Step 4: Full test**

Run: `bun run test`
Expected: exit 0. The browser-playwright tests join the existing suite additively.

- [ ] **Step 5: Duplicate check**

Run: `bun run check:duplicates`
Expected: exit 0. Clones inside the v1 port are pre-existing; `archive/v1/` is excluded from the scanner. If any new cross-package clone fires (e.g. browser-playwright's driver duplicating browser-a11y content), stop and surface it — the rewire should have eliminated every duplicate, not preserved any.

- [ ] **Step 6: Unused-exports check**

Run: `bun run check:unused`
Expected: exit 0. All three public exports (`createPlaywrightBrowserDriver`, `detectInstalledBrowsers`, `STEALTH_INIT_SCRIPT`) are referenced by the api-surface test and will be referenced by P5 downstream. If unused-check complains about `STEALTH_INIT_SCRIPT` (it's only used by consumers), add it to the check's allowlist rather than deleting it.

- [ ] **Step 7: Push the branch + open the PR**

If P1 has merged to main by this point, first rebase:
```bash
git fetch origin
git rebase origin/main
```

Then push:
```bash
git push --force-with-lease fork worktree-issue-1609-browser-ext
```
(`--force-with-lease` is correct here because the branch was rebased, not because prior commits were rewritten destructively.)

If P1 is still open, the P2 commits will be stacked on the P1 PR. Two options:
- **A. Stack the PR**: open P2 targeting the P1 branch as base, using `gh pr create --base worktree-issue-1609-browser-ext --head <P2-branch>` if P2 was developed on a separate branch. Reviewers can merge P1 first, then P2 automatically re-targets main.
- **B. Wait for P1**: hold P2 local until P1 merges, then rebase and open normally.

Recommend A for velocity. Title: `feat(browser-playwright): port L2 driver with wsEndpoint transport (P2 of #1609)`.

---

## Review checklist (self-check before handoff)

- [ ] **Spec coverage**: §5.1 port lands at correct path. §6.7 wsEndpoint option added. §10.1 tests ported (browser-detection + playwright-browser-driver + api-surface + ws-endpoint).
- [ ] **No silent weakening**: no `@ts-expect-error`, no `as any`, no new Biome-ignore lines outside the documented `eslint-disable` for the intentional `console.warn`.
- [ ] **Deferred items**: runtime wiring is P7; no `@koi/runtime` changes in this plan.
- [ ] **Type consistency**: `PlaywrightDriverConfig` — single interface, `wsEndpoint` added once, not duplicated across multiple declarations. `createPlaywrightBrowserDriver` signature unchanged (takes `PlaywrightDriverConfig`).
- [ ] **Placeholder scan**: no TBD / TODO / "handle edge cases" in the plan itself.
