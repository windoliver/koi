# @koi/redaction — Structured Secret Masking

`@koi/redaction` is an L0u package that masks secrets (API keys, credentials, tokens)
in strings and structured objects before they reach logs, audit sinks, or user-facing
channels. It ships 13 built-in pattern detectors and supports custom patterns.

---

## Why it exists

Agent systems routinely pass API keys, bearer tokens, and connection strings through
tool calls, model responses, and audit entries. Without redaction, secrets leak into
logs, dashboards, and third-party sinks.

```
Without redaction:

  audit entry → { "headers": { "Authorization": "Bearer sk-ant-api03-REAL_KEY" } }
  log line    → "Connecting to postgres://admin:s3cret@db.internal:5432/prod"

With redaction:

  audit entry → { "headers": { "Authorization": "[REDACTED:bearer]" } }
  log line    → "Connecting to [REDACTED:credential_uri]"
```

This package solves three problems:

1. **Pattern-based detection** — 13 detectors for common secret formats (AWS, GitHub, Stripe, JWT, PEM, etc.)
2. **Field-name matching** — flags values in fields named `password`, `secret`, `token`, etc. regardless of content
3. **Fail-closed safety** — if redaction itself throws, the output is replaced with `[REDACTION_FAILED]` rather than leaking the original

---

## Architecture

### Layer position

```
L0  @koi/core          ─ KoiMiddleware, AuditSink (contracts)
L0u @koi/redaction      ─ createRedactor(), 13 SecretPattern detectors
L2  @koi/middleware-pii  ─ PII detection (emails, SSNs, phone numbers — complements redaction)
L3  @koi/governance      ─ Composes redaction + PII + sanitize into a single stack
```

### Relationship to governance

`@koi/governance` wires `@koi/redaction` as an optional configuration field:

```typescript
import { createGovernanceStack } from "@koi/governance";

// Redaction enabled automatically with standard/strict presets
const { redactor } = createGovernanceStack({ preset: "standard" });

// Or configure explicitly
const { redactor } = createGovernanceStack({
  redaction: { censor: "mask" },  // Partial<RedactionConfig>
});

// Use the compiled redactor directly
if (redactor) {
  const result = redactor.redactString(logLine);
  // result.text → masked string
  // result.changed → whether any secrets were found
}
```

The `standard` and `strict` presets enable redaction with default config (all 13 detectors,
`"redact"` censor strategy). The `open` preset does not enable redaction.

### Standalone usage

```typescript
import { createRedactor } from "@koi/redaction";

const redactor = createRedactor();  // all defaults

// String redaction
const { text, changed, matchCount } = redactor.redactString(
  "key=sk-ant-api03-abc123..."
);
// text → "key=[REDACTED:anthropic]"

// Object redaction (deep, recursive)
const { value, secretCount, fieldCount } = redactor.redactObject({
  config: { apiKey: "sk-live-abc", password: "hunter2" },
});
// value.config.apiKey → "[REDACTED:stripe]"
// value.config.password → "[REDACTED:field:password]"
```

---

## Built-in detectors

| Detector | Matches |
|----------|---------|
| Anthropic | `sk-ant-api03-*` keys |
| AWS | `AKIA*` access keys, long secret keys |
| Basic Auth | `Basic <base64>` headers |
| Bearer | `Bearer <token>` headers |
| Credential URI | `scheme://user:pass@host` connection strings |
| Generic Secret | `secret=`, `token=`, `apikey=` in query strings |
| GitHub | `ghp_*`, `gho_*`, `ghs_*`, `ghr_*` tokens |
| Google | `AIza*` API keys |
| JWT | `eyJ*` three-segment tokens |
| OpenAI | `sk-*` API keys |
| PEM | `-----BEGIN * PRIVATE KEY-----` blocks |
| Slack | `xoxb-*`, `xoxp-*`, `xapp-*` tokens |
| Stripe | `sk_live_*`, `rk_live_*` keys |

---

## Configuration

All fields in `RedactionConfig` are optional (defaults are sensible):

| Field | Default | Description |
|-------|---------|-------------|
| `patterns` | All 13 detectors | Pattern detectors to apply |
| `customPatterns` | `[]` | Additional user-defined detectors |
| `fieldNames` | Common secret field names | Field names triggering value redaction |
| `censor` | `"redact"` | Strategy: `"redact"`, `"mask"`, `"remove"`, or custom function |
| `fieldCensor` | `"redact"` | Strategy for field-name matches |
| `maxDepth` | `10` | Max object traversal depth |
| `maxStringLength` | `100_000` | Skip strings longer than this |
| `onError` | `undefined` | Callback for redaction errors |

---

## What this enables

- **Safe audit logging** — governance audit middleware can log full tool call payloads without leaking secrets
- **Dashboard safety** — agent dashboard and debug views can display tool results without exposing credentials
- **Multi-tenant isolation** — redact secrets before events cross agent boundaries via gateway or federation
- **Compliance** — satisfies SOC 2 / GDPR requirements for secret handling in logs
- **Defense in depth** — complements PII middleware (which handles personal data) with secret-specific detection
