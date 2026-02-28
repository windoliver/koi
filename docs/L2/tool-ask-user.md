# @koi/tool-ask-user — Structured User Elicitation Tool

Gives agents an `ask_user` tool to ask users structured questions (multi-choice or free-text) mid-execution and block until answered. The tool sends pure data; rendering is the handler's responsibility.

---

## Why It Exists

Agents regularly hit decision points where guessing wastes tokens and risks wrong outcomes. The existing `ApprovalHandler` in middleware only handles yes/no approval — not rich structured questions with multiple options, free-text fallback, or multi-select.

`@koi/tool-ask-user` fills this gap: the LLM calls `ask_user` with a structured question, the agent blocks until the user answers, and the validated response flows back as a tool result the LLM can reason about.

---

## What This Enables

```
WITHOUT ask_user:
═════════════════
  User: "Set up the database"
    │
    ▼
  ┌──────────┐    "I'll use PostgreSQL"     ┌──────────┐
  │  Agent   │─────────────────────────────▶│  Wrong!  │
  │          │   (guessed, user wanted      │  Redo    │
  └──────────┘    SQLite)                   └──────────┘


WITH ask_user:
══════════════
  User: "Set up the database"
    │
    ▼
  ┌──────────┐                              ┌──────────────────┐
  │  Agent   │──── ask_user tool call ─────▶│  Channel / UI    │
  │  (LLM)   │                              │                  │
  │          │                              │  ┌────────────┐  │
  │  blocked │                              │  │ Database?  │  │
  │  waiting │                              │  │            │  │
  │    ...   │                              │  │ ○ Postgres │  │
  │          │                              │  │ ● SQLite   │  │
  │          │                              │  │ ○ MongoDB  │  │
  │          │                              │  │ ○ [Other]  │  │
  │          │◀── { selected: ["SQLite"] }──│  └────────────┘  │
  │          │                              └──────────────────┘
  │ proceeds │
  │ with     │    "Setting up SQLite..."
  │ SQLite   │──────────────────────────────▶ ✓ Correct first time
  └──────────┘
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/tool-ask-user  (L2)                                     │
│                                                               │
│  types.ts             ← config, handler type, tool descriptor │
│  schemas.ts           ← Zod input/response validation         │
│  ask-user-tool.ts     ← tool factory (~80 LOC)                │
│  provider.ts          ← ComponentProvider factory             │
│  index.ts             ← public API surface                    │
│                                                               │
├──────────────────────────────────────────────────────────────┤
│  External deps: zod (via @koi/validation)                     │
│                                                               │
├──────────────────────────────────────────────────────────────┤
│  Internal deps                                                │
│  ● @koi/core (L0)       — types, ToolDescriptor, Tool        │
│  ● @koi/validation (L0u) — validateWith(), zodToKoiError()   │
└──────────────────────────────────────────────────────────────┘
```

### L0 Types (in `@koi/core/elicitation`)

The contract types live in L0 so any layer can reference them:

```typescript
interface ElicitationOption {
  readonly label: string;
  readonly description: string;
}

interface ElicitationQuestion {
  readonly question: string;
  readonly header?: string | undefined;    // ≤12 chars for UI grouping
  readonly options: readonly ElicitationOption[];
  readonly multiSelect?: boolean | undefined;
}

interface ElicitationResult {
  readonly selected: readonly string[];    // labels of chosen options
  readonly freeText?: string | undefined;  // "Other" escape hatch
}
```

### How It Plugs In

```
App / L3                          @koi/tool-ask-user (L2)        Koi Runtime (L1)
┌──────────────────────┐   ┌─────────────────────────┐   ┌────────────────────┐
│ const handler = async│   │ createAskUserProvider({ │   │ createKoi({        │
│   (question, signal) │──▶│   handler,              │──▶│   providers:       │
│   => showModal(...)  │   │   timeoutMs: 300_000,   │   │   [provider]       │
│                      │   │ })                      │   │ })                 │
│ // CLI, Web, Discord │   │                         │   │                    │
│ // etc.              │   │ returns ComponentProvider│   │ Agent now has      │
└──────────────────────┘   └─────────────────────────┘   │ tool:ask_user      │
                                                          └────────────────────┘
  No L1 or L2 imports                                      Middleware chain
  in the handler!                                          fires wrapToolCall()
```

---

## Usage

### Basic — Single Select

```typescript
import { createAskUserProvider } from "@koi/tool-ask-user";
import { createKoi } from "@koi/engine";

const provider = createAskUserProvider({
  handler: async (question, signal) => {
    // Render in your UI, await user response
    const answer = await showQuestionDialog(question, signal);
    return { selected: [answer] };
  },
});

const runtime = await createKoi({
  manifest: { name: "my-agent", model: { name: "claude-haiku-4-5" } },
  adapter,
  providers: [provider],
});
```

