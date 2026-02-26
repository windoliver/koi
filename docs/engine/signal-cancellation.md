# AbortSignal Cooperative Cancellation

Cooperative tool cancellation via `AbortSignal` — threaded from the run caller
through the full middleware chain to `tool.execute()`. Replaces fire-and-forget
`Promise.race` timeouts with signal-based cancellation that actually stops work.

**Layer**: L0 types (`@koi/core`) + L1 threading (`@koi/engine`) + L2 consumers
**Issue**: #406

---

## Why It Exists

Before this feature, tool timeouts used `Promise.race`:

```
Promise.race([
  tool.execute(args),   ← keeps running after timeout!
  timeoutSentinel       ← wins the race, caller moves on
])
```

The caller gets a timeout error, but `tool.execute()` continues in the background.
Post-timeout side effects (disk writes, HTTP calls, state mutations) still occur.
There is no way to tell a tool "stop what you're doing".

```
                Before                              After
                ──────                              ─────
Timeout fires:  caller gets error                   caller gets error
Tool process:   keeps running (ghost execution)     receives signal, exits early
Side effects:   continue silently                   stopped at next checkpoint
Process kill:   impossible                          signal listener kills child
```

---

## Architecture

### Signal threading path

```
User / API caller
       │
       │  new AbortController()
       │  runtime.run({ text, signal: controller.signal })
       ▼
  EngineInput.signal                               (caller provides)
       │
       ▼
  TurnContext.signal                                (L1 engine copies)
       │
       ├───────────────────────────────┐
       ▼                               ▼
  ToolRequest.signal             Adapter stream
       │                         (race terminates on abort)
       ▼
  Middleware chain
       │
       ├─ audit middleware    → observes signal (passthrough)
       ├─ sandbox middleware  → composes signal + local timeout
       └─ tool terminal       → passes to execute()
              │
              ▼
     tool.execute(args, { signal })
              │
              ├─ shell tool  → proc.kill() on abort
              ├─ http tool   → fetch({ signal }) abort
              └─ custom tool → check signal.aborted between steps
```

### Layer separation

```
L0  @koi/core          L1  @koi/engine             L2  @koi/* (consumers)
┌────────────────┐     ┌──────────────────────┐    ┌──────────────────────┐
│                │     │                      │    │                      │
│ ToolExecute    │◄────│ defaultToolTerminal  │    │ sandbox middleware   │
│ Options        │     │   passes signal to   │    │   composes upstream  │
│ { signal? }    │     │   tool.execute()     │    │   + local timeout    │
│                │     │                      │    │                      │
│ ToolRequest    │◄────│ callHandlers         │    │ node tool-call-      │
│ { signal? }    │     │   copies ctx.signal  │    │ handler              │
│                │     │   onto ToolRequest   │    │   AbortSignal.timeout│
│ Tool.execute   │     │                      │    │   + executeWithSignal│
│ (args, opts?)  │     │ One line of logic:   │    │                      │
│                │     │ { ...req, signal }   │    │ shell tool           │
└────────────────┘     └──────────────────────┘    │   kills child proc   │
     L0 only                L0 + L0u only          │                      │
                                                   │ Any future L2 tool   │
                                                   │   can opt in         │
                                                   └──────────────────────┘
```

### Three layers of defense

Every tool execution site uses a three-layer defense:

```
┌──────────────────────────────────────────────────────┐
│  Layer 1: Fast path                                  │
│  signal.throwIfAborted()                             │
│  → instant rejection if signal is already aborted    │
├──────────────────────────────────────────────────────┤
│  Layer 2: Cooperative                                │
│  tool.execute(args, { signal })                      │
│  → tool checks signal.aborted between work steps     │
│  → tool registers signal listeners to kill processes │
├──────────────────────────────────────────────────────┤
│  Layer 3: Backstop race                              │
│  Promise.race([execute(), signalRejection])          │
│  → bounds non-cooperating tools that ignore signal   │
│  → caller moves on even if tool doesn't check        │
└──────────────────────────────────────────────────────┘
```

---

## L0 Contract (`@koi/core`)

### ToolExecuteOptions

Options bag passed as second argument to `tool.execute()`:

