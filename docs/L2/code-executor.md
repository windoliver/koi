# @koi/code-executor — `execute_script` tool

L2 package. Provides the `execute_script` tool, which runs a JavaScript or
TypeScript script inside an injected `SandboxExecutor` and returns the script's
output and a typed error.

## Why it exists

Agents often need to perform a small computation that strings together a few
deterministic operations (parse this JSON, slice that array, format this date)
without paying for a separate model turn per operation. `execute_script` lets
the model emit a snippet of code instead of allocating a turn-per-step, and
returns a structured result the model can read in its next turn.

Isolation is delegated. The package is policy-free — it spawns nothing on its
own; every script runs through the `SandboxExecutor` the caller injects.
Today the only `SandboxExecutor` implementation in v2 is
`@koi/sandbox-executor` (subprocess isolation); `@koi/sandbox-ipc` exposes a
narrower `IpcSandboxExecutor` shape (`executeFunctionBody`) and is **not** a
drop-in `SandboxExecutor` — wiring it into `code-executor` requires a separate
adapter that is not yet provided.

## Recent updates

- **Cloud sandbox policy context (#1550)**: `execute_script` now marks its tool
  policy with `sandboxBacking: "environment"` and forwards an explicit
  `ExecutionContext` to the injected `SandboxExecutor`: network disabled,
  default filesystem read/write allowlists, and resource limits derived from
  `DEFAULT_SANDBOXED_POLICY`. `ExecuteScriptToolConfig` and
  `CodeExecutorProviderConfig` accept `workspacePath` and `workspaceWrite` so
  hosts can grant read-only or explicit read/write workspace access to the
  sandbox context. Plain subprocess execution fails closed for this restricted
  context; production hosts must provide a real confining executor.

## Architecture

```
@koi/code-executor (L2)
├── transpile.ts            — Bun.Transpiler wrapper (TypeScript → JavaScript)
├── execute-script.ts       — orchestrates transpile + sandbox execute, normalises result
├── execute-script-tool.ts  — wraps executeScript() as a Koi `Tool`
├── provider.ts             — `ComponentProvider` that attaches the tool to an agent
└── index.ts                — public API surface

Dependencies
- @koi/core (L0) — Tool, ToolDescriptor, JsonObject, ComponentProvider, SandboxExecutor types
```

The package depends only on `@koi/core`. The `SandboxExecutor` implementation
is injected, so the package never imports any L2 sandbox adapter.

## Public API

### `transpileTs(code: string): TranspileResult`

Pure synchronous TypeScript→JavaScript transpile via `Bun.Transpiler`. Returns
`{ ok: true, code }` or `{ ok: false, error }` — never throws.

### `executeScript(config: ScriptConfig): Promise<ScriptResult>`

Runs a script through the injected `SandboxExecutor`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | `string` | — | Script source |
| `language` | `"javascript" \| "typescript"` | `"javascript"` | TS is transpiled before execution |
| `timeoutMs` | `number` | `30_000` | Forwarded to `SandboxExecutor.execute` |
| `input` | `unknown` | `undefined` | Bound to the script's `input` parameter |
| `executor` | `SandboxExecutor` | (required) | Injected sandbox |
| `context` | `ExecutionContext` | `undefined` | Optional sandbox context forwarded to `executor.execute` |

Result shape: `{ ok, result?, durationMs, error? }`. Sandbox failures
(`TIMEOUT`, `OOM`, `CRASH`, `PERMISSION`) flow through with their typed
`SandboxErrorCode` preserved in `error.code`. Transpilation failures return
`error.code === "TRANSPILE"`.

### `createExecuteScriptTool(config: ExecuteScriptToolConfig): Tool`

Builds a Koi `Tool` whose `descriptor.name` is `"execute_script"`. The tool
accepts `{ code, language?, timeout_ms? }` and clamps the timeout to
`[100ms, 120_000ms]`.

The tool uses an environment-backed sandbox policy. By default it requests no
network access, default read access for runtime paths, `/tmp/koi-sandbox-*`
write access, and resource limits. `workspacePath` adds that path to the read
allowlist; `workspaceWrite: true` also adds it to the write allowlist.

### `createCodeExecutorProvider(config: ProviderConfig): ComponentProvider`

`ComponentProvider` named `"code-executor"` that attaches the tool under
`toolToken("execute_script")`. Default `priority` is `COMPONENT_PRIORITY.BUNDLED`.
The provider threads `workspacePath` and `workspaceWrite` through to the tool.

## Script contract

The host wraps the user code as the body of an `async function (input) { ... }`
and the script's `return`-ed value becomes `result.result`. The script may use
`await`. Top-level `await` is unnecessary because the wrapper is already async.

```js
// example: execute_script payload
return input.numbers.reduce((a, b) => a + b, 0);
```

Tool calls from inside the script are **not supported**. Each `execute_script`
invocation is a single round trip — the model picks the inputs, the script
computes, the result returns. v1 supported a synchronous `callTool(...)` shim
via Asyncify on top of QuickJS-on-Wasm; v2 deliberately drops that because the
subprocess sandbox does not expose a bidirectional host channel and because
async tool calls from inside scripts created subtle ordering bugs that were
never caught at the type level.

## Tests

```
src/transpile.test.ts          — TS→JS, error path
src/execute-script.test.ts     — language routing, sandbox error mapping, input pass-through
src/execute-script-tool.test.ts — descriptor shape, timeout clamping, arg validation, sandbox context
src/provider.test.ts           — provider attaches tool under expected token and forwards workspace context
```

Unit tests use a hand-rolled mock `SandboxExecutor`. The package also includes
integration coverage with `@koi/sandbox-executor` to prove restricted contexts
fail closed when the injected executor is only a plain subprocess wrapper.

## Layer Compliance

```
L0  @koi/core ───────────────────────────────────────┐
    Tool, ToolDescriptor, ComponentProvider,         │
    SandboxExecutor, SandboxResult, JsonObject       │
                                                     │
L2  @koi/code-executor ◄─────────────────────────────
    only imports @koi/core
```
