# @koi/agent-monitor — Adversarial Agent Behavior Detection

`@koi/agent-monitor` is an L2 middleware package that observes agent activity at runtime
and fires callbacks when anomalous patterns are detected. It covers 12 signals across
tool abuse, error accumulation, latency anomalies, token spikes, destructive actions,
delegation depth, and goal drift — satisfying the
[OWASP ASI10 (Rogue/Unmonitored Agents)](https://genai.owasp.org/llmrisk/agentic-ai/)
requirement enforced by the `rogue-agents:no-agent-monitor` doctor rule.

---

## Why it exists

Static analysis (`@koi/doctor`) catches misconfigurations before runtime.
`@koi/agent-monitor` catches **behavioral anomalies during runtime** — the things that only
appear when an agent is actually running with a live model and real tools.

```
 Agent process
 ┌───────────────────────────────────────────────────────┐
 │                                                       │
 │   model call ──→ [ agent-monitor ] ──→ LLM            │
 │   tool call  ──→ [ agent-monitor ] ──→ tool executor  │
 │                         │                             │
 │                         ▼                             │
 │                  anomaly signals                      │
 │                         │                             │
 └─────────────────────────┼─────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
      onAnomaly        onMetrics       onAnomalyError
      (fire & forget)  (session end)   (callback crash)
```

The middleware is a **pure observer** — it never throws, never aborts the agent,
and never adds latency to the hot path. Governance and enforcement live outside it.

---

## Architecture

### Layer position

```
L0  @koi/core        ─ KoiMiddleware, TurnContext, SessionContext (types only)
L0u @koi/errors      ─ KoiError, Result<T,E>
L2  @koi/agent-monitor ─ this package (no L1 dependency)
```

`@koi/agent-monitor` imports only from `@koi/core` and `@koi/errors`.
It never touches `@koi/engine` (L1), keeping it fully swappable and testable
without spinning up the engine runtime.

### Internal module map

```
index.ts                 ← public re-exports
│
├── config.ts            ← AgentMonitorConfig + DEFAULT_THRESHOLDS
│                           + validateAgentMonitorConfig()
├── types.ts             ← AnomalySignal (discriminated union)
│                           + SessionMetricsSummary + LatencyStats
├── latency.ts           ← Welford's O(1) online mean/variance
│                           welfordUpdate() + buildLatencyStats()
├── detector.ts          ← 11 pure detection functions (no side effects)
└── monitor.ts           ← createAgentMonitorMiddleware() factory
                            session state map + lifecycle hooks
```

### Lifecycle hook mapping

| Hook | What runs |
|---|---|
| `onSessionStart` | Initialize `SessionMetrics` in the internal map |
| `onBeforeTurn` | Evaluate previous turn's goal drift BEFORE resetting counters; reset per-turn counters; increment `turnIndex`; check `session_duration_exceeded` |
| `wrapToolCall` | Increment counters; run checks 1–3, 5–9; fire anomalies; detect ping-pong; set `goalDriftMatchedThisTurn` flag on keyword match |
| `wrapModelStream` | Time the stream; capture usage tokens; run checks 4 (latency), 10 (token spike) |
| `onSessionEnd` | Emit `onMetrics` snapshot; remove session from state map |

### Data flow (single tool call)

```
wrapToolCall(ctx, toolId, input, next)
       │
       ├─ increment totalToolCalls, toolCallsThisTurn, distinctToolsThisTurn
       ├─ update consecutiveRepeat / pingPong trackers
       ├─ check tool_rate_exceeded     (1)
       ├─ check error_spike            (2) ← after next() returns error
       ├─ check tool_repeated          (3)
       ├─ check denied_tool_calls      (5) ← after next() returns denied
       ├─ check irreversible_action_rate (6) ← if toolId in destructiveToolIds
       ├─ check tool_diversity_spike   (8)
       ├─ check tool_ping_pong         (9)
       ├─ check delegation_depth_exceeded (11) ← if toolId in spawnToolIds
       └─ keyword match (12) ← if objectives set and toolId matches any pattern
               goalDriftMatchedThisTurn = true
               │
               ▼ (for each non-null result)
          fireAnomaly(signal, m)
               │
               └─ void Promise.resolve().then(() => onAnomaly(signal))
                  ← fire-and-forget; never blocks the agent

onBeforeTurn(ctx, turnIndex)
       │
       ├─ [NEW] evaluate previous turn's goal drift BEFORE reset:
       │     if toolCallsThisTurn > 0 and objectives.length > 0:
       │       keyword path: !goalDriftMatchedThisTurn → driftScore=1.0 → check threshold
       │       async scorer: fire-and-forget via Promise chain
       │
       └─ reset: toolCallsThisTurn=0, goalDriftMatchedThisTurn=false, distinctToolsThisTurn.clear()
```

### Data flow (model stream)

```
wrapModelStream*(ctx, request, next)
       │
       ├─ startTime = Date.now()
       ├─ for await (chunk of next(request))   ─── try
       │     if chunk.kind === "usage" → capture outputTokens
       │     yield chunk
       └─ finally (runs even when consumer calls .return() on the generator)
             ├─ latencyMs = Date.now() - startTime
             ├─ welfordUpdate(latency stats)
             ├─ check model_latency_anomaly   (4)
             ├─ welfordUpdate(token stats)
             └─ check token_spike             (10)
```

> **Why `try...finally`?**
> The Pi adapter's stream bridge exits the `for await` loop early (via `return`) after
> the `done` chunk. In JavaScript, calling `.return()` on an async generator terminates it
> immediately. `try...finally` guarantees the post-stream latency and token checks always
> run, regardless of how the consumer exits the generator.

---

## The 12 anomaly signals

### Signal table

| # | `kind` | OWASP | Default threshold | Fires when… |
|---|---|---|---|---|
| 1 | `tool_rate_exceeded` | ASI10 | `maxToolCallsPerTurn = 20` | >20 tool calls in one turn |
| 2 | `error_spike` | ASI10 | `maxErrorCallsPerSession = 10` | >10 tool errors accumulated |
| 3 | `tool_repeated` | ASI10 | `maxConsecutiveRepeatCalls = 5` | same toolId called >5 times in a row |
| 4 | `model_latency_anomaly` | ASI10 | `latencyAnomalyFactor = 3` | latency > mean + 3σ (after 5 warm-up samples) |
| 5 | `denied_tool_calls` | ASI10 | `maxDeniedCallsPerSession = 3` | >3 permission-denied calls accumulated |
| 6 | `irreversible_action_rate` | ASI10 | `maxDestructiveCallsPerTurn = 3` | destructive toolId called >3 times in one turn |
| 7 | `token_spike` | ASI10 | `tokenSpikeAnomalyFactor = 3` | output tokens > mean + 3σ (after 5 warm-up samples) |
| 8 | `tool_diversity_spike` | ASI10 | `maxDistinctToolsPerTurn = 15` | >15 distinct tool IDs in one turn |
| 9 | `tool_ping_pong` | ASI10 | `maxPingPongCycles = 4` | A→B→A→B alternation >4 cycles |
| 10 | `session_duration_exceeded` | ASI10 | `maxSessionDurationMs = 300_000` | session age >5 minutes |
| 11 | `delegation_depth_exceeded` | ASI10 | `maxDelegationDepth = 3` | spawn tool called at depth ≥ 3 |
| 12 | `goal_drift` | ASI10 | `goalDriftThreshold = 1.0` | zero tool calls in a turn matched any declared objective keyword |

### Threshold rationale

| Signal | Rationale |
|---|---|
| `maxToolCallsPerTurn = 20` | Production agents typically make 5–10 calls/turn; 20 is 4× the upper bound |
| `maxErrorCallsPerSession = 10` | >10 errors signals probing or a broken agent, not transient failures |
| `maxConsecutiveRepeatCalls = 5` | Hammering the same tool ≥5× in a row is unusual; 3 would cause false positives |
| `maxDeniedCallsPerSession = 3` | 3 permission denials in one session strongly suggests scope violation attempts |
| `latencyAnomalyFactor = 3` | 3σ gives ~0.3% false-positive rate for normally distributed latencies |
| `minLatencySamples = 5` | Cold-start prevention: don't flag before enough samples for reliable statistics |
| `maxDestructiveCallsPerTurn = 3` | >3 irreversible actions in one turn (delete, send, publish) is highly suspicious |
| `tokenSpikeAnomalyFactor = 3` | Same 3σ rule as latency; shared warm-up guard |
| `maxDistinctToolsPerTurn = 15` | Sweeping >15 different tools in one turn resembles reconnaissance |
| `maxPingPongCycles = 4` | 4 A↔B cycles = 8 alternating calls; deeper loops are almost never intentional |
| `maxSessionDurationMs = 300_000` | 5 minutes is generous for agent tasks; longer sessions may be stuck |
| `goalDriftThreshold = 1.0` | Fire only when 100% of tool calls in a turn had zero keyword match (avoids false positives from incidental tool use) |

---

## API

### `createAgentMonitorMiddleware(config)`

```typescript
import { createAgentMonitorMiddleware } from "@koi/agent-monitor";

const mw = createAgentMonitorMiddleware({
  thresholds: {
    maxToolCallsPerTurn: 15,         // override any default
    maxErrorCallsPerSession: 5,
    maxConsecutiveRepeatCalls: 3,
    maxDeniedCallsPerSession: 2,
    latencyAnomalyFactor: 3,
    minLatencySamples: 5,
    maxDestructiveCallsPerTurn: 2,
    tokenSpikeAnomalyFactor: 3,
    maxDistinctToolsPerTurn: 10,
    maxPingPongCycles: 3,
    maxSessionDurationMs: 120_000,
    maxDelegationDepth: 2,
  },
  objectives: ["search the web", "write a report"],  // enables goal drift detection
  goalDrift: {
    threshold: 0.8,         // fire when ≥80% of tool calls had no keyword match
    // scorer: async (toolIds, objectives) => number  // optional custom scorer
  },
  destructiveToolIds: ["delete_file", "send_email", "publish_post"],
  spawnToolIds: ["forge_agent"],      // Phase 2: delegation depth tracking
  agentDepth: 0,                      // Phase 2: this agent's depth in the tree
  onAnomaly: (signal) => {
    console.warn("[agent-monitor]", signal.kind, signal);
  },
  onAnomalyError: (err, signal) => {
    console.error("[agent-monitor] callback crashed on", signal.kind, err);
  },
  onMetrics: (sessionId, summary) => {
    console.log("[agent-monitor] session ended", summary);
  },
});
```

Returns a `KoiMiddleware` with `name: "agent-monitor"` and `priority: 350`.

### `AgentMonitorConfig`

```typescript
interface AgentMonitorConfig {
  readonly thresholds?: {
    readonly maxToolCallsPerTurn?: number;        // default: 20
    readonly maxErrorCallsPerSession?: number;    // default: 10
    readonly maxConsecutiveRepeatCalls?: number;  // default: 5
    readonly maxDeniedCallsPerSession?: number;   // default: 3
    readonly latencyAnomalyFactor?: number;       // default: 3
    readonly minLatencySamples?: number;          // default: 5
    readonly maxDestructiveCallsPerTurn?: number; // default: 3
    readonly tokenSpikeAnomalyFactor?: number;    // default: 3
    readonly maxDistinctToolsPerTurn?: number;    // default: 15
    readonly maxPingPongCycles?: number;          // default: 4
    readonly maxSessionDurationMs?: number;       // default: 300_000
    readonly maxDelegationDepth?: number;         // default: 3
  };
  /**
   * Declared task objectives — used to build keyword patterns for goal drift detection.
   * Must be set for `goalDrift` to have any effect.
   */
  readonly objectives?: readonly string[];
  /**
   * Goal drift detection config. Requires `objectives` to be non-empty.
   * Disabled if `objectives` is absent or empty.
   */
  readonly goalDrift?: {
    /**
     * Drift score threshold (0.0–1.0). Signal fires when the computed score ≥ threshold.
     * Default: 1.0 — fires only when zero tool calls in a turn matched any objective keyword.
     * Set lower (e.g., 0.5) to fire when fewer than half of calls matched.
     */
    readonly threshold?: number;
    /**
     * Optional async scorer replacing the default keyword matcher.
     * Returns 0.0 (fully aligned) to 1.0 (fully drifted).
     * Invoked fire-and-forget — never blocks tool calls.
     */
    readonly scorer?: (
      toolIds: readonly string[],
      objectives: readonly string[],
    ) => number | Promise<number>;
  };
  readonly destructiveToolIds?: readonly string[];
  readonly spawnToolIds?: readonly string[];      // Phase 2
  readonly agentDepth?: number;                  // Phase 2
  readonly onAnomaly?: (signal: AnomalySignal) => void | Promise<void>;
  readonly onAnomalyError?: (err: unknown, signal: AnomalySignal) => void;
  readonly onMetrics?: (sessionId: SessionId, summary: SessionMetricsSummary) => void;
}
```

### `AnomalySignal`

All signals share a common base and add kind-specific fields:

```typescript
type AnomalyBase = {
  readonly sessionId: SessionId;
  readonly agentId: string;
  readonly timestamp: number;  // Date.now() at detection time
  readonly turnIndex: number;  // 0-based turn counter within this session
};

type AnomalySignal = AnomalyBase & (
  | { kind: "tool_rate_exceeded";       callsPerTurn: number;   threshold: number }
  | { kind: "error_spike";              errorCount: number;     threshold: number }
  | { kind: "tool_repeated";            toolId: string; repeatCount: number; threshold: number }
  | { kind: "model_latency_anomaly";    latencyMs: number; mean: number; stddev: number; factor: number }
  | { kind: "denied_tool_calls";        deniedCount: number;    threshold: number }
  | { kind: "irreversible_action_rate"; toolId: string; callsThisTurn: number; threshold: number }
  | { kind: "token_spike";              outputTokens: number; mean: number; stddev: number; factor: number }
  | { kind: "tool_diversity_spike";     distinctToolCount: number; threshold: number }
  | { kind: "tool_ping_pong";           toolIdA: string; toolIdB: string; altCount: number; threshold: number }
  | { kind: "session_duration_exceeded"; durationMs: number;   threshold: number }
  | { kind: "delegation_depth_exceeded"; currentDepth: number; maxDepth: number; spawnToolId: string }
  | { kind: "goal_drift"; driftScore: number; threshold: number; objectives: readonly string[] }
);
```

### `SessionMetricsSummary`

Emitted once via `onMetrics` when the session ends:

```typescript
interface SessionMetricsSummary {
  readonly sessionId: SessionId;
  readonly agentId: string;
  readonly totalToolCalls: number;
  readonly totalModelCalls: number;
  readonly totalErrorCalls: number;
  readonly totalDeniedCalls: number;
  readonly totalDestructiveCalls: number;
  readonly anomalyCount: number;
  readonly turnCount: number;
  readonly meanLatencyMs: number;
  readonly latencyStddevMs: number;
  readonly meanOutputTokens: number;
  readonly outputTokenStddev: number;
}
```

### `validateAgentMonitorConfig(config)`

Validates untrusted manifest options at package initialization time. Used internally
by the `@koi/starter` adapter — call it directly when constructing config from
external input:

```typescript
import { validateAgentMonitorConfig } from "@koi/agent-monitor";

const result = validateAgentMonitorConfig(untrustedOptions);
if (!result.ok) {
  throw new Error(`invalid manifest options: ${result.error.message}`);
}
const config = result.value;
```

---

## Examples

### 1. Direct `createKoi` — minimal anomaly logging

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createAgentMonitorMiddleware } from "@koi/agent-monitor";

