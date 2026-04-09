# @koi/tool-browser — Browser Tool Provider

Gives Koi agents the ability to control a web browser through a pluggable `BrowserDriver`. Attaches `browser_*` tools to the agent component map, enforces trust-tier access control, and injects a `SkillComponent` that teaches agents the snapshot-first workflow, form filling, wait strategies, tab management, and token-cost awareness.

---

## Why It Exists

Browser automation with LLMs breaks in predictable ways unless the agent follows a strict loop: snapshot the page, reference elements by their `[ref=eN]` markers, act, then re-snapshot. Without explicit behavioral guidance the agent tends to:

- Act on stale element references, causing `STALE_REF` errors
- Use `browser_screenshot` (base64 images, ~100× more tokens) when `browser_snapshot` would suffice
- Fill fields one-at-a-time instead of using `browser_fill_form` for atomic multi-field submission
- Open tabs without closing them, leaking browser resources
- Use `browser_evaluate` (JavaScript injection) without realizing it requires elevated `promoted` trust tier

This package solves both sides of the problem — it wires the tools with correct trust-tier defaults, and it wires the behavioral instructions as a `SkillComponent` that travels with the tools through the ECS component map.

---

## What This Enables

### The Snapshot-Act-Re-snapshot Loop

```
                    ┌──────────────────────────────────────────────┐
                    │               KOI AGENT                      │
                    │                                              │
                    │  "I need to log in. Let me see the page."    │
                    │                                              │
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │  STEP 1: browser_snapshot                    │
                    │                                              │
                    │  Output:                                     │
                    │    snapshotId: "snap-tab-1-3"                │
                    │    elements:                                 │
                    │      textbox "Email"    [ref=e1]             │
                    │      textbox "Password" [ref=e2]             │
                    │      button  "Log In"   [ref=e3]             │
                    │                                              │
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │  STEP 2: browser_fill_form                   │
                    │                                              │
                    │  Input:                                      │
                    │    snapshotId: "snap-tab-1-3"  ← required   │
                    │    fields: [                                 │
                    │      { ref: "e1", value: "me@example.com" } │
                    │      { ref: "e2", value: "••••••" }         │
                    │    ]                                         │
                    │                                              │
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │  STEP 3: browser_click                       │
                    │                                              │
                    │  Input: { snapshotId: "snap-tab-1-3",        │
                    │           ref: "e3" }                        │
                    │                                              │
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │  STEP 4: browser_snapshot (re-snapshot)      │
                    │                                              │
                    │  Output: new snapshotId + dashboard elements │
                    │  → DOM changed: always re-snapshot after act │
                    │                                              │
                    └──────────────────────────────────────────────┘
```

---

## Installation

```bash
bun add --cwd packages/my-agent @koi/tool-browser
bun add --cwd packages/my-agent @koi/browser-playwright  # for real browsers
```

---

## Quick Start

```typescript
import { createKoi } from "@koi/engine";
import { createBrowserProvider } from "@koi/tool-browser";
import { createPlaywrightBrowserDriver } from "@koi/browser-playwright";

const browserProvider = createBrowserProvider({
  backend: createPlaywrightBrowserDriver({ headless: true }),
});

const runtime = await createKoi({
  manifest: { name: "my-agent", version: "0.0.1", model: { name: "claude-haiku-4-5-20251001" } },
  adapter,
  providers: [browserProvider],
});
```

The agent now has all 12 default `browser_*` tools in its tool list and `skill:browser` in its component map.

---

## Configuration

```typescript
createBrowserProvider({
  backend,        // required — BrowserDriver implementation
  operations,     // optional — subset of operations (default: OPERATIONS, excludes "evaluate")
  prefix,         // optional — tool name prefix (default: "browser")
  scope,          // optional — ScopeChecker for URL-level access control
  trustTier,      // optional — default trust tier (default: "verified")
})
```

### Enable browser_evaluate (JavaScript injection)

`browser_evaluate` is excluded from the default operations because it runs arbitrary JavaScript and requires `promoted` trust tier. Opt in explicitly:

```typescript
import { OPERATIONS } from "@koi/tool-browser";

createBrowserProvider({
  backend,
  operations: [...OPERATIONS, "evaluate"],
  // evaluate is automatically pinned to "promoted" regardless of trustTier config
})
```

### Custom prefix