### CLI Handler Example

```typescript
import * as readline from "node:readline";

const handler: ElicitationHandler = async (question, signal) => {
  console.log(`\n${question.header ?? "Question"}: ${question.question}`);
  for (const [i, opt] of question.options.entries()) {
    console.log(`  ${String(i + 1)}. ${opt.label} — ${opt.description}`);
  }
  console.log(`  ${String(question.options.length + 1)}. Other (free text)`);

  const rl = readline.createInterface({ input: process.stdin });
  signal.addEventListener("abort", () => rl.close());

  const line = await new Promise<string>((resolve) =>
    rl.question("> ", resolve),
  );
  rl.close();

  const idx = Number.parseInt(line, 10) - 1;
  const picked = question.options[idx];
  if (picked !== undefined) {
    return { selected: [picked.label] };
  }
  return { selected: [], freeText: line };
};
```

### With Custom Limits

```typescript
const provider = createAskUserProvider({
  handler,
  timeoutMs: 60_000,    // 1 minute instead of default 5
  maxOptions: 10,       // allow up to 10 options (default 6)
});
```

---

## Data Flow

```
  LLM generates tool call
         │
         ▼
  ┌─────────────────────────────────────────────┐
  │ 1. Validate input (Zod)                      │
  │    question: string, options: [{label, desc}] │
  │    maxOptions enforced                        │
  │                                               │
  │    ✗ Bad input → { code: "VALIDATION" }       │
  └──────────────────┬────────────────────────────┘
                     │ valid ElicitationQuestion
                     ▼
  ┌─────────────────────────────────────────────┐
  │ 2. Compose AbortSignal                       │
  │    AbortSignal.any([                         │
  │      AbortSignal.timeout(timeoutMs),         │
  │      engine signal (if present),             │
  │    ])                                        │
  └──────────────────┬────────────────────────────┘
                     │
                     ▼
  ┌─────────────────────────────────────────────┐
  │ 3. Call handler(question, composedSignal)     │
  │    ← blocks until user responds               │
  │                                               │
  │    ✗ Signal aborts → { code: "TIMEOUT" }      │
  │    ✗ Handler throws → { code: "EXTERNAL" }    │
  └──────────────────┬────────────────────────────┘
                     │ raw response
                     ▼
  ┌─────────────────────────────────────────────┐
  │ 4. Validate response                         │
  │    • selected labels ∈ options?              │
  │    • multiSelect: false + 2 picks?           │
  │    • empty response (no pick, no text)?      │
  │    • free-text accepted as escape hatch      │
  │                                               │
  │    ✗ Invalid → { code: "VALIDATION" }         │
  └──────────────────┬────────────────────────────┘
                     │ validated ElicitationResult
                     ▼
  ┌─────────────────────────────────────────────┐
  │ 5. Return to LLM as tool result              │
  │    { selected: ["SQLite"], freeText?: ... }  │
  └─────────────────────────────────────────────┘
```

---

## API Reference

### Factories

| Function | Params | Returns |
|----------|--------|---------|
| `createAskUserProvider(config)` | `AskUserConfig` | `ComponentProvider` |
| `createAskUserTool(config)` | `AskUserConfig` | `Tool` |

### AskUserConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `handler` | `ElicitationHandler` | *(required)* | Callback to render question and collect answer |
| `timeoutMs` | `number` | `300,000` (5 min) | Max wait time for user response |
| `maxOptions` | `number` | `6` | Max options per question |

### ElicitationHandler

```typescript
type ElicitationHandler = (
  question: ElicitationQuestion,
  signal: AbortSignal,
) => Promise<ElicitationResult>;
```

### Tool Descriptor (exposed to model)

| Field | Value |
|-------|-------|
| `name` | `"ask_user"` |
| `trustTier` | `"verified"` |
| `required input` | `question` (string), `options` (array of {label, description}) |
| `optional input` | `header` (string, max 12 chars), `multiSelect` (boolean) |

### Error Mapping

```
╔══════════════════════╦══════════════════════════════════════════╦═══════════╗
║ Condition            ║ Tool Returns                             ║ Code      ║
╠══════════════════════╬══════════════════════════════════════════╬═══════════╣
║ Bad model input      ║ { error: "...", code: "VALIDATION" }     ║ VALIDATION║
║ Bad handler response ║ { error: "...", code: "VALIDATION" }     ║ VALIDATION║
║ Signal timeout/abort ║ { error: "User did not respond...",      ║ TIMEOUT   ║
║                      ║   code: "TIMEOUT" }                      ║           ║
║ Handler throws       ║ { error: e.message, code: "EXTERNAL" }  ║ EXTERNAL  ║
║ Valid response       ║ { selected: [...], freeText?: "..." }    ║ (none)    ║
╚══════════════════════╩══════════════════════════════════════════╩═══════════╝
```

