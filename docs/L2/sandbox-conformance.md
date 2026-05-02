# @koi/sandbox-conformance — Shared Adapter Test Suite

Shared `bun:test` describe blocks adapter packages import to verify they meet
the `SandboxAdapter` contract. Every L2 adapter package SHOULD have a
`__tests__/conformance.test.ts` that calls `describeSandboxConformance`.

## Layer

```
L2  @koi/sandbox-conformance
    depends on: @koi/core (L0), bun:test (Bun runtime)
    does NOT import: @koi/engine (L1), peer L2
```

This package is `private: true` — never published to npm. Adapter packages
include it as a `devDependency`.

## Usage

```typescript
// packages/sandbox/sandbox-<name>/src/__tests__/conformance.test.ts
import { describeSandboxConformance } from "@koi/sandbox-conformance";
import type { SandboxProfile } from "@koi/core";
import { createMyAdapter } from "../adapter.js";

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "closed" },
  network: { allow: false },
  resources: {},
};

describeSandboxConformance(
  "my-adapter",
  () => createMyAdapter({ /* config */ }),
  () => profile,
);
```

## Groups (PR 1)

| Group | What it checks |
|-------|----------------|
| Lifecycle | `init?` and `shutdown?` are idempotent and don't throw |
| Create + Destroy | `create()` returns a usable instance; `destroy()` is idempotent |
| Capability honesty | `persistence` ⇒ `findOrCreate` exists; `spawn` ⇒ `instance.spawn` exists |

## Groups planned for PRs 2-4

| Group | Lands with |
|-------|------------|
| Exec basics (exit codes, stdout/stderr, env, cwd) | PR 2 (`@koi/sandbox-local`) |
| Exec timeout + signal | PR 2 |
| Exec output limits / truncation | PR 2 |
| copy-files roundtrip | PR 2 |
| spawn (capability-gated) | PR 2 |
| Persistence (capability-gated) | PR 3 (`@koi/sandbox-docker` declares it) |
| Profile enforcement (network/filesystem/resources) | PR 2 |

## Design notes

- Each group is exposed both as an individual function (for adapters that
  want to opt into a subset) and via the umbrella `describeSandboxConformance`.
- Capability-gated tests use the adapter's `capabilities.supports` set to
  decide whether to run or skip — a missing capability is not a failure.
- The `factory: () => SandboxAdapter` argument MUST return a fresh adapter
  on each call; the suite manages init/shutdown internally.
