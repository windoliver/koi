# @koi/hook-prompt — Single-Shot LLM Verification Hook

Lightweight prompt hook executor that makes a single LLM call (~100-200 tokens) for pass/fail verification. Fills the gap between static hooks (command/http) and expensive agent hooks (4000+ tokens).

---

## Why It Exists

Command and HTTP hooks can only run static checks. Agent hooks spawn a full LLM loop with tools, which is expensive and slow. Many verification tasks ("Is this tool call safe?", "Does this match policy?") need LLM judgment but not tool access. `@koi/hook-prompt` provides a single-shot LLM call that returns a structured `{ "ok": true/false, "reason": "..." }` verdict.

---

## What This Enables

- **Safety gating**: verify tool calls or model actions before execution
- **Policy checks**: lightweight LLM-based policy evaluation
- **Audit hooks**: quick pass/fail classification of events
- **Cost-efficient verification**: ~100-200 tokens vs 4000+ for agent hooks

---

## Core Contract

```typescript
import { createPromptExecutor } from "@koi/hook-prompt";

const executor = createPromptExecutor(modelCaller);
const decision = await executor.execute(promptHookConfig, hookEvent);
// decision: { kind: "continue" } | { kind: "block", reason: string }
```

The executor:
1. Sends the hook's prompt + event context to the model
2. Parses the response as structured JSON verdict
3. Returns a `HookDecision` (`continue` or `block`)

---

## Verdict Parsing

The parser handles common LLM output formats:
- **Structured JSON**: `{ "ok": true/false, "reason": "..." }` (preferred)
- **Code-fenced JSON**: `` ```json { "ok": true } ``` ``
- **Embedded JSON**: extracts from preamble/postamble text
- **String boolean coercion**: `"true"`/`"false"` treated as boolean intent
- **Plain-text denial**: explicit denial language always blocks (fail-safe)
- **Ambiguous output**: throws `VerdictParseError` → routed through `failClosed`

---

## Failure Behavior

Controlled by `PromptHookConfig.failClosed` (default: `true`):
- `true`: parse failures block the action
- `false`: parse failures allow the action (fail-open)

Plain-text denials always block regardless of `failClosed` setting.
