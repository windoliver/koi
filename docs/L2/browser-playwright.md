# @koi/browser-playwright — Playwright Browser Driver

Gives Koi agents the ability to see and interact with web pages. Implements the `BrowserDriver` interface from `@koi/core` using Playwright, converting live web pages into compact accessibility-tree snapshots that an LLM can reason about, and translating LLM tool calls (click, type, navigate) into real browser actions.

---

## Why It Exists

LLM agents can't see pixels — they work with text. To automate a browser, the agent needs two things: (1) a text representation of what's on screen, and (2) a way to act on specific elements by reference.

Without this package, you'd hand-write Playwright orchestration, accessibility tree serialization, element reference tracking, error normalization, and timeout management. This package encapsulates all of that behind the `BrowserDriver` contract so any Koi engine adapter can drive a browser without knowing Playwright exists.

---

## What This Enables

### The Agent-Browser Loop

```
                    ┌──────────────────────────────────────────────┐
                    │               KOI AGENT                      │
                    │                                              │
                    │  "I need to fill out the login form.         │
                    │   Let me snapshot the page first."           │
                    │                                              │
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │         TOOL: browser_snapshot                │
                    │                                              │
                    │  Returns compact accessibility tree:         │
                    │                                              │
                    │  WebArea "Acme Login"                        │
                    │    heading "Sign In" [level=1]               │
                    │    textbox "Email" [required, ref=e1]        │
                    │    textbox "Password" [required, ref=e2]     │
                    │    button "Log In" [ref=e3]                  │
                    │    link "Forgot password?" [ref=e4]          │
                    │                                              │
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │               KOI AGENT                      │
                    │                                              │
                    │  "I see e1=Email, e2=Password, e3=Log In.    │
                    │   I'll type credentials then click Log In."  │
                    │                                              │
                    └──────────────┬───────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
     TOOL: browser_type   TOOL: browser_type   TOOL: browser_click
     ref=e1               ref=e2               ref=e3
     value="user@acme"    value="s3cret"
              │                    │                    │
              └────────────────────┼────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │         TOOL: browser_snapshot                │
                    │                                              │
                    │  WebArea "Acme Dashboard"                    │
                    │    heading "Welcome back!" [level=1]         │
                    │    nav "Main menu"                           │
                    │      link "Profile" [ref=e1]                 │
                    │      link "Settings" [ref=e2]                │
                    │      button "Log Out" [ref=e3]               │
                    │                                              │
                    │  (new snapshotId — old refs invalidated)     │
                    │                                              │
                    └──────────────────────────────────────────────┘
```

### End-to-End Data Flow

```
┌─────────┐     manifest.yaml      ┌──────────────┐
│  Agent   │ ───────────────────── │  @koi/engine  │
│ Assembly │  tools: [browser]     │   (L1)        │
└─────────┘                        └──────┬───────┘
                                          │ tool call
                                          ▼
                                   ┌──────────────┐      BrowserDriver       ┌──────────────────┐
                                   │ @koi/tool-   │ ──────interface──────── │ @koi/browser-     │
                                   │ browser (L2) │                         │ playwright (L2)   │
                                   │              │      Result<T,KoiError> │                   │
                                   │  20 tools    │ <────────────────────── │  Playwright API   │
                                   └──────────────┘                         └────────┬─────────┘
                                                                                     │
                                                                              ┌──────▼──────┐
                                                                              │  Chromium /  │
                                                                              │  Firefox /   │
                                                                              │  WebKit      │
                                                                              └─────────────┘
```

### Multi-Tab Agent Workflow

```
Agent: "Open three tabs and compare prices"

  Tab 1 (amazon.com)          Tab 2 (ebay.com)           Tab 3 (walmart.com)
  ┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
  │ WebArea "Amazon"  │      │ WebArea "eBay"    │      │ WebArea "Walmart" │
  │  heading "AirPods"│      │  heading "AirPods"│      │  heading "AirPods"│
  │  text "$179.00"   │      │  text "$165.00"   │      │  text "$172.00"   │
  │  button "Add to   │      │  button "Buy It   │      │  button "Add to   │
  │   Cart" [ref=e1]  │      │   Now" [ref=e1]   │      │   Cart" [ref=e1]  │
  └───────────────────┘      └───────────────────┘      └───────────────────┘
         │                          │                          │
         │  Each tab has its own    │  snapshotId + refs are   │
         │  independent snapshot    │  isolated per tab        │
         │  state                   │                          │
         └──────────────────────────┼──────────────────────────┘
                                    │
                                    ▼
                          Agent: "eBay has the best
                           price. Click Buy It Now
                           on Tab 2."
```