const monitor = createAgentMonitorMiddleware({
  onAnomaly: (signal) => {
    console.warn(`[ANOMALY] ${signal.kind} at turn ${signal.turnIndex}`, signal);
  },
});

const koi = createKoi({
  adapter: createPiAdapter({ model: "claude-haiku-4-5-20251001" }),
  middleware: [monitor],
});

const session = await koi.createSession({ agentId: "my-agent" });
for await (const chunk of session.stream("Do some work.")) {
  process.stdout.write(chunk.content ?? "");
}
```

### 2. Manifest-driven via `@koi/starter`

```typescript
import { createConfiguredKoi } from "@koi/starter";

const koi = await createConfiguredKoi({
  manifest: {
    name: "my-agent",
    version: "1.0.0",
    model: { name: "claude-haiku-4-5-20251001" },
    middleware: [
      {
        name: "agent-monitor",
        options: {
          thresholds: { maxToolCallsPerTurn: 15, maxDeniedCallsPerSession: 2 },
          destructiveToolIds: ["delete_file", "send_email"],
        },
      },
    ],
  },
  callbacks: {
    "agent-monitor": {
      onAnomaly: (signal) => {
        console.warn(`[ANOMALY] ${signal.kind}`, signal);
      },
      onMetrics: (sessionId, summary) => {
        console.log(`[METRICS] ${summary.totalToolCalls} calls, ${summary.anomalyCount} anomalies`);
      },
    },
  },
});
```

### 3. Sending anomalies to an alerting system

```typescript
createAgentMonitorMiddleware({
  onAnomaly: async (signal) => {
    await fetch("https://alerts.example.com/agent-anomaly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signal),
    });
  },
  onAnomalyError: (err, signal) => {
    // onAnomaly threw/rejected — log it, but the agent continues
    console.error("Alert delivery failed for", signal.kind, err);
  },
});
```

### 4. Collecting session metrics for dashboards

```typescript
const sessionMetrics = new Map<string, SessionMetricsSummary>();

