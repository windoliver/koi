# @koi/middleware-tool-recovery — Text-Based Tool Call Recovery

Recovers structured tool calls from text patterns in model responses, enabling Koi's tool-calling ecosystem to work with any model — including open-source models served via Ollama, vLLM, and LM Studio that lack native tool calling.

---

## Why It Exists

Open-source models (Llama, Hermes, Mistral, Phi, etc.) often can't produce structured tool calls via API. Instead, they embed tool calls as text patterns: XML tags, JSON in code fences, or custom markup. Without recovery, these models are limited to text-only output and can't use Koi's tool ecosystem.

This middleware solves three problems:

1. **No structured tool calls** — open-source models output tool calls as text, which the engine loop ignores
2. **Vendor lock-in** — without recovery, only models with native tool-calling APIs (OpenAI, Anthropic) can use tools
3. **Downstream middleware blindness** — sanitize, PII, audit middleware can't see tool calls hidden in plain text

---

## Architecture

`@koi/middleware-tool-recovery` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0u (`@koi/errors`). Zero external dependencies.

```
┌────────────────────────────────────────────────────────┐
│  @koi/middleware-tool-recovery  (L2)                    │
│                                                        │
│  types.ts             ← 4 domain types                 │
│  config.ts            ← config interface + validation  │
│  parse.ts             ← pattern orchestration          │
│  recovery-middleware.ts ← middleware factory            │
│  patterns/                                             │
│    hermes.ts          ← <tool_call> XML pattern        │
│    llama31.ts         ← <function=NAME> pattern        │
│    json-fence.ts      ← ```json code fence pattern     │
│    registry.ts        ← name → pattern resolution      │
│  index.ts             ← public API surface             │
│                                                        │
├────────────────────────────────────────────────────────┤
│  Dependencies                                          │
│                                                        │
│  @koi/core    (L0)   KoiMiddleware, ModelRequest,      │
│                       ModelResponse, TurnContext,       │
│                       CapabilityFragment, JsonObject    │
│  @koi/errors  (L0u)  RETRYABLE_DEFAULTS               │
└────────────────────────────────────────────────────────┘
```

---

## How It Works

### Phase 1: wrapModelCall Only

The middleware intercepts model responses, scans for text patterns, and promotes matched tool calls into `metadata.toolCalls` — the same format native tool-calling models produce.

```
Model Response (text with embedded tool calls)
                  │
                  ▼
┌──────────────────────────────────────────────────────────┐
│  tool-recovery middleware (priority 180)                   │
│                                                           │
│  1. Short-circuit checks (3 exits):                       │
│     ├── No tools in request?     → pass through           │
│     ├── Already has toolCalls?   → pass through           │
│     └── No pattern matches?      → pass through           │
│                                                           │
│  2. Pattern scan (first match wins):                      │
│     ├── Hermes:     <tool_call>JSON</tool_call>           │
│     ├── Llama 3.1:  <function=NAME>JSON</function>        │
│     └── JSON fence: ```json ... ```                       │
│                                                           │
│  3. Validate tool names against request.tools allowlist   │
│                                                           │
│  4. Cap at maxToolCallsPerResponse (default: 10)          │
│                                                           │
│  5. Generate deterministic IDs: recovery-{turnId}-{index} │
│                                                           │
│  6. Return modified response:                             │
│     content:  remaining text (tags stripped)               │
│     metadata: { toolCalls: [...structured calls] }        │
└──────────────────────────────────────────────────────────┘
                  │
                  ▼
    Downstream middleware sees clean structured data
    Engine loop finds toolCalls → executes them
```

### Data Flow

```
┌───────────────────────────────────────────────────────────────┐
│  Model (Ollama / vLLM / LM Studio)                            │
│                                                               │
│  "I'll check the weather.                                     │
│   <tool_call>{"name":"get_weather",                           │
│   "arguments":{"city":"Tokyo"}}</tool_call>"                  │
└────────────────────────┬──────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│  BEFORE (ModelResponse)                                        │
│                                                                │
│  content:   "I'll check the weather.\n<tool_call>..."          │
│  metadata:  { }                                                │
│  model:     "llama3.1:8b"                                      │
├────────────────────────────────────────────────────────────────┤
│  AFTER (ModelResponse)                                         │
│                                                                │
│  content:   "I'll check the weather."                          │
│  metadata:  {                                                  │
│    toolCalls: [{                                               │
│      toolName: "get_weather",                                  │
│      callId:   "recovery-run1:t0-0",                           │
│      input:    { city: "Tokyo" }                               │
│    }]                                                          │
│  }                                                             │
│  model:     "llama3.1:8b"                                      │
└────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│  Engine Loop (loop-adapter.ts)                                 │
│                                                                │
│  extractToolCalls(response)                                    │
│  → finds metadata.toolCalls                                    │
│  → executes get_weather({ city: "Tokyo" })                     │
│  → appends result to conversation                              │
│  → next model turn                                             │
└────────────────────────────────────────────────────────────────┘
```

---

## 3 Built-In Patterns

Each pattern compiles its regex once at factory time and uses `String.matchAll()` at call time.

### Hermes

Used by: NousResearch Hermes models, ChatML-based fine-tunes.

```
Input text:
  <tool_call>{"name": "search", "arguments": {"q": "koi"}}</tool_call>