### Accessibility Tree Serialization

```
                        Real DOM                              Agent sees
  ┌──────────────────────────────────┐      ┌────────────────────────────────────┐
  │ <html>                           │      │                                    │
  │  <body>                          │      │ WebArea "My App"                   │
  │   <h1>My App</h1>               │  ──► │   heading "My App" [level=1]       │
  │   <nav>                          │      │   navigation "Main"                │
  │    <a href="/home">Home</a>      │      │     link "Home" [ref=e1]           │
  │    <a href="/about">About</a>    │      │     link "About" [ref=e2]          │
  │   </nav>                         │      │   main                             │
  │   <main>                         │      │     textbox "Search" [ref=e3]      │
  │    <input type="text"            │      │     button "Go" [ref=e4]           │
  │      placeholder="Search"/>      │      │     list                           │
  │    <button>Go</button>           │      │       listitem                     │
  │    <ul>                          │      │         link "Result 1" [ref=e5]   │
  │     <li><a>Result 1</a></li>     │      │       listitem                     │
  │     <li><a>Result 2</a></li>     │      │         link "Result 2" [ref=e6]   │
  │    </ul>                         │      │                                    │
  │   </main>                        │      │ (refs only on interactive elements │
  │  </body>                         │      │  — 21 ARIA roles tracked)          │
  │ </html>                          │      │                                    │
  └──────────────────────────────────┘      └────────────────────────────────────┘

                                              4,000 token budget (truncates
                                              gracefully at depth 8)
```

### Error Recovery Loop

```
Agent calls browser_click(ref=e3, snapshotId="old-abc")

  ┌──────────────────────┐
  │  Error: STALE_REF    │
  │                      │
  │  "Page navigated     │──► Agent: "My refs are stale.
  │   since snapshot.    │          Let me re-snapshot."
  │   Call snapshot to   │
  │   refresh."          │    ┌──────────────────────┐
  │                      │    │ browser_snapshot()    │
  └──────────────────────┘    │ → new snapshotId      │
                              │ → fresh refs (e1..eN) │
                              └──────────┬───────────┘
                                         │
                                         ▼
                              Agent retries with new ref
```

---

## Architecture

`@koi/browser-playwright` is an **L2 feature package** — it depends only on `@koi/core` (L0) for type contracts and `playwright` for browser automation.

```
┌─────────────────────────────────────────────────────┐
│  @koi/browser-playwright  (L2)                      │
│                                                     │
│  playwright-browser-driver.ts  ← BrowserDriver impl │
│  a11y-serializer.ts           ← tree → text + refs  │
│  browser-detection.ts         ← find system browsers │
│  error-translator.ts          ← Playwright → KoiErr │
│  index.ts                     ← public API surface   │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Dependencies                                       │
│                                                     │
│  @koi/core       (L0)   BrowserDriver, Result, etc. │
│  playwright      (ext)  chromium.launch(), Page API  │
└─────────────────────────────────────────────────────┘
```

### Module Responsibilities

```
┌────────────────────────────────────────────────────────────────────────┐
│                    @koi/browser-playwright                              │
│                                                                        │
│  ┌──────────────────────┐   ┌──────────────────────┐                  │
│  │ playwright-browser-  │   │  a11y-serializer     │                  │
│  │ driver               │   │                      │                  │
│  │                      │   │  serializeA11yTree() │                  │
│  │  createPlaywright-   │──►│  parseAriaYaml()     │                  │
│  │  BrowserDriver()     │   │                      │                  │
│  │                      │   │  DOM → compact text   │                  │
│  │  20 BrowserDriver    │   │  with [ref=eN] tags  │                  │
│  │  methods             │   └──────────────────────┘                  │
│  │                      │                                              │
│  │                      │   ┌──────────────────────┐                  │
│  │                      │──►│  error-translator    │                  │
│  │                      │   │                      │                  │
│  │                      │   │  Playwright errors →  │                  │
│  │                      │   │  typed KoiError with  │                  │
│  │                      │   │  LLM-friendly hints   │                  │
│  │                      │   └──────────────────────┘                  │
│  └──────────────────────┘                                              │
│                                                                        │
│  ┌──────────────────────┐                                              │
│  │  browser-detection   │   Detect Chromium browsers on disk           │
│  │  detectInstalled-    │   (macOS, Linux, Windows paths)              │
│  │  Browsers()          │   Falls back to Playwright bundled Chromium  │
│  └──────────────────────┘                                              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Ref Resolution Strategy

The driver uses a two-strategy approach to locate elements from snapshot refs:

```
Agent passes ref="e3"

  Strategy 1: aria-ref attribute (O(1) direct lookup)
  ┌────────────────────────────────────────────────────────┐
  │  page.locator('[aria-ref="e3"]')                       │
  │                                                        │
  │  Playwright 1.44+ injects aria-ref into snapshots.     │
  │  If present, this is a direct CSS selector — instant.  │
  └────────────────────────────┬───────────────────────────┘
                               │
                     found? ───┤──── yes → use it
                               │
                     no ────── │
                               ▼
  Strategy 2: getByRole + nth deduplication
  ┌────────────────────────────────────────────────────────┐
  │  refs["e3"] = { role: "button", name: "Submit", nth: 0 }│
  │                                                        │
  │  page.getByRole("button", { name: "Submit" }).nth(0)   │
  │                                                        │
  │  nth handles duplicate names: if page has two           │
  │  buttons named "Submit", they get ref=e5 (nth=0)       │
  │  and ref=e6 (nth=1)                                     │
  └────────────────────────────────────────────────────────┘
