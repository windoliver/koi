# @koi/sandbox-cloudflare — Cloudflare Workers EdgeFunctionAdapter

Implements `EdgeFunctionAdapter` from `@koi/core` for Cloudflare Workers. Pairs
a koi-owned dedupe gateway (Worker A) with an operator-code handler runner
(Worker B) connected via a Service Binding. Per-(ownerId, operationId) dedupe
state lives in a Durable Object (`KoiDedupeDO`).

## Layer

```
L2  @koi/sandbox-cloudflare
    depends on: @koi/core (L0)
```

## Public API

```typescript
export const EXPERIMENTAL_createCloudflareAdapter: (config?) => EdgeFunctionAdapter;

// Internals exported for tests + composition
export { GATEWAY_SHIM_SOURCE, HANDLER_RUNNER_SHIM_SOURCE } from "./shim-templates.js";
export { KoiDedupeDO } from "./dedupe-do-class.js";
export { computeDedupeFingerprint } from "./dedupe-fingerprint.js";
export { mapShimResponse } from "./map-shim-response.js";
```

## Architecture

- **Worker A (gateway)**: holds DO binding, instance token, owner id. Runs
  the dedupe protocol against the DO, forwards the handler call to Worker B
  via a Service Binding.
- **Worker B (handler-runner)**: runs operator code. No dedupe credentials,
  no DO binding. Runtime fence is prepended at deploy time.
- **`KoiDedupeDO`**: durable claim/complete/fail/release state machine with
  bounded retry-horizon, fingerprint conflict detection, claim-expired
  takeover, and `failed-permanent` caching.

## Status

`create()` is currently a hard stub (`UNAVAILABLE`/`ADAPTER_NOT_IMPLEMENTED`).
The two-worker shims, DO state machine, runtime fence, and dedupe protocol
are deploy-ready; the wrangler/Workers-API deploy path lands in a follow-up
commit. Adapter is gated behind the `EXPERIMENTAL_` export prefix until the
deploy path lands.

## Tests

`bun test packages/sandbox/sandbox-cloudflare`. Includes runtime corner-case
tests that drive the gateway shim source via `new Function` with mocked DO
+ Service Binding.