Regex: /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g

Parsed:
  toolName:  "search"
  arguments: { q: "koi" }
```

### Llama 3.1

Used by: Meta Llama 3.1+ instruction-tuned models.

```
Input text:
  <function=search>{"q": "koi"}</function>

Regex: /<function=([^>]+)>([\s\S]*?)<\/function>/g

Parsed:
  toolName:  "search"           ← from attribute
  arguments: { q: "koi" }      ← from body
```

### JSON Fence

Used by: Various models that output tool calls in markdown code fences.

```
Input text:
  ```json
  {"name": "search", "arguments": {"q": "koi"}}
  ```

Regex: /```(?:json)?\s*\n([\s\S]*?)\n\s*```/g

Parsed:
  toolName:  "search"
  arguments: { q: "koi" }

Note: Only fences containing JSON with both "name" and "arguments"
fields are treated as tool calls. Other JSON fences are skipped.
```

### Custom Patterns

Any object implementing `ToolCallPattern` can be passed in config:

```typescript
interface ToolCallPattern {
  readonly name: string;
  readonly detect: (text: string) => RecoveryResult | undefined;
}
```

---

## Middleware Position (Onion)

Priority 180 = outer layer. Runs before sanitize, PII, and audit so they see clean structured data.

```
              Incoming Model Call
                     │
                     ▼
        ┌───────────────────────┐
     ┌──│  tool-recovery        │──┐  priority: 180 (THIS)
     │  │  (text → toolCalls)   │  │
     │  ├───────────────────────┤  │
     │  │  middleware-sandbox    │  │  priority: 200
     │  ├───────────────────────┤  │
     │  │  middleware-compactor  │  │  priority: 225
     │  ├───────────────────────┤  │
     │  │  middleware-sanitize   │  │  priority: 350
     │  ├───────────────────────┤  │
     │  │  middleware-audit      │  │  priority: 450
     │  ├───────────────────────┤  │
     │  │  engine adapter       │  │
     │  │  → LLM API call       │  │
     │  └───────────┬───────────┘  │
     │        Response             │
     │              │              │
     └──────────────┴──────────────┘
     tool-recovery sees raw text,
     converts to structured calls
     before any other middleware
```

---

## API Reference

### Factory Functions

#### `createToolRecoveryMiddleware(config?)`

Creates the middleware with pattern-based tool call recovery.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.patterns` | `readonly (string \| ToolCallPattern)[]` | `["hermes", "llama31", "json-fence"]` | Pattern names or custom pattern objects |
| `config.maxToolCallsPerResponse` | `number` | `10` | Maximum tool calls to extract per response |
| `config.onRecoveryEvent` | `(event: RecoveryEvent) => void` | — | Callback for recovery observability events |

**Returns:** `KoiMiddleware`

#### `validateToolRecoveryConfig(config)`

Runtime config validation. Returns `Result<ToolRecoveryConfig, KoiError>`.

#### `resolvePatterns(entries)`

Resolves mixed array of pattern name strings and custom `ToolCallPattern` objects into concrete pattern instances. Throws on unknown pattern names.

### Interfaces

#### `ToolCallPattern`

```typescript
interface ToolCallPattern {
  readonly name: string;
  readonly detect: (text: string) => RecoveryResult | undefined;
}
```

#### `RecoveryResult`

```typescript
interface RecoveryResult {
  readonly toolCalls: readonly ParsedToolCall[];
  readonly remainingText: string;
}
```

#### `ParsedToolCall`

```typescript
interface ParsedToolCall {
  readonly toolName: string;
  readonly arguments: JsonObject;
}
```