```typescript
interface ToolExecuteOptions {
  readonly signal?: AbortSignal | undefined;
}
```

### Tool.execute signature

```typescript
interface Tool {
  readonly descriptor: ToolDescriptor;
  readonly trustTier: TrustTier;
  readonly execute: (args: JsonObject, options?: ToolExecuteOptions) => Promise<unknown>;
}
```

The second parameter is optional — existing tools that don't accept it continue to work
without changes. This is a backward-compatible extension.

### ToolRequest.signal

```typescript
interface ToolRequest {
  readonly toolId: string;
  readonly input: JsonObject;
  readonly metadata?: JsonObject;
  readonly signal?: AbortSignal | undefined;
}
```

Middleware receives the signal on every `ToolRequest`. It can observe, compose,
or pass through unchanged.

---

## L1 Engine Threading (`@koi/engine`)

The engine does exactly two things with the signal:

### 1. Thread signal in defaultToolTerminal

```typescript
// packages/engine/src/koi.ts — defaultToolTerminal
const output = await tool.execute(
  request.input,
  request.signal !== undefined ? { signal: request.signal } : undefined,
);
```

### 2. Copy TurnContext.signal onto ToolRequest

```typescript
// packages/engine/src/koi.ts — callHandlers construction
toolCall: (request: ToolRequest) => {
  const ctx = getTurnContext();
  const effectiveRequest =
    ctx.signal !== undefined ? { ...request, signal: ctx.signal } : request;
  return activeToolChain(ctx, effectiveRequest);
},
```

L1 is a relay — it threads the signal but never acts on it. All cancellation
logic lives in L2 packages.

---

## L2 Consumers

### Sandbox Middleware (`@koi/middleware-sandbox`)

Composes the upstream signal with a local timeout:

```
Upstream signal (user abort)        Local timeout (sandbox policy)
           │                                  │
           ▼                                  ▼
     AbortSignal.any([upstream, controller.signal])
                          │
                          ▼
              Composed effectiveSignal
                          │
                          ├── threaded to next() via ToolRequest
                          └── backstop race rejects on abort
```

```typescript
// Compose upstream + local timeout
const controller = new AbortController();
let timeoutId = setTimeout(() => {
  controller.abort(new Error(`middleware-sandbox-timeout:${request.toolId}`));
}, totalTimeoutMs);

const effectiveSignal =
  request.signal !== undefined
    ? AbortSignal.any([request.signal, controller.signal])
    : controller.signal;

const signalledRequest = { ...request, signal: effectiveSignal };

// Backstop race
const response = await Promise.race([
  next(signalledRequest),
  backstopPromise,  // rejects when composed signal aborts
]);
```

Either trigger (user abort OR sandbox timeout) aborts the composed signal,
which propagates to all downstream middleware and the tool.

### Node Tool-Call Handler (`@koi/node`)

Uses `AbortSignal.timeout()` — runtime-managed, no manual cleanup:

```typescript
const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
const result = await executeWithSignal(tool, args, timeoutSignal);
```

#### executeWithSignal helper

```typescript
async function executeWithSignal(
  tool: Tool,
  args: JsonObject,
  signal: AbortSignal,
): Promise<unknown> {
  // Layer 1: fast path
  signal.throwIfAborted();

  // Layer 2 + 3: cooperative + backstop
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      tool.execute(args, { signal }),         // cooperative
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),                                      // backstop
    ]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
```

### Shell Tool (`@koi/node` — exemplar)

Demonstrates the pattern for tools that spawn child processes:

```typescript
execute: async (args, options?: ToolExecuteOptions) => {
  const signal = options?.signal;

  // Fast path: already cancelled
  if (signal?.aborted) {
    return { error: "Command cancelled", cancelled: true };
  }

  const proc = Bun.spawn(["sh", "-c", command], { ... });

  // Register kill listener
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // ... wait for process
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
```

---

## How To Adopt (Tool Author Guide)

### Minimal: ignore signal (still safe)

Tools that don't check the signal are still bounded by the backstop race.
No code changes required — backward compatible:

```typescript
const myTool: Tool = {
  descriptor: { name: "simple", ... },
  trustTier: "sandbox",
  execute: async (args) => {
    // Works exactly as before — backstop race bounds execution
    return doWork(args);
  },
};
```

### Recommended: check signal between steps

For multi-step operations, check `signal.aborted` at natural boundaries:

```typescript
const myTool: Tool = {
  descriptor: { name: "multi_step", ... },
  trustTier: "sandbox",
  execute: async (args, options?) => {
    const signal = options?.signal;

    for (const item of items) {
      if (signal?.aborted) {
        return { status: "cancelled", processed: count };
      }
      await processItem(item);
      count++;
    }

    return { status: "completed", processed: count };
  },
};
```

### Advanced: register abort listener

For tools that hold resources (processes, connections, streams):

```typescript
execute: async (args, options?) => {
  const signal = options?.signal;
  if (signal?.aborted) return { cancelled: true };

  const connection = await openConnection();
  const onAbort = () => connection.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await connection.query(args.sql);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
```

### Pass signal to fetch

The `fetch` API natively supports `AbortSignal`:

```typescript
execute: async (args, options?) => {
  const response = await fetch(args.url, {
    signal: options?.signal,
  });
  return response.json();
}
```

---

## Data Flow

### Normal completion (no abort)

```
caller               engine              middleware             tool
  │                    │                      │                   │
  │  run({ text })     │                      │                   │
  │ ──────────────────>│                      │                   │
  │                    │  ToolRequest{signal}  │                   │
  │                    │ ────────────────────>│                   │
  │                    │                      │  next(request)    │
  │                    │                      │ ────────────────>│
  │                    │                      │                   │
  │                    │                      │                   │ execute(args,
  │                    │                      │                   │  { signal })
  │                    │                      │                   │
  │                    │                      │    ToolResponse   │
  │                    │                      │ <────────────────│
  │                    │    ToolResponse       │                   │
  │                    │ <────────────────────│                   │
  │    done event      │                      │                   │
  │ <──────────────────│                      │                   │
```

### User abort mid-execution

```
caller               engine              sandbox MW              tool
  │                    │                      │                     │
  │  run({ signal })   │                      │                     │
  │ ──────────────────>│                      │                     │
  │                    │  ToolRequest{signal}  │                     │
  │                    │ ────────────────────>│                     │
  │                    │                      │  composed signal    │
  │                    │                      │  next({signal})     │
  │                    │                      │ ──────────────────>│
  │                    │                      │                     │ working...
  │                    │                      │                     │
  │  abort() ──────────┼──────────────────────┼─ signal.aborted ──>│
  │                    │                      │                     │ checks signal
  │                    │                      │                     │ exits early
  │                    │                      │   cancelled result  │
  │                    │                      │ <──────────────────│
  │                    │    result             │                     │
  │                    │ <────────────────────│                     │
  │  terminated        │                      │                     │
  │ <──────────────────│                      │                     │
```

### Sandbox timeout (non-cooperating tool)

```
caller               engine              sandbox MW              tool
  │                    │                      │                     │
  │  run({ text })     │                      │                     │
  │ ──────────────────>│                      │                     │
  │                    │  ToolRequest{signal}  │                     │
  │                    │ ────────────────────>│                     │
  │                    │                      │  setTimeout(30s)    │
  │                    │                      │  AbortController    │
  │                    │                      │  next({signal})     │
  │                    │                      │ ──────────────────>│
  │                    │                      │                     │ working...
  │                    │                      │                     │ (ignores signal)
  │                    │                      │   ╔═══════════╗    │
  │                    │                      │   ║ 30s timer ║    │
  │                    │                      │   ║  fires    ║    │
  │                    │                      │   ╚═══════════╝    │
  │                    │                      │                     │
  │                    │                      │  controller.abort() │
  │                    │                      │  backstop rejects   │
  │                    │                      │                     │ (still running
  │                    │                      │                     │  but caller
  │                    │                      │                     │  moved on)
  │                    │  TIMEOUT error        │                     │
  │                    │ <────────────────────│                     │
  │  error event       │                      │                     │
  │ <──────────────────│                      │                     │
```

---

## Signal Composition

When multiple signal sources exist, they are composed with `AbortSignal.any()`:

