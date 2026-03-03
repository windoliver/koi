# @koi/tool-exec — Sandboxed Code Execution Tool

`@koi/tool-exec` is an L2 package that provides the `exec` tool, enabling agents
to run code in **any** `SandboxExecutor` backend (Docker, Cloudflare Workers, e2b,
OS-level, etc.) with JSON input/output. It is a thin pass-through — no Wasm runtime,
no tool bridging, no console capture.

---

## Why it exists

Koi already has `execute_script` (@koi/code-executor) for tool orchestration in
QuickJS Wasm. But some use cases don't need tool bridging — they need **compute**:

```
Without exec (LLM guesses the answer):

  User:  "What's the average of these 500 salaries?"
  Agent:  *tries mental math, makes rounding errors*
  Agent:  "Approximately $87,400" ← wrong

With exec (LLM delegates to a sandbox):

  User:  "What's the average of these 500 salaries?"
  Agent:  → exec({
            code: "return input.salaries.reduce((a,b) => a+b, 0) / input.salaries.length",
            input: { salaries: [...500 numbers...] }
          })
        ← { ok: true, output: 87450.50, durationMs: 3 }
  Agent:  "The average salary is $87,450.50" ← correct
```

The key difference from `execute_script`:

```
              execute_script                    exec
              ──────────────                    ────
Sandbox       QuickJS Wasm (fixed)              Any SandboxExecutor (injected)
Purpose       Orchestrate callTool() calls      Compute / transform / verify
Tool access   callTool() RPC bridge             None
Data input    None                              JSON via `input` parameter
Console       Captured log/error/warn           None
Language      JS/TS (transpiled)                Whatever the backend supports
```

`exec` is the **backend-agnostic** execution tool. The operator chooses which
sandbox runs the code — Docker for heavy workloads, Cloudflare for edge, e2b
for cloud dev environments — the agent doesn't care.

---

## What this enables

1. **Accurate computation** — LLMs delegate math, aggregation, filtering to real code
   instead of hallucinating results

2. **Backend-agnostic execution** — same tool interface regardless of whether code
   runs in Docker, Cloudflare Workers, e2b, or an OS sandbox

3. **Data transformation** — reshape JSON, validate schemas, sort/filter/aggregate
   with guaranteed correctness

4. **Code verification** — run a snippet to confirm it produces expected output
   before writing it to a file

5. **Isolated by default** — no filesystem, no network (unless operator allows),
   no tool access. Pure compute in a sandbox.

---

## Architecture

### Layer position

```
L0  @koi/core              ─ SandboxExecutor, Tool, ToolDescriptor, SkillComponent
                              (types + contracts only)
L2  @koi/tool-exec         ─ this package (depends on L0 only)
```

Zero L0u dependencies. Zero external dependencies.

### Internal module map

```
src/
├── types.ts             ← ExecToolConfig, EXEC_TOOL_DESCRIPTOR, defaults
├── exec-tool.ts         ← createExecTool() factory (validates, clamps, delegates)
├── skill.ts             ← EXEC_SKILL companion skill (when to use exec vs execute_script)
├── provider.ts          ← createExecProvider() attaches tool:exec + skill:exec-guide
└── index.ts             ← public exports
```

### Execution flow

```
LLM calls exec({ code, input?, timeout_ms? })
     │
     ▼
1. Validate input (code must be non-empty string)
     │
     ▼
2. Clamp timeout
     ├── Use timeout_ms if valid positive number
     ├── Fall back to defaultTimeoutMs (5s)
     └── Clamp to maxTimeoutMs (30s)
     │
     ▼
3. Build ExecutionContext from config
     ├── networkAllowed (default: false)
     └── resourceLimits (optional maxMemoryMb, maxPids)
     │
     ▼
4. Delegate to executor.execute(code, input, timeoutMs, context)
     │
     ▼
5. Map result
     ├── Success → { ok: true, output, durationMs }
     ├── Expected error → { ok: false, error, code, durationMs }
     └── Unexpected throw → { ok: false, error, code: "CRASH" }
```

---

## Quick start

### Attach to an agent

```typescript
import { createExecProvider } from "@koi/tool-exec";

const provider = createExecProvider({
  executor: myDockerSandbox,     // any SandboxExecutor implementation
  defaultTimeoutMs: 5_000,       // optional (default: 5000)
  maxTimeoutMs: 30_000,          // optional (default: 30000)
  networkAllowed: false,         // optional (default: false)
  resourceLimits: {              // optional
    maxMemoryMb: 128,
    maxPids: 10,
  },
});

// provider.attach(agent) returns:
//   tool:exec        → the callable tool
//   skill:exec-guide → markdown injected into LLM context
```

### Use the tool factory directly

```typescript
import { createExecTool } from "@koi/tool-exec";

const tool = createExecTool({ executor: mySandbox });

const result = await tool.execute({
  code: "return input.items.filter(i => i.active).length",
  input: { items: [{ active: true }, { active: false }, { active: true }] },
});
// { ok: true, output: 2, durationMs: 5 }
```

