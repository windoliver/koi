# @koi/middleware-exfiltration-guard — Secret Exfiltration Prevention

Scans tool inputs, tool outputs, and model outputs (streaming + non-streaming) for
secret exfiltration attempts (base64-encoded, URL-encoded, or raw secrets). Blocks,
redacts, or warns before secrets leave the system.

---

## Why it exists

`@koi/redaction` masks secrets in **logs and telemetry**. But model **responses** and
**tool call arguments** are not scanned — an agent can exfiltrate secrets by:

- Base64-encoding an API key in a `web_fetch` URL argument
- URL-encoding credentials in fetch targets
- Prompt injection tricking the model into leaking secrets via tool outputs
- Reading credential files and passing contents to external tools
- Returning secrets in tool response output (e.g., `fs_read` of `.env`)

This middleware closes the gap by scanning tool I/O (input + output) and model output
for secret patterns, including encoded variants.

---

## Architecture

### Layer position

```
L0  @koi/core           KoiMiddleware, ToolRequest, ModelChunk, ModelResponse
L0u @koi/redaction       createRedactor(), SecretPattern, decoding detectors
L0u @koi/errors          KoiRuntimeError
L2  @koi/middleware-exfiltration-guard  ← this package
```

### Internal module map

```
src/
  index.ts              public re-exports
  config.ts             ExfiltrationGuardConfig, ExfiltrationAction, validation
  middleware.ts          createExfiltrationGuardMiddleware() factory
```

### Dependencies

- `@koi/core` (L0) — `KoiMiddleware`, `ToolRequest`, `ToolResponse`, `ModelChunk`, `ModelResponse`, `TurnContext`
- `@koi/redaction` (L0u) — `createRedactor`, `createAllSecretPatterns`, `createDecodingDetectors`
- `@koi/errors` (L0u) — `KoiRuntimeError`

No L2 peer dependencies. No external dependencies.

---

## How it works

### Priority and phase

- **Priority: 50** — runs before permissions middleware (100), before any tool authorization
- **Phase: "intercept"** — mutates or blocks requests

### Default runtime installation

`createRuntime()` installs this middleware **by default** when the adapter has terminals.
Configurable via `RuntimeConfig.exfiltrationGuard` (`false` to disable, partial config
to customize). Explicit config on terminal-less adapters throws (fail-closed).

### Three interception points

#### 1. `wrapToolCall` — scan tool arguments (input) and tool responses (output)

**Input scanning** (gated by `scanToolInput`):
- Runs `redactor.redactObject(request.input)` with all 13 built-in detectors plus
  base64-decoding and URL-decoding decorator detectors
- If secrets detected: action determines behavior (block/redact/warn)
- If redaction fails (secretCount === -1): fail-closed, treated as block

**Output scanning** (always-on, independent of `scanToolInput`):
- After tool execution, scans `response.output` via both `JSON.stringify` and `String()`
  representations to catch secrets hidden by `toJSON()` or non-enumerable properties
- Non-serializable outputs use `deepExtractStrings()` (cycle-safe recursive walk, depth 5)
- If redaction fails: fail-closed
- `ExfiltrationEvent.location` is `"tool-output"` for response-side detections

#### 2. `wrapModelCall` — scan non-streaming model responses

Scans both `response.content` and `response.richContent` (tool_call args, thinking):
- If secrets found in block mode: returns `sanitizeModelResponse()` with `hook_blocked`
  stopReason, cleared `richContent`
- Redact mode: redacts content text, clears `richContent`

#### 3. `wrapModelStream` — scan streaming model output

Buffers all content-bearing chunk kinds for scanning:
- `text_delta`, `thinking_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`
- Tracks `textOnlyBuffer` separately for redact-safe output (never leaks hidden content)
- On `done` chunk: scans buffer, also scans `done.response` payload for secrets not in deltas
- Sanitizes `done` chunk in redact/block mode (clears `response.content` and `richContent`)