createAgentMonitorMiddleware({
  onMetrics: (sessionId, summary) => {
    sessionMetrics.set(String(sessionId), summary);
    reportToMetricsPipeline(summary);
  },
});
```

### 5. Destructive tool rate limiting (Gap 1)

```typescript
createAgentMonitorMiddleware({
  destructiveToolIds: ["delete_record", "send_notification", "publish_article"],
  thresholds: {
    maxDestructiveCallsPerTurn: 1,  // only 1 destructive action per turn
  },
  onAnomaly: (signal) => {
    if (signal.kind === "irreversible_action_rate") {
      console.warn(
        `Tool "${signal.toolId}" called ${signal.callsThisTurn}× this turn ` +
        `(limit: ${signal.threshold})`,
      );
    }
  },
});
```

### 6. Delegation depth guard (Phase 2)

```typescript
// Root orchestrator (depth 0)
createAgentMonitorMiddleware({
  spawnToolIds: ["forge_agent"],
  agentDepth: 0,
  thresholds: { maxDelegationDepth: 2 },
  onAnomaly: (signal) => {
    if (signal.kind === "delegation_depth_exceeded") {
      console.error(
        `Spawn attempt at depth ${signal.currentDepth} ` +
        `exceeds limit ${signal.maxDepth} via "${signal.spawnToolId}"`,
      );
    }
  },
});
```

### 7. Goal drift detection

```typescript
createAgentMonitorMiddleware({
  objectives: ["search the web for recent papers", "write a literature review"],
  goalDrift: {
    threshold: 1.0,   // fire when zero tool calls matched any objective keyword
  },
  onAnomaly: (signal) => {
    if (signal.kind === "goal_drift") {
      console.warn(
        `[goal drift] turn ${signal.turnIndex}: ` +
        `score=${signal.driftScore}, threshold=${signal.threshold}`,
        signal.objectives,
      );
      // Typical response: re-inject objectives, abort, or notify operator
    }
  },
});
```

**How it fires:**

```
Turn N tool calls:  ["email_send", "calendar_check", "slack_post"]
Objectives:         ["search the web", "write a report"]
Keyword patterns:   /search/i, /write/i, /report/i

  email_send    → no match
  calendar_check → no match
  slack_post    → no match