### Constants

| Constant | Value |
|----------|-------|
| `DEFAULT_TIMEOUT_MS` | `300_000` (5 min) |
| `DEFAULT_MAX_OPTIONS` | `6` |
| `ASK_USER_TOOL_DESCRIPTOR` | Tool descriptor object |

---

## Testing

```
ask-user-tool.test.ts — 18 tests
  Happy path:
  ● Returns selected option for valid single-select question
  ● Returns multiple selections for multi-select question
  ● Returns free-text response
  ● Accepts multiSelect: true with single selection

  Input validation:
  ● Returns VALIDATION for missing question
  ● Returns VALIDATION for empty options
  ● Returns VALIDATION when options exceed maxOptions
  ● Returns VALIDATION for invalid option shape
  ● Returns VALIDATION when header exceeds 12 chars

  Response validation:
  ● Returns VALIDATION when selected label not in options
  ● Returns VALIDATION for multiSelect false with two selections
  ● Returns VALIDATION for empty response

  Timeout/cancellation:
  ● Returns TIMEOUT when handler takes too long
  ● Returns TIMEOUT when engine signal aborts

  Error handling:
  ● Returns EXTERNAL when handler throws Error
  ● Returns EXTERNAL for non-Error throws

  Edge cases:
  ● Handles duplicate labels gracefully
  ● Uses default maxOptions of 6

schemas.test.ts — 16 tests
  ● Input parsing (valid, optional fields, missing fields, extra fields)
  ● maxOptions enforcement
  ● Response validation (single, multi, free-text, empty, unknown labels)

e2e.test.ts — 10 tests (gated on E2E_TESTS=1 + API key)
  Stack A (createLoopAdapter):
  ● Tool attached and directly invocable through createKoi
  ● Multi-select through full L1 runtime
  ● Free-text response flows through L1 runtime
  ● Timeout through L1 runtime
  ● Handler error propagates as EXTERNAL
  ● Invalid input returns VALIDATION

  Stack B (createPiAdapter — real LLM round-trip):
  ● LLM calls ask_user and incorporates the answer
  ● Middleware chain intercepts ask_user call
  ● Session lifecycle hooks fire correctly
  ● Free-text response flows through full Pi round-trip
```

```bash
# Unit + schema tests
bun --cwd packages/tool-ask-user test

# E2E with real LLM
E2E_TESTS=1 bun --cwd packages/tool-ask-user test src/__tests__/e2e.test.ts
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Handler injection (callback) | Same pattern as `task-spawn`'s `SpawnFn`. Keeps the tool free of UI/transport concerns. A CLI renders a prompt; a web app renders a modal; Discord renders buttons — same tool contract |
| Single question per call | KISS. Multi-question complicates validation, rendering, and error handling. The LLM can call the tool multiple times if it needs several answers |
| Promise-based blocking | Natural `await` semantics. No polling, no callbacks, no event emitters |
| `AbortSignal.any()` composition | Combines tool timeout + engine signal into one. If the engine is disposed, in-flight questions are cancelled immediately |
| Schema built once, reused | `createQuestionSchema(maxOptions)` runs at tool creation, not per invocation. Avoids re-allocating the refined Zod schema on every `execute()` call |
| Free-text as escape hatch | Users can always type "Other". This prevents the tool from being a blocker when the LLM doesn't offer the right options |
| Response validation is strict | Selected labels must match question options. Prevents hallucinated responses from passing through. Free-text bypasses this check intentionally |
| `TimeoutError` + `AbortError` both caught | Bun's `AbortSignal.timeout()` throws `TimeoutError` (not `AbortError`). Both are caught and mapped to `code: "TIMEOUT"` |
| L0 types in `@koi/core/elicitation` | Any layer can reference `ElicitationQuestion`/`ElicitationResult` — middleware, channels, or other tools can consume these types without importing L2 |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────┐
    ElicitationOption, ElicitationQuestion,           │
    ElicitationResult, ToolDescriptor, Tool,          │
    JsonObject, Result, KoiError                      │
                                                      │
L0u @koi/validation ─────────────────────────────┐   │
    validateWith(), zodToKoiError()               │   │
                                                  ▼   ▼
L2  @koi/tool-ask-user ◄─────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ All interface properties readonly
    ✓ Returns error objects (never throws for expected failures)
    ✓ import type for type-only imports
    ✓ .js extensions on all local imports
    ✓ No enum, any, namespace, as Type, ! in production code
```
