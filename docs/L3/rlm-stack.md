# @koi/rlm-stack — Code-Execution RLM Bundle

Wires `@koi/code-executor` (QuickJS WASM sandbox) into `@koi/middleware-rlm` so the model writes JavaScript code to analyze large inputs instead of calling predefined tools. One-call factory returns a `MiddlewareBundle` ready for agent assembly.

## Usage

```typescript
import { createRlmStack } from "@koi/rlm-stack";

const { middleware, providers } = createRlmStack({
  contextWindowTokens: 128_000,
  maxIterations: 30,
  scriptTimeoutMs: 30_000,   // per-execution timeout
  scriptMaxCalls: 100,       // max host function calls per execution
});
```

## Configuration

`RlmStackConfig` extends `RlmMiddlewareConfig` (see `docs/L2/middleware-rlm.md`) with:

| Field | Default | Description |
|-------|---------|-------------|
| `scriptTimeoutMs` | 30,000 | Timeout per script execution in ms |
| `scriptMaxCalls` | 100 | Max host function calls per execution |

All `RlmMiddlewareConfig` fields are supported (`maxIterations`, `contextWindowTokens`, `rootModel`, `subCallModel`, etc.).

## Architecture

```
@koi/rlm-stack (L3)
  ├── @koi/middleware-rlm (L2) — REPL loop, system prompt, history management
  └── @koi/code-executor (L2) — QuickJS WASM sandbox execution
```

The stack creates an `RlmScriptRunner` adapter that wraps `executeScript` from `@koi/code-executor`, then passes it to `createRlmBundle` from `@koi/middleware-rlm`.
