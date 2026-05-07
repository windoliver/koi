# @koi/sandbox-wasm — In-process WASM executor

Implements `EdgeFunctionAdapter` from `@koi/core` for trusted, side-effect-free
WebAssembly modules. Class-A only.

## Layer

```
L2  @koi/sandbox-wasm
    depends on: @koi/core (L0)
```

## Public API

```typescript
export const createWasmExecutor: () => EdgeFunctionAdapter;
```

`create()` accepts `{ code: WebAssembly bytes, profile, workloadClass: "A" }`.
The returned `EdgeFunctionInstance` exposes `invoke({ export, args })` and
`destroy()`.

## What it does

- Static section scan rejects modules that import `memory`, `table`, or
  declare a `start` function — only host-owned linear memory is allowed.
- Bounded module cache: 64 entries, FIFO eviction, keyed by code SHA-256.
- `timeoutMs` is **advisory**: in-process execution cannot preempt a
  runaway loop, so the executor returns `TIMEOUT` post-hoc if elapsed
  duration exceeded the budget. Untrusted code MUST be deployed through
  a worker-backed adapter; this executor is for trusted modules only.

## What it is not

- Not preemptible. Untrusted WASM can pin the host thread.
- Not a full edge runtime — no networking, no fs, no host imports.

## Tests

Co-located with the source. `bun test packages/sandbox/sandbox-wasm`.