```

---

## Per-Tab State Isolation

```
Driver State
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  browser: Browser (lazy, one instance)                        │
│  context: BrowserContext (lazy, one instance)                  │
│                                                               │
│  tabs: Map<tabId, Page>                                       │
│  ┌─────────────────┬─────────────────┬─────────────────┐     │
│  │ Tab "t1"        │ Tab "t2"        │ Tab "t3"        │     │
│  │                 │                 │                 │     │
│  │ snapshotId: "a" │ snapshotId: "b" │ snapshotId: "c" │     │
│  │ refs: {e1..e4}  │ refs: {e1..e6}  │ refs: {e1..e2}  │     │
│  │ refCounter: 5   │ refCounter: 7   │ refCounter: 3   │     │
│  │ console: [...]  │ console: [...]  │ console: [...]  │     │
│  │                 │                 │                 │     │
│  │ Switching tabs  │ does NOT        │ invalidate      │     │
│  │ other tabs'     │ snapshot state  │                 │     │
│  └─────────────────┴─────────────────┴─────────────────┘     │
│                                                               │
│  activeTabId: "t2"  (currently focused)                       │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## Timeout Architecture

Every operation has explicit min/max bounds. Exceeding max fails at validation time — not at runtime.

```
Operation          Default    Max       On exceed
─────────────────────────────────────────────────────
navigate           15,000ms   60,000ms  VALIDATION error
click/hover/type    3,000ms   10,000ms  VALIDATION error
wait                5,000ms   30,000ms  VALIDATION error
evaluate            5,000ms   10,000ms  VALIDATION error
launch             30,000ms      —      (config only)
─────────────────────────────────────────────────────

Timeline:
  0ms              3s          10s
   │───── click ───│            │
   │    (default)  │            │
   │               │            │
   │───── click ───────────────│
   │    (custom 10s max)       │
   │                            │
   │─ click(15s) → VALIDATION error (before execution)
```

---

## Error Taxonomy

Playwright throws generic errors. This package translates them into 9 typed `KoiError` codes with actionable LLM guidance:

```
Playwright Exception                    KoiError Code     Agent Guidance
──────────────────────────────────────────────────────────────────────────
TimeoutError                            TIMEOUT           "Try browser_wait, increase
                                                           timeout, or re-snapshot"

"Element is not attached to DOM"        STALE_REF         "Call browser_snapshot to
"Target closed" (detached)                                 refresh refs"

"Execution context was destroyed"       STALE_REF         "Page navigated — re-snapshot"

"net::ERR_NAME_NOT_RESOLVED"            EXTERNAL          "Check URL is reachable"
"net::ERR_CONNECTION_REFUSED"

CORS / security policy block            PERMISSION        "Blocked by browser security"

Page/target closed unexpectedly         INTERNAL          "Browser page closed"

WebSocket disconnected                  INTERNAL          "Browser connection lost"

JavaScript evaluation error             EXTERNAL          "Page JS threw an error"

Invalid CSS selector                    VALIDATION        "Fix selector syntax"

Unknown error                           INTERNAL          Original cause preserved
```

---

## DNS Rebinding Protection

Enabled by default (`blockPrivateAddresses: true`). Prevents SSRF attacks through the browser.

