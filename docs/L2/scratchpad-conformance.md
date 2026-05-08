# @koi/scratchpad-conformance — Shared Contract Test Suite

A `bun:test` conformance harness that any `ScratchpadComponent` implementation
can run against itself. Both `@koi/scratchpad-local` and `@koi/scratchpad-nexus`
import this package and feed in their factory; the harness asserts that they
behave identically at the L0 contract boundary.

---

## Why It Exists

`ScratchpadComponent` is an L0 contract with two production implementations
(in-memory and Nexus-backed). Without a shared suite, contract drift between
backends slips in as silent divergence — an event that fires for the local
adapter but not the Nexus one, or a CAS code that returns differently. The
conformance package extracts that contract into one place so divergence
fails CI as a real bug instead of a backend quirk.

This package is **test-only**. It exports nothing at runtime that production
code should depend on; it lives in `dependencies` purely so adapter packages
can `import { describeScratchpadConformance }` from their own `*.test.ts` files.

---

## Public API

```typescript
import { describeScratchpadConformance } from "@koi/scratchpad-conformance";
import { createLocalScratchpad } from "@koi/scratchpad-local";

let counter = 0;
describeScratchpadConformance("createLocalScratchpad", () =>
  createLocalScratchpad({
    groupId: agentGroupId(`conformance-${++counter}`),
    authorId: agentId("conformance-author"),
  }),
);
```

The factory MUST return a brand-new component on each call so tests don't
share state. It may be sync or async (network adapters, transport probes, etc.).

---

## What the Suite Covers

| # | Test | Contract guarantee |
|---|------|--------------------|
| 1 | write/read round-trip | content preserved, generation assigned starting at 1 |
| 2 | read of missing path | typed `NOT_FOUND`, never throws |
| 3 | unconditional write | overwrites, generation increments |
| 4 | CAS create-only (`expectedGeneration: 0`) | `CONFLICT` when path exists |
| 5 | CAS update with stale generation | `CONFLICT` when current ≠ expected |
| 6 | delete | entry disappears from list/read |
| 7 | list | summaries (no `content`) for all entries |
| 8 | onChange `written` | eventually delivers an event with the latest generation |
| 9 | onChange historical replay | new subscriber does NOT see pre-existing entries |
| 10 | subscriber isolation | a throwing handler must not stop sibling handlers |

The suite covers behavior visible at the contract boundary. Backend-private
corners (pagination protocol, fallback wiring, transport health) belong in
adapter-specific tests, not here.

---

## Layer Position

L2 (test harness). Depends only on `@koi/core` (L0). Runs on `bun:test` (declared
as `external` in `tsup.config.ts` so the dist bundle stays test-runner-agnostic).