---

## Companion skill

The provider attaches a `skill:exec-guide` alongside the tool. This markdown
is injected into the LLM's system context to teach it:

- **When to use `exec`** — compute, transform, verify with JSON input
- **When to use `execute_script`** — orchestrate multiple `callTool()` calls
- **When to skip both** — simple questions the LLM can answer directly
- **Example calls** — concrete JSON showing code + input patterns

Without the skill, the LLM only sees the bare tool descriptor and must guess
when to reach for `exec`. The skill eliminates that guesswork.

---

## Error handling

All errors are returned as structured objects, never thrown to the caller.

```
Error source                     Result
────────────                     ──────
Missing/empty code            →  { ok: false, error: "...", code: "VALIDATION" }
Non-string code               →  { ok: false, error: "...", code: "VALIDATION" }
Executor returns TIMEOUT      →  { ok: false, error: "...", code: "TIMEOUT", durationMs }
Executor returns OOM          →  { ok: false, error: "...", code: "OOM", durationMs }
Executor returns PERMISSION   →  { ok: false, error: "...", code: "PERMISSION", durationMs }
Executor returns CRASH        →  { ok: false, error: "...", code: "CRASH", durationMs }
Executor throws (infra error) →  { ok: false, error: "...", code: "CRASH" }
```

---

## API reference

### Factories

| Export | Signature | Description |
|--------|-----------|-------------|
| `createExecTool` | `(config: ExecToolConfig) → Tool` | Creates the `exec` tool |
| `createExecProvider` | `(config: ExecToolConfig) → ComponentProvider` | Attaches `tool:exec` + `skill:exec-guide` |

### ExecToolConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `executor` | `SandboxExecutor` | *required* | The sandbox backend |
| `defaultTimeoutMs` | `number` | `5000` | Timeout when model omits `timeout_ms` |
| `maxTimeoutMs` | `number` | `30000` | Hard upper bound for timeout |
| `networkAllowed` | `boolean` | `false` | Whether code may make network requests |
| `resourceLimits` | `{ maxMemoryMb?, maxPids? }` | `undefined` | OS-level resource limits |

### Tool input schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | `string` | Yes | Code to execute |
| `input` | `any` | No | JSON data available as `input` variable |
| `timeout_ms` | `number` | No | Execution timeout (clamped to server max) |

### Exports

| Export | Kind | Description |
|--------|------|-------------|
| `createExecTool` | factory | Creates the `exec` Tool directly |
| `createExecProvider` | factory | ComponentProvider attaching tool + skill |
| `EXEC_TOOL_DESCRIPTOR` | const | Tool descriptor (name, schema, description) |
| `EXEC_SKILL` | const | SkillComponent for behavioral guidance |
| `EXEC_SKILL_NAME` | const | `"exec-guide"` |
| `EXEC_SKILL_CONTENT` | const | Skill markdown content |
| `DEFAULT_TIMEOUT_MS` | const | `5000` |
| `MAX_TIMEOUT_MS` | const | `30000` |
| `ExecToolConfig` | type | Configuration interface |

---

## Testing

```bash
bun run --filter @koi/tool-exec test
```

| File | Tests | Coverage |
|------|-------|----------|
| `exec-tool.test.ts` | 24 | Success path, timeout clamping, context passthrough, validation, error forwarding, executor throws |
| `provider.test.ts` | 5 | Provider name, tool attachment, skill attachment, descriptor, caching |

29 tests, 46 assertions.

---

## Design decisions

| Decision | Rationale |
|----------|-----------|
| Delegate to injected `SandboxExecutor` | Backend-agnostic — operator chooses Docker, cloud, OS |
| No tool bridging (`callTool`) | That's `execute_script`'s job. Keep `exec` simple. |
| No console capture | Same — `execute_script` handles that. Minimal surface. |
| JSON `input` parameter | Structured data in, structured data out. Safer than string interpolation. |
| Clamp timeout silently | Don't reject valid requests — just enforce the server limit. |
| Companion skill vs longer description | Skills are injected into system context; descriptions are truncated in tool lists. |
| `trustTier: "sandbox"` | Code runs in isolation — highest sandboxing requirement. |
| Try/catch around executor call | Infrastructure failures (network, deserialization) must not propagate unhandled. |

---

## Layer compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    SandboxExecutor, ExecutionContext, Tool, ToolDescriptor,  │
    SkillComponent, ComponentProvider, skillToken              │
                                                              ▼
L2  @koi/tool-exec ◀─────────────────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ never imports external dependencies
    ✓ all interface properties readonly
    ✓ no enum, class, any, as-assertion, non-null assertion
    ✓ import type for type-only imports
```

---

## Related

- [@koi/code-executor](./code-executor.md) — QuickJS Wasm script execution with `callTool()` bridging
- [@koi/sandbox-executor](./sandbox-executor.md) — trust-tiered executor for forge bricks
- [@koi/core](../../packages/core/) — L0 contract definitions (SandboxExecutor, Tool)