```
Agent: navigate("http://internal-api.local/admin")

  ┌─────────────────────────┐
  │ DNS lookup:              │
  │ internal-api.local       │
  │ → 192.168.1.50          │
  └────────────┬────────────┘
               │
               ▼
  ┌─────────────────────────┐
  │ isPrivateIp check:      │
  │ 192.168.x.x → PRIVATE  │──► PERMISSION error
  │                         │    "Navigation to private
  │ Blocked ranges:         │     IP blocked"
  │  10.0.0.0/8             │
  │  172.16.0.0/12          │
  │  192.168.0.0/16         │
  │  127.0.0.0/8            │
  │  ::1, fc00::/7          │
  └─────────────────────────┘
```

---

## Stealth Mode

Optional bot-detection evasion (`stealth: true`):

```
Standard Playwright                     With stealth: true
─────────────────────                   ──────────────────
navigator.webdriver = true              navigator.webdriver = undefined
navigator.plugins.length = 0           navigator.plugins.length = 3 (mocked)
navigator.languages = []               navigator.languages = ["en-US", "en"]
window.chrome = undefined               window.chrome = { runtime: {} }
                                        + Chromium flags:
                                          --disable-blink-features=
                                            AutomationControlled
```

---

## BrowserDriver Methods (20 operations)

| Method | Purpose | Returns |
|--------|---------|---------|
| `snapshot(options?)` | Capture a11y tree with refs | `SnapshotResult` |
| `navigate(url, options?)` | Load URL | `NavigateResult` |
| `click(ref, options?)` | Click element by ref | `void` |
| `hover(ref, options?)` | Hover over element | `void` |
| `press(key, options?)` | Press keyboard key | `void` |
| `type(ref, value, options?)` | Fill textbox | `void` |
| `select(ref, value, options?)` | Select dropdown option | `void` |
| `fillForm(fields, options?)` | Batch fill (atomic) | `void` |
| `scroll(options)` | Scroll page/element | `void` |
| `screenshot(options?)` | Capture as base64 | `ScreenshotResult` |
| `wait(options)` | Wait for condition | `void` |
| `tabNew(options?)` | Open new tab | `TabInfo` |
| `tabClose(tabId?)` | Close tab | `void` |
| `tabFocus(tabId)` | Switch to tab | `TabInfo` |
| `tabList()` | List all tabs | `readonly TabInfo[]` |
| `console(options?)` | Get console logs | `ConsoleResult` |
| `evaluate(script, options?)` | Run JS in page | `EvaluateResult` |
| `upload(ref, files, options?)` | Upload file | `void` |
| `traceStart(options?)` | Start recording | `void` |
| `traceStop()` | Stop + export .zip | `TraceResult` |

All methods return `Promise<Result<T, KoiError>>` — no thrown exceptions.

---

## Atomic Form Fill

`fillForm` validates all refs before mutating any field:

```
fillForm([
  { ref: "e1", value: "Alice" },       Pass 1: VALIDATE
  { ref: "e2", value: "alice@co" },     ┌─────────────────┐
  { ref: "e3", value: "s3cret" },       │ resolve ref e1 ✓ │
  { ref: "e99", value: "bad" },         │ resolve ref e2 ✓ │
])                                       │ resolve ref e3 ✓ │
                                         │ resolve ref e99 ✗│──► NOT_FOUND error
                                         └─────────────────┘    (no fields touched)

fillForm([                               Pass 1: VALIDATE
  { ref: "e1", value: "Alice" },         ┌─────────────────┐
  { ref: "e2", value: "alice@co" },      │ resolve all ✓   │
  { ref: "e3", value: "s3cret" },        └────────┬────────┘
])                                                 │
                                         Pass 2: FILL
                                         ┌─────────────────┐
                                         │ type e1="Alice"  │
                                         │ type e2="alice@" │
                                         │ type e3="s3cret" │
                                         └─────────────────┘
                                         All-or-nothing guarantee
```

---

## Initialization Flow

Lazy initialization with promise caching prevents race conditions:

```
First tool call                          Subsequent calls
─────────────────                        ────────────────

ensureBrowser()                          ensureBrowser()
  │                                        │
  ├─ browserPromise exists? NO             ├─ browserPromise exists? YES
  │                                        │
  ├─ browserPromise = chromium.launch()    ├─ return cached promise
  │                                        │
  ├─ await browserPromise                  └─ (resolves immediately)
  │
  └─ return browser


Two concurrent calls (race-safe):

  Call A: ensureBrowser()  ──┐
                             ├──► same promise object
  Call B: ensureBrowser()  ──┘    (only one launch)
```

---

## Browser Detection

Finds Chromium-family browsers before falling back to Playwright's bundled one:

