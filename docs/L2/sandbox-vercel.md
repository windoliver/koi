# @koi/sandbox-vercel — Vercel Functions EdgeFunctionAdapter (DESIGN-ONLY in v1)

Implements `EdgeFunctionAdapter` from `@koi/core` for Vercel Edge Functions.
Marked `designOnly: true` in `package.json` and **not wired into
`@koi/runtime`** for v1 — the package ships shim templates + dedupe state
machine + per-pair Ed25519 signing utilities, but no executable adapter.

## Layer

```
L2  @koi/sandbox-vercel
    depends on: @koi/core (L0)
```

## Public API

```typescript
export const EXPERIMENTAL_createVercelAdapter: (config?) => EdgeFunctionAdapter;
export { GATEWAY_SHIM_SOURCE, HANDLER_RUNNER_SHIM_SOURCE } from "./shim-templates.js";
export { generatePairKeypair, signRequest, verifyRequest } from "./pair-keys.js";
export { KvStateMachine } from "./kv-state-machine.js";
export { mapShimResponse } from "./map-shim-response.js";
```

## Architecture

- **Worker A (gateway)**: holds Vercel KV REST credentials and the per-pair
  Ed25519 signing key. Runs the dedupe protocol against KV via server-side
  Lua (Upstash `EVAL`) and signs the forwarded request to Worker B.
- **Worker B (handler-runner)**: holds the per-pair Ed25519 verify key only,
  plus a scoped nonce-burn KV credential. Verifies signature, burns the
  nonce (`SET NX EX`) to prevent replay within the skew window, and invokes
  operator code.
- **`KvStateMachine`**: JS port of the dedupe Lua scripts (claim/complete/
  fail/release) for unit testing without a live KV.

## Why design-only

The Vercel deploy path (deploy preview + production protection bypass +
KV provisioning) is not in v1. Templates and helpers ship so that the
follow-up commit that wires deploy lands cleanly without re-doing the
core dedupe / auth design.

## Tests

`bun test packages/sandbox/sandbox-vercel`. Includes runtime corner-case
tests that drive the handler-runner shim source via `new Function` with
mocked fetch + Ed25519 keypairs.