All three calls missed → driftScore = 1.0 ≥ threshold 1.0 → goal_drift fires in onBeforeTurn(N+1)
```

**How it is suppressed:**

```
Turn N tool calls:  ["web_search", "email_send", "slack_post"]
Objectives:         ["search the web"]
Keyword patterns:   /search/i

  web_search → "search" matches → goalDriftMatchedThisTurn = true

At least one match → no goal_drift signal
```

**Keyword extraction** happens once at factory time (`buildKeywordPatterns`):
1. Objectives are split on non-word characters
2. Stopwords (a, an, the, to, for, in, on, of, and, or) and short words (≤2 chars) are removed
3. Remaining unique words are compiled into case-insensitive `RegExp` objects
4. During `wrapToolCall`, each `toolId` is tested against all patterns — O(patterns) per call

**Timing:** `goal_drift` is evaluated in `onBeforeTurn(N+1)`, not at the end of turn N.
This means the `turnIndex` on the signal reflects the turn when drift was *detected*,
which is one higher than the turn where the off-target calls occurred.

**Async scorer (optional):** Supply `goalDrift.scorer` to replace the keyword heuristic
with a custom function (e.g., an embedding-based similarity check). The scorer receives
the full list of `toolIds` from the previous turn and the `objectives` array. It is
invoked fire-and-forget — a rejected promise calls `onAnomalyError` (if provided) or
is silently swallowed.

---

## Doctor integration

`@koi/agent-monitor` is the runtime counterpart to the doctor's static scan.
The doctor rule `rogue-agents:no-agent-monitor` fires when:

- `manifest.delegation.enabled === true`, AND
- no middleware named `"agent-monitor"` or `"monitor"` is present

Once `agent-monitor` (or its alias `monitor`) is in the manifest, that rule is silent:

```typescript
// Before:
const report = await createDoctor({ manifest }).run();
// report.findings includes: rogue-agents:no-agent-monitor (MEDIUM)

