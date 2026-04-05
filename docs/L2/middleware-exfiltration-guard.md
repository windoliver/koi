# @koi/middleware-exfiltration-guard — Secret Exfiltration Prevention

Scans tool inputs and model outputs for secret exfiltration attempts (base64-encoded,
URL-encoded, or raw secrets). Blocks, redacts, or warns before secrets leave the system.

---

## Why it exists

`@koi/redaction` masks secrets in **logs and telemetry**. But model **responses** and
**tool call arguments** are not scanned — an agent can exfiltrate secrets by:

- Base64-encoding an API key in a `web_fetch` URL argument
- URL-encoding credentials in fetch targets
- Prompt injection tricking the model into leaking secrets via tool outputs
- Reading credential files and passing contents to external tools

This middleware closes the gap by scanning tool I/O and model output for secret patterns,
including encoded variants.

---

## Architecture

### Layer position

```
L0  @koi/core           KoiMiddleware, ToolRequest, ModelChunk
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

- `@koi/core` (L0) — `KoiMiddleware`, `ToolRequest`, `ToolResponse`, `ModelChunk`, `TurnContext`
- `@koi/redaction` (L0u) — `createRedactor`, `createAllSecretPatterns`, `createDecodingDetectors`
- `@koi/errors` (L0u) — `KoiRuntimeError`

No L2 peer dependencies. No external dependencies.

---

## How it works

### Priority and phase

- **Priority: 50** — runs before permissions middleware (100), before any tool authorization
- **Phase: "intercept"** — mutates or blocks requests

### Two interception points

#### 1. `wrapToolCall` — scan tool arguments

Before tool execution, scans `request.input` (JSON object) for secrets:

- Runs `redactor.redactObject(request.input)` with all 13 built-in detectors plus
  base64-decoding and URL-decoding decorator detectors
- If secrets detected: action determines behavior (block/redact/warn)
- If redaction fails (secretCount === -1): fail-closed, treated as block

#### 2. `wrapModelStream` — scan model output

Buffers `text_delta` chunks and scans accumulated text for secret patterns:

- On `done` chunk: scan buffer via `redactor.redactString(buffer)`
- If secrets found: action determines behavior
- Buffer capped at `maxStringLength` to prevent memory pressure

### Action modes

| Action | `wrapToolCall` | `wrapModelStream` |
|--------|---------------|-------------------|
| `block` | Return error response, skip tool | Yield error chunk |
| `redact` | Call tool with redacted input | Yield redacted text |
| `warn` | Call tool unchanged, fire event | Yield unchanged, fire event |

### Fail-closed semantics

- Redaction engine failure → block (never allow unscanned content through)
- Buffer overflow → block if action is block, warn otherwise

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
  readonly location: "tool-input" | "model-output";
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

// Default: block on detection
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
```

---

## Tests

- Tool call with base64-encoded AWS key in URL argument is blocked
- Tool call with URL-encoded bearer token in fetch target is blocked
- Model response containing raw API key triggers warning
- Legitimate base64 content (images, data) is not false-positive blocked
- Configurable action (block/redact/warn) works for each interception point
- Fail-closed: redaction engine failure triggers block
- `onDetection` callback fires with correct event shape
- Clean inputs pass through unchanged