```typescript
createBrowserProvider({ backend, prefix: "web" })
// Registers: web_snapshot, web_navigate, web_click, web_type, ...
```

### URL scope restrictions

```typescript
import { createScope } from "@koi/scope";

createBrowserProvider({
  backend,
  scope: createScope({
    allow: ["https://app.example.com/**"],
    deny: ["https://app.example.com/admin/**"],
  }),
})
```

---

## Default Operations

| Operation | Tool name | Trust tier | Purpose |
|-----------|-----------|------------|---------|
| snapshot | browser_snapshot | verified | Capture accessibility tree + element refs |
| navigate | browser_navigate | verified | Navigate to a URL |
| click | browser_click | verified | Click an element by ref |
| type | browser_type | verified | Type text into a field |
| fill_form | browser_fill_form | verified | Fill multiple fields atomically |
| select | browser_select | verified | Choose a dropdown option |
| scroll | browser_scroll | verified | Scroll the page |
| wait | browser_wait | verified | Wait for element/timeout |
| tab_new | browser_tab_new | verified | Open a new tab |
| tab_focus | browser_tab_focus | verified | Switch to a tab |
| tab_close | browser_tab_close | verified | Close a tab |
| screenshot | browser_screenshot | verified | Capture base64 screenshot |
| *(opt-in)* | browser_evaluate | **promoted** | Execute JavaScript |

---

## SkillComponent

`createBrowserProvider` automatically attaches a `SkillComponent` to the agent under the token `skill:browser`. This component is pure ECS data — a structured object the middleware stack and orchestrator can read to inject behavioral guidance into the system prompt or pass to other components.

### Relationship to BROWSER_SYSTEM_PROMPT

`BROWSER_SYSTEM_PROMPT` is an older raw string constant used by system-prompt middleware. `FS_SKILL` / `BROWSER_SKILL` are the ECS-native replacements. They carry the same guidance in a structured `SkillComponent` that can be queried, filtered by tag, and composed without string concatenation.

### What the skill teaches

The `BROWSER_SKILL_CONTENT` markdown covers five areas:

| Area | Guidance |
|------|----------|
| **Snapshot loop** | Always snapshot before acting; always re-snapshot after DOM changes; pass `snapshotId` to every action |
| **Form filling** | `browser_fill_form` for multi-field forms; `browser_type` for single fields; `browser_select` for dropdowns |
| **Wait strategies** | `browser_wait` with `selector` preferred over fixed timeouts; re-snapshot after navigate |
| **Tab management** | `browser_tab_focus` before acting on a tab; always close tabs you open |
| **Trust tier awareness** | `browser_evaluate` is `promoted` only; prefer `browser_snapshot` over `browser_screenshot` (100× cheaper) |

The skill also includes an **error code quick reference** table (`STALE_REF`, `TIMEOUT`, `NOT_FOUND`, `EXTERNAL`, `INTERNAL`, `PERMISSION`, `VALIDATION`) with recommended recovery actions.

### Accessing the skill

```typescript
import type { SkillComponent } from "@koi/core";
import { skillToken } from "@koi/core";
import { BROWSER_SKILL_NAME } from "@koi/tool-browser";

const skill = runtime.agent.component<SkillComponent>(skillToken(BROWSER_SKILL_NAME));
// skill.name     → "browser"
// skill.content  → markdown guidance string
// skill.tags     → ["browser", "best-practices"]
```

### Using standalone

The `BROWSER_SKILL` constant is exported so you can attach it to a custom provider:

```typescript
import { BROWSER_SKILL, BROWSER_SKILL_NAME } from "@koi/tool-browser";
import { skillToken } from "@koi/core";

customTools: () => [[skillToken(BROWSER_SKILL_NAME) as string, BROWSER_SKILL]],
```

---

## URL Policy: isUrlAllowed Callback

In v2, URL security is injected via a callback rather than a scoped driver wrapper (which required an `@koi/scope` L2→L2 dependency). Pass `isUrlAllowed` to `createBrowserProvider` to gate `browser_navigate` and `browser_tab_new`:

```typescript
createBrowserProvider({
  backend,
  isUrlAllowed: (url) => {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:") return false;
    if (hostname === "localhost" || hostname.startsWith("192.168.")) return false;
    return true;
  },
});
```

When `isUrlAllowed` returns `false` (or `Promise<false>`), the tool returns:
```json
{ "error": "Navigation to <url> is not allowed by URL policy", "code": "PERMISSION" }
```