### Types

| Type | Description |
|------|-------------|
| `ToolRecoveryConfig` | Config for `createToolRecoveryMiddleware()` |
| `ToolCallPattern` | Named pattern with `detect()` function |
| `RecoveryResult` | Extracted tool calls + remaining text |
| `ParsedToolCall` | Tool name + arguments from parsed text |
| `RecoveryEvent` | Discriminated union: `recovered \| rejected \| parse_error` |

### RecoveryEvent Variants

| Kind | Fields | When |
|------|--------|------|
| `recovered` | `pattern`, `toolCalls` | Tool calls successfully extracted |
| `rejected` | `toolName`, `reason` | Tool name not in allowed set |
| `parse_error` | `pattern`, `raw`, `error` | JSON parse failed |

---

## Examples

### Basic Usage (All Patterns)

```typescript
import { createToolRecoveryMiddleware } from "@koi/middleware-tool-recovery";

const recovery = createToolRecoveryMiddleware();

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [recovery],
});
```

### Single Pattern

```typescript
const recovery = createToolRecoveryMiddleware({
  patterns: ["hermes"],
});
```

### With Custom Pattern

```typescript
import type { ToolCallPattern } from "@koi/middleware-tool-recovery";

const reactPattern: ToolCallPattern = {
  name: "react",
  detect(text) {
    const match = /Action:\s*(\w+)\nAction Input:\s*(\{.*\})/s.exec(text);
    if (match === null) return undefined;
    const args = JSON.parse(match[2] ?? "{}") as Record<string, unknown>;
    return {
      toolCalls: [{ toolName: match[1] ?? "", arguments: args }],
      remainingText: text.replace(match[0], "").trim(),
    };
  },
};

const recovery = createToolRecoveryMiddleware({
  patterns: ["hermes", reactPattern],
});
```

### With Observability

```typescript
const recovery = createToolRecoveryMiddleware({
  onRecoveryEvent(event) {
    switch (event.kind) {
      case "recovered":
        console.log(`[recovery] ${event.pattern}: ${event.toolCalls.length} calls`);
        break;
      case "rejected":
        console.log(`[recovery] rejected: ${event.toolName} — ${event.reason}`);
        break;
      case "parse_error":
        console.log(`[recovery] parse error in ${event.pattern}: ${event.error}`);
        break;
    }
  },
});
```

### With Other Middleware

```typescript
const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [
    createToolRecoveryMiddleware(),            // priority: 180 (outermost)
    createSanitizeMiddleware({ ... }),          // priority: 350
    createToolAuditMiddleware({ ... }),         // priority: 100
  ],
});
// Priority ordering is automatic — tool-recovery runs before sanitize
```

---

## Hot Path Performance

The middleware adds near-zero overhead on the common case (native tool-calling models):

```
wrapModelCall:
  │
  ├── no tools in request?       → return next(request)    [zero cost]
  │
  ├── response has toolCalls?    → return response         [zero cost]
  │
  └── has tools, no native calls → pattern scan
       │
       ├── Regex: compiled once at factory, reused via matchAll()
       ├── Patterns: first match wins (no multi-pattern scan)
       ├── Allowlist: Set.has() per matched call — O(1)
       └── Cap: slice if over limit — O(1)

       Cost: O(n) where n = response content length
       Typical: < 1ms for responses under 10KB
```

**Short-circuit path (native tool-calling models):** ~0ns — two property checks, no regex.

**Recovery path (open-source models):** One regex scan via `matchAll()`, JSON.parse per match, Set.has per tool name. All regex compiled once at middleware creation, not per-call.

**Memory:** No persistent state. No per-session allocations. Each call creates a small array of parsed tool calls (capped at `maxToolCallsPerResponse`), garbage collected immediately.

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────────┐
    KoiMiddleware, ModelRequest, ModelResponse,            │
    TurnContext, CapabilityFragment, JsonObject             │
                                                           │
L0u @koi/errors ─────────────────────────────────┐        │
    RETRYABLE_DEFAULTS                            │        │
                                                   ▼        ▼
L2  @koi/middleware-tool-recovery ◄────────────────┴───────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```

**Dev-only dependency** (`@koi/test-utils`) is used in tests but is not a runtime import.

---

## Phase 2 (Out of Scope)

- `wrapModelStream` — streaming recovery with buffer/flush state machine
- Additional built-in patterns (Mistral, Phi, InternLM, ReAct, Pythonic)
- Automatic pattern detection from model metadata