```
                    ┌──────────────────────────────────────────┐
                    │           AbortSignal.any([...])          │
                    │                                          │
                    │  source 1: user's AbortController        │
                    │    → user calls abort() to cancel run    │
                    │                                          │
                    │  source 2: sandbox timeout controller    │
                    │    → fires after policy timeout + grace  │
                    │                                          │
                    │  Either source triggers = all downstream │
                    │  consumers see signal.aborted === true   │
                    └──────────────────────────────────────────┘
```

This means:
- User abort cancels even within sandbox timeout window
- Sandbox timeout fires even if user doesn't abort
- The tool sees one composed signal — doesn't know which source triggered

---

## Testing

### Unit tests

| File | Tests | What it covers |
|------|-------|----------------|
| `packages/core/src/__tests__/types.test.ts` | 3 | `ToolExecuteOptions` assignability, backward compat |
| `packages/engine/src/koi.test.ts` | 1 | `defaultToolTerminal` threads signal to `tool.execute` |
| `packages/node/src/tool-call-handler.test.ts` | 5 | `executeWithSignal` — cooperative, backstop, pre-aborted, signal threading |
| `packages/middleware-sandbox/src/sandbox-middleware.test.ts` | 2 | Signal threading to next, upstream signal composition |
| `packages/node/src/tools/shell.test.ts` | 2 | Pre-aborted fast path, process kill on signal abort |

### E2E tests (real Anthropic API)

```bash
E2E_TESTS=1 bun test --cwd packages/engine src/__tests__/e2e-signal-cancellation.test.ts
```

| # | Test | What it proves |
|---|------|----------------|
| 1 | Signal reaches tool.execute | Full pipeline threading: `EngineInput` → `TurnContext` → `ToolRequest` → `execute()` |
| 2 | Middleware observes signal | `wrapToolCall` receives `request.signal` in the middleware chain |
| 3 | Run-level abort interrupts | `AbortController.abort()` stops a long streaming response mid-generation |
| 4 | Cooperative tool exits early | Tool checks `signal.aborted` between steps, completes < 20 of 20 steps |
| 5 | Mixed tools coexist | Signal-aware and normal tools work in the same pipeline |
| 6 | Pre-aborted signal available | Signal state is threaded through even when pre-aborted before run |

---

## Source Files

| File | Change type |
|------|-------------|
| `packages/core/src/ecs.ts` | Added `ToolExecuteOptions`, updated `Tool.execute` |
| `packages/core/src/middleware.ts` | Added `signal` to `ToolRequest` |
| `packages/core/src/index.ts` | Exported `ToolExecuteOptions` |
| `packages/engine/src/koi.ts` | Thread signal in `defaultToolTerminal` + `callHandlers` |
| `packages/node/src/tool-call-handler.ts` | `executeWithSignal` helper + `AbortSignal.timeout` |
| `packages/middleware-sandbox/src/sandbox-middleware.ts` | `AbortController` + `AbortSignal.any` composition |
| `packages/node/src/tools/shell.ts` | Exemplar: kill child process on signal abort |
| `packages/engine/src/__tests__/e2e-signal-cancellation.test.ts` | E2E tests with real LLM |

---

## Comparison with Prior Art

| Concern | Koi (this PR) | OpenClaw | NanoClaw |
|---------|---------------|----------|----------|
| Signal threading | Full pipeline: caller → engine → middleware → tool | `wrapToolWithAbortSignal` per-tool wrapper | None (container isolation) |
| Cooperative cancellation | `options.signal` on `tool.execute` | Similar options bag | No — kills container |
| Non-cooperating tools | Promise.race backstop | Promise.race only (no signal) | Docker kill (coarse) |
| Signal composition | `AbortSignal.any()` merges sources | Manual `if` checks | N/A |
| Middleware awareness | Signal on `ToolRequest` | No middleware signal | No middleware |
| Process cleanup | `signal.addEventListener → proc.kill()` | No process signal handling | Container-level kill |
| /stop race condition | Signal propagates immediately | 2-3s window where tool runs | N/A |
| Backward compatibility | Optional second param, zero breaking changes | Required wrapper migration | N/A |