The callback receives the raw URL string before it reaches the driver. It may be sync or async (the tool always `await`s the result). If the callback throws, the error propagates to the caller.

**No-URL tab opens are unaffected.** `browser_tab_new` without a `url` argument skips the check.

**Comparison with v1 `scope`/`security`:**

| v1 | v2 |
|----|----|
| `scope: createScopedBrowser(...)` (from `@koi/scope`) | `isUrlAllowed: (url) => boolean \| Promise<boolean>` |
| `security: compileNavigationSecurity(...)` | same `isUrlAllowed` callback |
| Layer violation: L2 importing L2 | Clean: L2 importing nothing extra |

---

## Snapshot Size Control: maxBytes

`browser_snapshot` in v2 accepts `maxBytes` instead of `maxTokens`. This gives callers a more intuitive budget (bytes are observable; tokens are model-dependent).

```typescript
// Default: 50KB = 12,500 tokens (50_000 / 4)
browser_snapshot()

// Custom: cap at 20KB = 5,000 tokens
browser_snapshot({ maxBytes: 20_000 })

// Large snapshot for debugging
browser_snapshot({ maxBytes: 200_000 })
```

The conversion uses a `÷ 4` heuristic (1 token ≈ 4 bytes). The computed `maxTokens` is always passed to the driver — even when using the default — so the driver never falls back to its own default.

**Why bytes over tokens?** Token counts vary across models and tokenizers. Bytes are deterministic and easy to reason about for content budgeting.

Default constant: `DEFAULT_SNAPSHOT_MAX_BYTES = 50_000`.

---

## BrowserDriver Interface

Implement this interface to connect any browser backend:

```typescript
interface BrowserDriver {
  snapshot(params?): Promise<BrowserSnapshotResult>;
  navigate(params): Promise<BrowserNavigateResult>;
  click(params): Promise<BrowserActionResult>;
  type(params): Promise<BrowserActionResult>;
  // ... one method per operation
  dispose?(): void | Promise<void>;
}
```

See `@koi/browser-playwright` for the Playwright implementation, or implement your own (e.g., Puppeteer, CDP-based, headless Chrome via shell).

---

## Known Limitations

### Canvas-based UIs (Figma, Google Sheets, Canva)

Applications that render their UI on an HTML5 `<canvas>` element — including Figma, Google Sheets, Canva, and many game/visualization tools — do not expose their interactive elements to the browser accessibility tree.

When `browser_snapshot` is called on these surfaces, it returns either an empty snapshot or only the shell HTML (header, menus, sidebar chrome) — not the canvas-rendered content inside. Refs like `[ref=e3]` will not appear for canvas elements.

**Workaround:** Use `browser_screenshot` as a fallback when working with canvas-heavy UIs. The screenshot captures the rendered pixels and can be passed to a vision-capable model for element identification and coordinate-based interaction.

```typescript
// Preferred for standard HTML/ARIA pages (100x cheaper):
browser_snapshot()

// Fallback for canvas-based UIs:
browser_screenshot()
```

Note: `browser_evaluate` can sometimes extract data from canvas-based apps via their JavaScript APIs, but this requires `promoted` trust tier and detailed knowledge of the app's internal API.

---

## Architecture

```
@koi/tool-browser (L2)
└── createBrowserProvider
    ├── createServiceProvider<BrowserDriver, BrowserOperation>()
    │   └── attaches: BROWSER token, browser_snapshot, browser_navigate, ...
    └── customTools hook
        ├── createCustomToolEntries()  ← evaluate pinned to "promoted"
        └── skill:browser              ← SkillComponent (ECS component, pure data)
```

`@koi/tool-browser` depends only on `@koi/core` (L0). The `BrowserDriver` is injected at construction time — swapping backends requires zero code changes in the provider.

---

## Exports

```typescript
// Provider factory
export { createBrowserProvider } from "./browser-component-provider.js";

// Skill
export { BROWSER_SKILL, BROWSER_SKILL_CONTENT, BROWSER_SKILL_NAME } from "./constants.js";

// Constants
export { BROWSER_SYSTEM_PROMPT, DEFAULT_PREFIX, OPERATIONS } from "./constants.js";

// Test helpers
export { createMockAgent, createMockDriver } from "./test-helpers.js";

// Types
export type { BrowserOperation } from "./constants.js";
```
