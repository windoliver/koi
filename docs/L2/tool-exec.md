# @koi/tool-exec

Programmatic tool orchestration — the `execute_code` tool runs multi-step TypeScript/JavaScript scripts in an isolated Bun Worker thread, calling registered tools via an RPC bridge and returning only the final result to the model's context window.

## Layer

L2 — depends on `@koi/core` (L0) and `@koi/tools-core` (L0u).

## Purpose

Every tool call costs a context turn. A 10-step pipeline (search → filter → write → commit) burns 10 model roundtrips plus 10 tool result injections into context. With `execute_code`, the model writes one script, the runtime executes all tool calls internally, and only the final summary returns to context — up to 90% context savings for repetitive multi-step work.

The isolation model:

- The script runs in a **Bun Worker thread** — separate thread, separate memory
- Tool calls inside the script go through the same tool map (and optionally the same middleware chain) as direct calls
- The worker is terminated after the script completes or times out
- The model cannot access intermediate tool results — only the final `return` value reaches context

## Public API

### `createExecuteCodeTool(config: ExecuteCodeToolConfig): Result<Tool, KoiError>`

Create the `execute_code` tool. Returns `Result<Tool>` so callers can handle validation errors without throws.

```typescript
interface ExecuteCodeToolConfig {
  /**
   * REQUIRED trust gate. Scripts run in a Bun Worker that shares the host's
   * ambient network and filesystem capabilities (fetch, Bun.file, timers),
   * bypassing the `tools.*` permission middleware. Pass the exported
   * `ACKNOWLEDGE_UNSANDBOXED_EXECUTION` sentinel to opt in. Without this
   * field `createExecuteCodeTool` returns a `PERMISSION` error — the tool
   * is not constructed and `execute_code` will not appear in the registry.
   */
  readonly acknowledgeUnsandboxedExecution: typeof ACKNOWLEDGE_UNSANDBOXED_EXECUTION;
  /** Tools exposed to the script via tools.* */
  readonly tools: ReadonlyMap<string, Tool>;
  /**
   * Optional middleware-aware call function injected by L3 runtime.
   * When provided, inner tool calls go through the full permission and
   * middleware chain. Falls back to direct tool.execute() when absent.
   */
  readonly callTool?: (name: string, args: JsonObject, signal?: AbortSignal) => Promise<unknown>;
  /** Default timeout override (ms). Default: 30 000. */
  readonly defaultTimeoutMs?: number;
}
```

**Trust gate (required from v0.1):** the `acknowledgeUnsandboxedExecution`
field is a runtime-enforced opt-in. Because this package has not yet shipped a
release without it, there is no compatibility shim — every caller is expected
to pass the sentinel. The opt-in exists so a forgotten import or copy-paste
from an unrelated example cannot silently grant a model-generated script
ambient host privileges.

**Tool schema for the model:**

```typescript
{
  name: "execute_code",
  parameters: {
    script: string,       // TypeScript or JavaScript. Use await tools.name(args).
    timeout_ms?: number,  // Default: 30 000. Max: 300 000.
  }
}
```

### `executeScript(config: ScriptConfig): Promise<ScriptResult>`

Lower-level API — execute a script directly without going through the `execute_code` tool wrapper. Useful for testing or custom orchestration.

```typescript
interface ScriptConfig {
  readonly code: string;
  readonly language?: "javascript" | "typescript"; // Default: "typescript"
  readonly timeoutMs?: number;      // Default: 30 000. Hard cap: 300 000.
  readonly maxToolCalls?: number;   // Default: 50
  readonly tools: ReadonlyMap<string, Tool>;
  readonly callTool?: (name: string, args: JsonObject, signal?: AbortSignal) => Promise<unknown>;
  readonly signal?: AbortSignal;
}

interface ScriptResult {
  readonly ok: boolean;
  readonly result: unknown;         // Final return value of the script
  readonly toolCallCount: number;
  readonly durationMs: number;
  readonly error?: string;          // Present when ok is false
}
```

## Script API (inside the script)

The script receives a `tools` object. Each registered tool is available as an async method:

```typescript
// tools.* accepts any tool name registered with the execute_code tool
const files = await tools.glob({ pattern: "**/*.ts" });
const hits = await tools.grep({ pattern: "TODO", glob: "**/*.ts" });
return { fileCount: files.length, todoCount: hits.length };
```

**Rules for scripts:**
- `await` every tool call — all tool methods return `Promise<unknown>`
- Sequential calls only — `Promise.all` across tools is not supported (worker message ordering)
- `return` a value to pass it back to the model; no return means `null` result
- Top-level TypeScript type annotations are stripped before execution
- `import`/`export` statements are not allowed (script is a function body, not a module)
- The script has access to standard JS globals (Promise, setTimeout, crypto, etc.)

## Internals

### Transpilation

`transpileTs(source)` wraps the user code in `export default (async function(tools) { ... })` before calling `Bun.Transpiler.transformSync`. The `export default` prevents the transpiler from eliding the expression. The `export default` prefix is then stripped, leaving a bare function expression that the worker can `eval()`.

### Worker isolation

The worker is a Bun Worker thread (`new Worker(url)`). It:
1. Receives the transpiled function expression via `postMessage`
2. `eval()`s it to obtain the async function
3. Calls it with a catch-all `Proxy` for the `tools` parameter
4. Any `tools.name(args)` access on the Proxy sends a "call" message to the host
5. The host executes the tool (via `callTool` or direct `tool.execute()`) and posts the result back
6. The script resumes with the tool's return value

The worker is terminated immediately after the script completes, errors, or times out.

### Tool call budget

The host tracks `toolCallCount` and fails the whole script when a call would
exceed `maxToolCalls` (default 50). Budget exhaustion is host-authoritative:
even if the worker script catches the rejected `tools.*` promise, the final
`ScriptResult` is `ok: false` with `"Tool call budget exceeded"`. This matches
the existing fail-closed handling for concurrent tool-call violations.

### callTool middleware integration

When `callTool` is provided in `ExecuteCodeToolConfig`, every `tools.*()` call inside the script goes through that function instead of calling `tool.execute()` directly. This lets the L3 runtime wire the full permission and middleware chain:

```typescript
// L3 wiring example
import { ACKNOWLEDGE_UNSANDBOXED_EXECUTION, createExecuteCodeTool } from "@koi/tool-exec";

const execCodeTool = createExecuteCodeTool({
  acknowledgeUnsandboxedExecution: ACKNOWLEDGE_UNSANDBOXED_EXECUTION,
  tools: registeredTools,
  callTool: (name, args, signal) => middlewareChain.invoke(name, args, { signal }),
});
```

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_TIMEOUT_MS` | `30_000` | Default script timeout |
| `MAX_TIMEOUT_MS` | `300_000` | Hard cap on script timeout |
| `DEFAULT_MAX_TOOL_CALLS` | `50` | Default tool call budget |

## Security notes

- The `execute_code` tool has `sandbox: false` — its trust level is evaluated at the tool-call level by the permission middleware, not by OS sandbox
- The script runs in a Worker thread (not a subprocess), so it shares the Bun process's network and filesystem access — rely on `callTool` middleware to enforce per-tool permissions
- Scripts cannot access the agent's conversation history, model, or internal state — only the `tools` object is exposed
- All tool calls are subject to the same permission middleware as direct model-issued calls (when `callTool` is wired)
- Timeout is enforced by `worker.terminate()` — no graceful shutdown

## v1 reference

Ported from `archive/v1/packages/virt/code-executor` and `archive/v1/packages/fs/tool-exec`. Key simplifications in v2:

- **No Wasm/QuickJS** — uses Bun Workers instead; simpler, faster, no dependency on `@nicolo-ribaudo/quickjs-wasm`
- **No Asyncify constraint** — Bun Workers with postMessage/Promise are naturally async; sequential tool calls work without suspension/resumption tricks
- **No SandboxAdapter/SandboxProfile** — the Worker thread boundary provides the isolation; adapter abstraction deferred to a future package
- **Catch-all Proxy** — the tools object accepts any name and routes to the host, enabling `callTool` middleware without pre-registration of tool names
