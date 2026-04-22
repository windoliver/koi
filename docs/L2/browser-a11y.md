# @koi/browser-a11y — Accessibility-tree serializer + Playwright error translator

L0u utility package. Pure functions. Depends only on `@koi/core` and `@koi/token-estimator`. Imported by `@koi/browser-playwright` (CDP-over-Playwright driver) and `@koi/browser-ext` (extension-injected session driver) to produce compact text tree snapshots from accessibility data and to translate Playwright exceptions into typed `KoiError`s.

---

## Why It Exists

LLM agents can't see pixels. Browser automation has to expose the page as text with stable per-element references. Two different browser drivers (Playwright-over-CDP, extension-over-native-messaging) need exactly the same text format and the same error-translation semantics so agent prompts and error-handling code work identically against either. Duplicating 500 LOC of serialization across both drivers would be a Rule-of-Three violation waiting to happen. Lifting those files into an L0u package gives a single source of truth.

---

## Public API

```typescript
import {
  serializeA11yTree,
  parseAriaYaml,
  isAriaRole,
  VALID_ROLES,
  translatePlaywrightError,
  type A11yNode,
  type SerializeResult,
} from "@koi/browser-a11y";
```

### `serializeA11yTree(root: A11yNode, options?: BrowserSnapshotOptions): SerializeResult`

Walks an accessibility tree and produces compact text output with `[ref=eN]` markers on interactive elements. Tracks occurrence counts for `nthIndex` so drivers can disambiguate duplicate `role+name` pairs via `getByRole().nth(N)`.

### `parseAriaYaml(yaml: string, options?: BrowserSnapshotOptions): SerializeResult`

Parses Playwright 1.44+ `locator.ariaSnapshot()` YAML output. Captures Playwright's native `aria-ref=eN` attributes into `BrowserRefInfo.ariaRef` so drivers can use the O(1) `[aria-ref=eN]` CSS selector path when available, falling back to `getByRole() + nth` otherwise.

### `isAriaRole(role: string): boolean`

Type guard: returns true for the 22 interactive ARIA roles listed in `VALID_ROLES`.

### `translatePlaywrightError(operation: string, err: unknown): KoiError`

Maps Playwright exceptions to typed `KoiError`s via duck-typed `.name` and `.message` probing — no Playwright runtime dependency. Covers 9 failure patterns (timeout, stale ref, CORS, DNS failure, page-closed, WebSocket disconnect, JS eval error, invalid selector, unknown). See the table in `src/error-translator.ts`.

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    BrowserRefInfo, BrowserSnapshotOptions, KoiError,    │
    external(), internal(), permission(), staleRef(),    │
    timeout(), validation() — types + factory functions   │
                                                         │
L0u @koi/token-estimator                                 │
    CHARS_PER_TOKEN                                      │
                                                         │
L0u @koi/browser-a11y ◄──────────────────────────────────┘
    imports only from @koi/core and @koi/token-estimator.
    No Playwright. No filesystem. No network.
    Imported by:
      @koi/browser-playwright (L2, P2)
      @koi/browser-ext       (L2, P5)
```

---

## Testing

- `src/__tests__/a11y-serializer.test.ts` — golden-file assertions for tree→text conversion and parseAriaYaml, ported verbatim from v1.
- `src/__tests__/error-translator.test.ts` — table-driven mapping from Playwright exception patterns to `KoiError`, ported from v1.
- `src/__tests__/api-surface.test.ts` — guards the public export list so accidental internal leaks are caught in CI.

Run: `bun test --cwd packages/lib/browser-a11y`

---

## Non-Goals

- **No Playwright runtime coupling.** All functions take plain JS values or implement duck-typed probes. This package can be imported into environments that don't have Playwright installed (e.g., the MV3 extension build output).
- **No ref resolution.** The `BrowserRefInfo.nthIndex` and `.ariaRef` fields are emitted here; actually using them against a live `Page` is the driver's job (see `@koi/browser-playwright.playwright-browser-driver.ts`).
- **No serialization for input trees beyond accessibility.** Full-DOM or visual-regression serializers would be separate packages.