**Buffer overflow handling:**
- Block mode: yield error, return (fail-closed)
- Redact mode: emit redacted `textOnlyBuffer` + truncation notice, suppress remainder
- Warn mode: replay held chunks (preserves tool_call structure), pass-through remainder

**Truncated streams** (no `done` chunk): block/redact/warn per normal semantics

### Action modes

| Action | `wrapToolCall` input | `wrapToolCall` output | `wrapModelCall` | `wrapModelStream` |
|--------|---------------------|----------------------|-----------------|-------------------|
| `block` | Return error, skip tool | Return error after exec | Replace content, `hook_blocked` | Yield error chunk |
| `redact` | Call tool with redacted input | Block (can't safely redact structured output) | Redact content, clear `richContent` | Yield redacted `textOnlyBuffer` |
| `warn` | Call tool unchanged, fire event | Return unchanged, fire event | Return unchanged, fire event | Replay held chunks, fire event |

### Fail-closed semantics

- Redaction engine failure → block (never allow unscanned content through)
- Buffer overflow in block mode → yield error
- Buffer overflow in redact mode → emit scanned text + truncation, suppress remainder
- Truncated stream → same block/redact/warn semantics as done path
- Non-serializable tool output → `deepExtractStrings()` fallback, never hard-block on shape alone

---

## API

### Types

```typescript
type ExfiltrationAction = "block" | "redact" | "warn";

interface ExfiltrationGuardConfig {
  readonly action: ExfiltrationAction;                          // default: "block"
  readonly customPatterns?: readonly SecretPattern[];            // additional patterns
  readonly onDetection?: (event: ExfiltrationEvent) => void;    // observability callback
  readonly maxStringLength?: number;                            // default: 100_000
  readonly scanToolInput?: boolean;                             // default: true
  readonly scanModelOutput?: boolean;                           // default: true
}

interface ExfiltrationEvent {
  readonly location: "tool-input" | "tool-output" | "model-output";
  readonly toolId?: string;
  readonly matchCount: number;
  readonly kinds: readonly string[];
  readonly action: ExfiltrationAction;
}
```

### Functions

| Function | Signature | Purpose |
|----------|-----------|---------|
| `createExfiltrationGuardMiddleware` | `(config?: Partial<ExfiltrationGuardConfig>) => KoiMiddleware` | Factory — main entry point |
| `validateExfiltrationGuardConfig` | `(input: unknown) => Result<ExfiltrationGuardConfig>` | Config validation |

---

## Configuration

```typescript
import { createExfiltrationGuardMiddleware } from "@koi/middleware-exfiltration-guard";

// Default: block on detection (installed automatically by createRuntime)
const guard = createExfiltrationGuardMiddleware();

// Warn-only with custom callback
const guard = createExfiltrationGuardMiddleware({
  action: "warn",
  onDetection: (event) => auditSink.record({ kind: "exfiltration", ...event }),
});

// Redact with additional custom patterns
const guard = createExfiltrationGuardMiddleware({
  action: "redact",
  customPatterns: [myInternalTokenDetector],
});

// Disable via RuntimeConfig
const runtime = createRuntime({ exfiltrationGuard: false });
```

---

## Tests

- Tool call with base64-encoded AWS key in URL argument is blocked
- Tool output containing AWS key is blocked (tool-output scanning)
- Structured tool output with secret only in `String()` representation (Error object) is blocked
- Non-streaming model response containing secrets is blocked (`wrapModelCall`)
- Model response `richContent` is cleared and `stopReason` set to `hook_blocked`
- Streaming model output with secrets in buffer is blocked/redacted
- Buffer overflow: block yields error, redact emits `textOnlyBuffer`, warn replays held chunks
- Truncated streams fail-closed in block mode
- `onDetection` callback fires with correct event shape and `"tool-output"` location
- Clean inputs/outputs pass through unchanged
- Trajectory fixture validates ATIF v1.6 with blocking semantics (nextCalled=false, no tool steps)
