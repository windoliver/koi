# @koi/code-executor — Code Mode for Programmatic Tool Orchestration

`@koi/code-executor` is an L2 package that provides the `execute_script` tool,
enabling agents to write scripts that call multiple tools in a single LLM turn.
Scripts run in a QuickJS WebAssembly sandbox with a `callTool()` bridge back to
the host.

---

## Why it exists

When an agent performs 5+ sequential tool calls (read files, grep, write), each
is a separate LLM round-trip costing context tokens and latency:

```
Without Code Mode (5 LLM turns):

  Turn 1:  LLM → file_read("/src/a.ts")     → result → back to LLM
  Turn 2:  LLM → file_read("/src/b.ts")     → result → back to LLM
  Turn 3:  LLM → grep("TODO", "/src/")      → result → back to LLM
  Turn 4:  LLM → file_write("/src/a.ts", …) → result → back to LLM
  Turn 5:  LLM → file_write("/src/b.ts", …) → result → back to LLM
```

Code Mode collapses this to 1 turn:

```
With Code Mode (1 LLM turn):

  Turn 1:  LLM → execute_script({
    code: `
      var a = callTool("file_read", { path: "/src/a.ts" });
      var b = callTool("file_read", { path: "/src/b.ts" });
      var todos = callTool("grep", { pattern: "TODO", path: "/src/" });
      callTool("file_write", { path: "/src/a.ts", content: transform(a) });
      callTool("file_write", { path: "/src/b.ts", content: transform(b) });
      ({ filesProcessed: 2, todosFound: todos.length });
    `
  })
```

The agent writes a program that orchestrates tools; the sandbox executes it;
all results come back in a single response.

---

## Architecture

### Layer position

```
L0  @koi/core              ─ Tool, ToolDescriptor, ComponentProvider (types only)
L0u @koi/sandbox-wasm      ─ QuickJS Wasm executor with asyncify (async host functions)
L2  @koi/code-executor     ─ this package (depends on L0 + L0u only)
```

### Internal module map

```
src/
├── execute-script.ts        ← orchestrator (transpile → bridges → Wasm sandbox)
├── execute-script-tool.ts   ← Tool wrapper (what the agent calls)
├── console-bridge.ts        ← captures console.log/error/warn from sandbox
├── tool-bridge.ts           ← callTool() bridge with budget tracking
├── transpile.ts             ← TS→JS via Bun.Transpiler
├── provider.ts              ← ComponentProvider (attaches execute_script)
└── index.ts                 ← public exports
```

### Execution flow

```
LLM calls execute_script({ code, language?, timeout_ms? })
     │
     ▼
1. Validate input (code required, language js/ts, clamp timeout)
     │
     ▼
2. Transpile TS → JS (if language = "typescript")
     │
     ▼
3. Create bridges
     ├── Console bridge: __consoleLog, __consoleError, __consoleWarn
     └── Tool bridge:    __callToolRaw (async host function)
     │
     ▼
4. Build full script: console preamble + tool preamble + user code
     │
     ▼
5. Execute in QuickJS Wasm VM
     ├── 8 MB heap limit
     ├── 512 KB stack limit
     ├── Interrupt handler for timeout enforcement
     └── Asyncify: host async functions appear synchronous to guest
     │
     ▼
6. Return ScriptResult to agent
     { ok, result, console, toolCallCount, durationMs, error? }
```

### The callTool() bridge (RPC over JSON)

```
Guest (QuickJS Wasm)                    Host (Bun)
────────────────────                    ──────────
callTool("file_read", {path: "/x"})
  │
  ├── JSON.stringify({name, args})
  │
  └──→ __callToolRaw(json) ──────────→ parse JSON
                                        │
                                        ├── look up tool by name
                                        ├── tool.execute(args)   ← real I/O here
                                        ├── JSON.stringify(result)
                                        │
  result = JSON.parse(raw) ←───────────┘
  │
  return result
```

Asyncify makes the host async call appear synchronous to the guest.
No `await` needed inside scripts — `callTool()` returns the result directly.

**Constraint:** asyncify supports only one pending suspension at a time.
Sequential calls are fine; `Promise.all([callTool(), callTool()])` is not.

---

## Sandbox isolation

The script runs in a QuickJS WebAssembly VM. It has:

```
  ✅ Pure JavaScript computation
  ✅ callTool(name, args)  → controlled RPC to host tools
  ✅ console.log/error/warn → captured and returned

  ❌ No filesystem access  (no fs, no require)
  ❌ No network access     (no fetch, no XMLHttpRequest)
  ❌ No process access     (no process, no child_process)
  ❌ No host memory access (Wasm linear memory is isolated)
```

The only way out of the sandbox is `callTool()`, which goes through the host-side
tool bridge. This means:

- **Middleware still applies** — audit, rate limiting, scope checks
- **Trust tiers respected** — each tool's own trust tier governs what it can do
- **Budget enforced** — max 50 tool calls per script (configurable)

---

## Error handling

All errors are returned in the `ScriptResult`, never thrown. The agent always
gets a structured response it can reason about.

```
Error source                  Result
────────────                  ──────
Missing code argument      →  { ok: false, error: "code is required" }
Unsupported language       →  { ok: false, error: "Unsupported language: python" }
TS transpilation failure   →  { ok: false, error: "..." }
Script throws              →  { ok: false, error: "something went wrong", console: [...] }
Unknown tool in callTool   →  { ok: false, error: "Unknown tool: xyz", console: [...] }
Tool.execute() throws      →  { ok: false, error: "upstream unavailable", console: [...] }
Budget exceeded            →  { ok: false, error: "budget exceeded", console: [...] }
Timeout (infinite loop)    →  { ok: false, error: "...", console: [...] }
OOM (exceeds 8MB heap)    →  { ok: false, error: "...", console: [...] }
```