```
detectInstalledBrowsers()

  macOS:
    /Applications/Google Chrome.app/...          ✓ found
    /Applications/Brave Browser.app/...          ✗ not found
    /Applications/Microsoft Edge.app/...         ✓ found
    /Applications/Chromium.app/...               ✗ not found
    /Applications/Arc.app/...                    ✗ not found
    playwright chromium.executablePath()          ✓ fallback

  Returns: [
    { name: "Google Chrome",   source: "system" },
    { name: "Microsoft Edge",  source: "system" },
    { name: "Chromium",        source: "playwright-bundled" }
  ]
```

---

## Console Buffer

Per-tab FIFO buffer captures page console output for agent debugging:

```
Page console.log/warn/error output
  │
  ▼
┌───────────────────────────────┐
│ Tab "t1" console buffer       │
│ (capacity: 200 entries FIFO)  │
│                               │
│ [0] { level: "log",          │
│       text: "App loaded" }    │
│ [1] { level: "warn",         │
│       text: "Deprecated API" }│
│ [2] { level: "error",        │
│       text: "404 /api/users" }│
│ ...                           │
│ [199] (oldest evicted)        │
└───────────────────────────────┘

browser_console(limit=10, level="error")
  → returns last 10 error-level entries
```

---

## Examples

### Basic Usage

```typescript
import { createPlaywrightBrowserDriver } from "@koi/browser-playwright";

const driver = createPlaywrightBrowserDriver({
  headless: true,
  stealth: true,
});

// Navigate
const navResult = await driver.navigate("https://example.com");

// Snapshot the page
const snapResult = await driver.snapshot();
if (snapResult.ok) {
  console.log(snapResult.value.text);
  // WebArea "Example Domain"
  //   heading "Example Domain" [level=1]
  //   link "More information..." [ref=e1]
}

// Click a link
await driver.click("e1", { snapshotId: snapResult.value.snapshotId });

// Cleanup
await driver.dispose();
```

### With Custom Browser

```typescript
import { createPlaywrightBrowserDriver, detectInstalledBrowsers } from "@koi/browser-playwright";

const browsers = await detectInstalledBrowsers();
const chrome = browsers.find((b) => b.name === "Google Chrome");

const driver = createPlaywrightBrowserDriver({
  // Use system Chrome instead of bundled Chromium
  ...(chrome ? { browser: undefined } : {}),
  headless: false,
  stealth: true,
  blockPrivateAddresses: true,
});
```

### Connect to Existing Chrome via CDP

```typescript
const driver = createPlaywrightBrowserDriver({
  cdpEndpoint: "http://localhost:9222",
});

// Reuse an already-running Chrome instance
// (e.g., launched with --remote-debugging-port=9222)
```

### Multi-Tab Workflow

```typescript
const driver = createPlaywrightBrowserDriver();

await driver.navigate("https://site-a.com");
const tab2 = await driver.tabNew({ url: "https://site-b.com" });
const tab3 = await driver.tabNew({ url: "https://site-c.com" });

// Snapshot each tab independently
await driver.tabFocus("t1");
const snap1 = await driver.snapshot();

await driver.tabFocus(tab2.value.id);
const snap2 = await driver.snapshot();

// Each snapshot has its own refs — no cross-tab interference
const tabs = await driver.tabList();
// [{ id: "t1", title: "Site A" }, { id: "t2", title: "Site B" }, ...]

await driver.dispose();
```

---

## Integration with @koi/tool-browser

This package provides the `BrowserDriver` implementation. The companion `@koi/tool-browser` package wraps it as Koi `Tool` components:

```
manifest.yaml:
  tools:
    - browser

                    ┌──────────────────┐
                    │  @koi/tool-browser│
                    │  (L2)            │
                    │                  │     createPlaywright-
                    │  ComponentProvider│────BrowserDriver()──────►┌──────────────┐
                    │                  │                           │  @koi/browser-│
                    │  20 Tool objects  │◄──BrowserDriver contract──│  playwright  │
                    │  (click, type,   │                           │  (L2)        │
                    │   navigate, etc) │                           └──────────────┘
                    └──────────────────┘
                           │
                           │ attach() → Map<string, Tool>
                           ▼
                    ┌──────────────────┐
                    │  Agent (entity)   │
                    │                  │
                    │  tool:browser_*   │  ← 20 tools registered
                    │  browser:driver   │  ← driver component
                    └──────────────────┘
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    BrowserDriver, Result, KoiError — types only         │
                                                         │
L2  @koi/browser-playwright ◄────────────────────────────┘
    imports from L0 only (+ playwright external dep)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ never imports L0u packages
    ✓ playwright is the sole external dependency
```

**Dev-only:** `@koi/test-utils` used in tests but not a runtime import.