// After adding agent-monitor to middleware:
const secureManifest = {
  ...manifest,
  middleware: [{ name: "agent-monitor" }],
};
const report2 = await createDoctor({ manifest: secureManifest }).run();
// report2.findings has no rogue-agents:no-agent-monitor entry ✓
```

---

## Performance properties

All operations are O(1) per call — no arrays grow with session length:

| Feature | Algorithm | Space |
|---|---|---|
| Latency tracking | Welford's online mean/variance | 3 numbers per session |
| Token tracking | Welford's online mean/variance | 3 numbers per session |
| Consecutive repeat detection | Last toolId + counter | 2 fields per session |
| Ping-pong detection | Last two toolIds + counter | 3 fields per session |
| Tool diversity (per turn) | `Set<string>` reset each turn | O(tools/turn) transient |
| Destructive rate (per turn) | `Map<toolId, count>` reset each turn | O(destructive tools/turn) transient |
| Goal drift keyword patterns | `readonly RegExp[]` pre-compiled at factory time | O(unique keywords) — amortized zero per call |
| Goal drift match flag | `boolean` reset each turn | 1 field per session |
| Session state | `Map<SessionId, SessionMetrics>` | 1 entry per live session |
| `onAnomaly` dispatch | Fire-and-forget via `Promise.resolve().then(cb)` | Zero latency added to hot path |

Memory is bounded: each live session holds ~20 primitive fields plus one transient
`Set` and `Map` reset every turn. `onSessionEnd` removes the entry from the map,
so there is no accumulation across sessions.

---

## Execution model

```
createKoi({ adapter, middleware: [agentMonitorMw, ...] })
       │
       └── session.stream("…")
               │
    ┌──────────┴─────────────────────────────────────────┐
    │  onSessionStart  ─ SessionMetrics initialized      │
    │                                                    │
    │  onBeforeTurn    ─ per-turn counters reset         │
    │                    session_duration check          │
    │                                                    │
    │  wrapModelStream ─ latency + token tracking        │
    │    ← try/finally ← runs even on generator .return()│
    │                                                    │
    │  wrapToolCall ×N ─ checks per call (signals 1–3,5–9,11–12) │
    │                    + goal drift keyword matching   │
    │                    fire-and-forget anomalies       │
    │                                                    │
    │  onSessionEnd    ─ onMetrics snapshot emitted      │
    │                    session removed from state map  │
    └────────────────────────────────────────────────────┘
```

**Key properties:**

- `onAnomaly` errors never interrupt the agent — crashes are captured and routed
  to `onAnomalyError` (if provided) or swallowed silently
- Multiple anomalies can fire per turn — the middleware does not suppress after the first
- `onMetrics` fires exactly once per session, on `onSessionEnd`
- Session state is cleaned up on every `onSessionEnd`, including abnormal termination
- All detection functions are pure — no I/O, no side effects, easily unit tested
- Middleware `priority: 350` places it after audit (300) and before permissions (400),
  so it observes the raw tool call before permissions strips or denies it
