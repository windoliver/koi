# @koi/governance-security

Layer: **L2** — Security analysis helpers for governance pipelines.

## Purpose

Pure analysis utilities — no middleware, no side effects. Provides:

- **Static injection detection** via pattern-matched `SecurityAnalyzer`
- **PII detection** for email, US SSN, and API key patterns
- **Dynamic anomaly monitoring** counting tool-call rate, error spikes, repeated tools, and denied calls per turn
- **Security scoring** that aggregates `RiskAnalysis` + `AnomalySignal[]` into a 0–100 numeric score

## Public API

### Static Analysis

```ts
import {
  createRulesAnalyzer,
  createCompositeAnalyzer,
  maxRiskLevel,
  BUILTIN_RULES,
} from "@koi/governance-security";
import type { RulesAnalyzerConfig, PatternRule } from "@koi/governance-security";
```

`createRulesAnalyzer(config?: RulesAnalyzerConfig): SecurityAnalyzer`
Returns a synchronous `SecurityAnalyzer` (satisfies the `@koi/core` interface). Matches
`BUILTIN_RULES` plus any `extraRules` provided in config against all string values in the
tool input. Returns `RiskAnalysis` — riskLevel "low" when nothing matches.

`createCompositeAnalyzer(analyzers: readonly SecurityAnalyzer[]): SecurityAnalyzer`
Runs all analyzers in parallel (via `Promise.all`) and merges results taking the maximum
`riskLevel` and concatenating all findings.

`maxRiskLevel(levels: readonly RiskLevel[]): RiskLevel`
Returns the highest risk level from the array. Returns "low" for an empty array.

`BUILTIN_RULES: readonly PatternRule[]`
16 pre-compiled rules across 4 categories: SQL injection (4), command injection (5),
path traversal (4), and prompt injection (3) — all at "high" or "critical" risk level.

### PII Detection

```ts
import {
  createEmailDetector,
  createSsnDetector,
  createApiKeyDetector,
  createPiiDetector,
} from "@koi/governance-security";
import type { PiiDetector, PiiMatch, PiiKind } from "@koi/governance-security";
```

`createEmailDetector(): PiiDetector`
Matches `user@domain.tld` patterns (RFC 5322 simplified).

`createSsnDetector(): PiiDetector`
Matches US Social Security Numbers in `XXX-XX-XXXX` format.

`createApiKeyDetector(): PiiDetector`
Matches OpenAI (`sk-`), AWS IAM (`AKIA`), GitHub (`ghp_`/`ghs_`/`gho_`), and Slack
(`xoxb-`/`xoxp-`) key prefixes.

`createPiiDetector(kinds: readonly PiiKind[]): PiiDetector`
Convenience factory that composes the requested detectors into one. Deduplicated by kind.
Valid kinds: `"email"`, `"ssn"`, `"api_key"`.

### Dynamic Monitoring

```ts
import { createAnomalyMonitor } from "@koi/governance-security";
import type {
  AnomalyMonitorConfig,
  AnomalyMonitor,
  ToolCallEvent,
} from "@koi/governance-security";
```

`createAnomalyMonitor(config: AnomalyMonitorConfig): AnomalyMonitor`
In-memory per-session counter. Call `recordToolCall(event)` after each tool call — returns
any `AnomalySignal[]` triggered by that call. Call `nextTurn()` to reset per-turn counters
between model→tool→model cycles. Call `reset()` to restart the session.

Each anomaly fires **once per crossing** per turn; subsequent calls beyond the threshold
do not re-emit the same signal type until the next turn.

Anomaly kinds monitored:
| Kind | Config key | Default |
|------|-----------|---------|
| `tool_rate_exceeded` | `toolRateThreshold` | 20 |
| `error_spike` | `errorSpikeThreshold` | 5 |
| `tool_repeated` | `toolRepeatThreshold` | 10 |
| `denied_tool_calls` | `deniedCallThreshold` | 3 |

### Security Scoring

```ts
import { createSecurityScorer } from "@koi/governance-security";
import type {
  SecurityScore,
  ScoreContribution,
  SecurityScorer,
} from "@koi/governance-security";
```

`createSecurityScorer(): SecurityScorer`
Returns a scorer whose `score(analysis, anomalies)` method computes a 0–100 integer.
Static analysis contributes 60%, anomalies share the remaining 40% equally. The returned
`level` field maps the score back to a `RiskLevel` (0–19 → low, 20–49 → medium, 50–74 →
high, 75+ → critical).

## Fail-Closed Contract

- Pattern matching is synchronous and deterministic — no async I/O, no network calls.
- If `extraRules` contain an invalid regex that throws, `createRulesAnalyzer` propagates
  the error at construction time (not at analysis time).
- `createCompositeAnalyzer([])` (empty array) returns an analyzer that always returns
  `{ riskLevel: "low", findings: [], rationale: "No analyzers configured." }`.
- Score of 0 means no static findings and no anomalies — not "safe", just "undetected".
  Callers must combine this score with other governance signals before acting.

## Out of Scope

- Middleware wiring — this package has no `KoiMiddleware` export; use `@koi/governance-core`
  to compose middleware pipelines.
- Persistent storage of findings or scores — callers own persistence.
- LLM-based semantic analysis — purely syntactic/pattern-based.
- PII redaction — use `@koi/redaction` (L0u) for redaction strategies.