Console output is **always preserved** even on error — the agent can see
`console.log()` debug output from before the failure.

---

## How it integrates with other tools

The `execute_script` tool is attached via a `ComponentProvider` at priority
`COMPONENT_PRIORITY.BUNDLED + 10` (110). This means it runs **after** all other
tool providers during agent assembly:

```
Priority 0     AGENT_FORGED     → agent-scoped forge bricks
Priority 10    ZONE_FORGED      → zone-scoped forge bricks
Priority 50    GLOBAL_FORGED    → global forge bricks
Priority 100   BUNDLED          → filesystem, search, shell, etc.
Priority 110   CODE-EXECUTOR    → execute_script (sees all tools above)
```

At attach time, the provider calls `agent.query<Tool>("tool:")` to discover
all existing tools. These become callable via `callTool()` inside scripts.
The provider excludes `execute_script` itself to prevent recursion.

---

## Difference from @koi/sandbox-executor

These two packages serve different purposes:

```
                @koi/sandbox-executor              @koi/code-executor
                ─────────────────────              ──────────────────
Purpose         Run forge bricks (pre-reviewed)    Run ad-hoc LLM scripts
Backend         OS process / in-process            QuickJS Wasm VM
Trust model     Tiered (sandbox/verified/promoted) Always Wasm-sandboxed
Tool access     None — brick IS the tool           callTool() bridge to other tools
Triggered by    Forge attaching a brick            LLM calling execute_script
Input           Brick artifact code                Arbitrary JS/TS string
```

---

## API reference

### ComponentProvider

```typescript
import { createCodeExecutorProvider } from "@koi/code-executor";

const provider = createCodeExecutorProvider();
// provider.name = "code-executor"
// provider.priority = 110
// provider.attach(agent) → Map with toolToken("execute_script")
```

### Direct execution (without the tool wrapper)

```typescript
import { executeScript } from "@koi/code-executor";
import type { ScriptResult } from "@koi/code-executor";

const result: ScriptResult = await executeScript({
  code: 'callTool("file_read", { path: "/tmp/test.txt" });',
  language: "javascript",        // default
  timeoutMs: 30_000,             // default
  maxToolCalls: 50,              // default
  tools: myToolMap,              // Map<string, Tool>
});
```

### Types

| Type | Description |
|------|-------------|
| `ScriptConfig` | `{ code, language?, timeoutMs?, maxToolCalls?, tools }` |
| `ScriptResult` | `{ ok, result, console, toolCallCount, durationMs, error? }` |
| `ConsoleEntry` | `{ level: "log" \| "error" \| "warn", message: string }` |

### Exports

| Export | Kind | Description |
|--------|------|-------------|
| `createCodeExecutorProvider` | factory | ComponentProvider that attaches `execute_script` |
| `createExecuteScriptTool` | factory | Creates the `execute_script` Tool directly |
| `executeScript` | function | Low-level orchestrator (no Tool wrapper) |
| `ScriptConfig` | type | Configuration for `executeScript()` |
| `ScriptResult` | type | Result from script execution |
| `ConsoleEntry` | type | Captured console output entry |

---

## Examples

### Simple computation

```typescript
const result = await executeScript({
  code: "1 + 2",
  tools: new Map(),
});
// { ok: true, result: 3, console: [], toolCallCount: 0, durationMs: 5 }
```

### Multi-tool orchestration

```typescript
const result = await executeScript({
  code: `
    var files = ["a.ts", "b.ts", "c.ts"];
    var contents = [];
    for (var i = 0; i < files.length; i++) {
      var content = callTool("file_read", { path: "/src/" + files[i] });
      contents.push({ name: files[i], lines: content.split("\\n").length });
    }
    contents;
  `,
  tools: agentToolMap,
});
// { ok: true, result: [{name:"a.ts",lines:42}, ...], toolCallCount: 3, ... }
```

### TypeScript support

```typescript
const result = await executeScript({
  code: `
    function sum(a: number, b: number): number { return a + b; }
    sum(40, 2);
  `,
  language: "typescript",
  tools: new Map(),
});
// { ok: true, result: 42, ... }
```

### Error handling in script

```typescript
const result = await executeScript({
  code: `
    var results = [];
    var tools = ["file_read", "maybe_missing"];
    for (var i = 0; i < tools.length; i++) {
      try {
        results.push(callTool(tools[i], { path: "/test" }));
      } catch (e) {
        console.error("Failed: " + tools[i] + " - " + e.message);
      }
    }
    results;
  `,
  tools: agentToolMap,
});
// ok: true, console: [{level:"error", message:"Failed: maybe_missing - Unknown tool: maybe_missing"}]
```

---

## Layer compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    Tool, ToolDescriptor, ComponentProvider, toolToken,       │
    COMPONENT_PRIORITY                                        │
                                                              ▼
L0u @koi/sandbox-wasm ─────────────────────────────────────→ │
    createAsyncWasmExecutor (QuickJS + asyncify)              │
                                                              ▼
L2  @koi/code-executor ◀─────────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```

---

## Related

- [@koi/sandbox-wasm](../../packages/sandbox-wasm/) — QuickJS Wasm executor (async + sync)
- [@koi/sandbox-executor](./sandbox-executor.md) — trust-tiered executor for forge bricks
- [@koi/core](../../packages/core/) — L0 contract definitions (Tool, ComponentProvider)
