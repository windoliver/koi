# `@koi/agent-monitor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the L2 middleware package `@koi/agent-monitor` — a pure-observer middleware that detects 12 OWASP-ASI10 anomaly signals during agent runtime and dispatches them fire-and-forget to user callbacks. Never throws, never blocks, never aborts the agent.

**Architecture:** L2 middleware. Imports only `@koi/core` (and `@koi/errors` for `KoiError`/`Result`). One factory `createAgentMonitorMiddleware(config)` returns a `KoiMiddleware` with `priority: 350`. Internal modules: pure detection functions (`detector.ts`), Welford online stats (`latency.ts`), threshold validation (`config.ts`), session state map and lifecycle hook implementation (`monitor.ts`), shared types (`types.ts`).

**Tech Stack:** TypeScript 6 strict, Bun, `bun:test`, tsup, Biome.

**Spec:** `docs/L2/agent-monitor.md` (authoritative — signal table, threshold rationale, data flow, performance properties).

**L0 contracts already in place:** `AnomalySignal`, `AnomalyBase`, `AnomalyDetail` in `packages/kernel/core/src/agent-anomaly.ts`. **Re-use these — do not redefine.**

**Reference (port + simplify):** `archive/v1/packages/observability/agent-monitor/src/`.

**Issue:** #1378 (v2 Phase 3-obs-2).

---

## File Structure

```
packages/lib/agent-monitor/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                       ← public re-exports
    ├── types.ts                       ← SessionMetrics, SessionMetricsSummary,
    │                                    LatencyStats — local types only
    ├── config.ts                      ← AgentMonitorConfig, DEFAULT_THRESHOLDS,
    │                                    validateAgentMonitorConfig()
    ├── config.test.ts
    ├── latency.ts                     ← welfordUpdate(), buildLatencyStats()
    ├── latency.test.ts
    ├── keyword-patterns.ts            ← buildKeywordPatterns(objectives)
    ├── keyword-patterns.test.ts
    ├── detector.ts                    ← 11 pure detection functions
    ├── detector.test.ts               ← per-detector tests + threshold edges
    ├── monitor.ts                     ← createAgentMonitorMiddleware()
    │                                    + session state map + hook wiring
    ├── monitor.test.ts                ← integration: hook lifecycle + signals
    └── __tests__/
        └── e2e-mw.test.ts             ← run a fake middleware chain end-to-end
```

---

## Task 1 — Scaffold

- [ ] **Step 1: package.json**

```json
{
  "name": "@koi/agent-monitor",
  "description": "Adversarial agent behavior detection — 12 OWASP-ASI10 anomaly signals (pure observer middleware)",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "koi": {
    "optional": true
  }
}
```

  Confirm `@koi/errors` package path before committing — if it lives somewhere other than `packages/lib/errors`, update `tsconfig.json` references accordingly.

- [ ] **Step 2: tsconfig.json**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../kernel/core" },
    { "path": "../errors" }
  ]
}
```

- [ ] **Step 3: tsup.config.ts** — copy from `packages/lib/event-trace/tsup.config.ts`.

- [ ] **Step 4: `src/index.ts` = `export {};`. Run `bun install`, build, typecheck.** Commit.

```bash
git add packages/lib/agent-monitor/
git commit -m "feat(agent-monitor): scaffold L2 package"
```

---

## Task 2 — `types.ts` (local types only)

L0 already provides `AnomalySignal`. Local file holds session-level types.

- [ ] **Step 1: Define types** (no logic):

```typescript
import type { AgentId, SessionId } from "@koi/core";

export interface LatencyStats {
  readonly mean: number;
  readonly stddev: number;
  readonly count: number;
  /** running sum of squared differences from mean (Welford's M2). */
  readonly m2: number;
}

export interface SessionMetricsSummary {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
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

/** Mutable per-session state held in a Map. Internal — not re-exported. */
export interface SessionMetrics {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly startedAt: number;
  turnIndex: number;

  totalToolCalls: number;
  totalModelCalls: number;
  totalErrorCalls: number;
  totalDeniedCalls: number;
  totalDestructiveCalls: number;
  anomalyCount: number;

  // per-turn (reset in onBeforeTurn)
  toolCallsThisTurn: number;
  distinctToolsThisTurn: Set<string>;
  destructiveThisTurn: Map<string, number>;
  goalDriftMatchedThisTurn: boolean;
  toolIdsThisTurn: string[];

  // sequence
  lastToolId: string | null;
  consecutiveRepeat: number;
  prevToolId: string | null;          // for ping-pong
  pingPongAltCount: number;

  // streams
  latency: LatencyStats;
  outputTokens: LatencyStats;
}
```

- [ ] **Step 2: Typecheck.** Commit.

---

## Task 3 — `latency.ts` (Welford online stats)

**Spec section:** "Performance properties" — Welford's algorithm.

- [ ] **Step 1: Write `latency.test.ts`** — known-vector test + edge cases:

```typescript
import { describe, expect, test } from "bun:test";
import { welfordUpdate, emptyStats } from "./latency.js";

describe("welfordUpdate", () => {
  test("matches population mean and stddev for [2, 4, 4, 4, 5, 5, 7, 9]", () => {
    let s = emptyStats();
    for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) s = welfordUpdate(s, x);
    expect(s.mean).toBe(5);
    // population stddev = 2.0
    expect(Math.round(s.stddev * 1e6) / 1e6).toBe(2);
  });

  test("count=0 returns zeros for mean/stddev", () => {
    const s = emptyStats();
    expect(s).toEqual({ mean: 0, stddev: 0, count: 0, m2: 0 });
  });

  test("count=1 has stddev=0", () => {
    const s = welfordUpdate(emptyStats(), 42);
    expect(s.mean).toBe(42);
    expect(s.stddev).toBe(0);
    expect(s.count).toBe(1);
  });
});
```

- [ ] **Step 2: Implement `latency.ts`**

```typescript
import type { LatencyStats } from "./types.js";

export function emptyStats(): LatencyStats {
  return { mean: 0, stddev: 0, count: 0, m2: 0 };
}

export function welfordUpdate(s: LatencyStats, x: number): LatencyStats {
  const count = s.count + 1;
  const delta = x - s.mean;
  const mean = s.mean + delta / count;
  const delta2 = x - mean;
  const m2 = s.m2 + delta * delta2;
  // population variance
  const variance = count > 0 ? m2 / count : 0;
  const stddev = Math.sqrt(variance);
  return { mean, stddev, count, m2 };
}
```

- [ ] **Step 3: Tests pass.** Commit.

---

## Task 4 — `keyword-patterns.ts`

**Spec section:** "Goal drift" — keyword extraction at factory time.

- [ ] **Step 1: Write `keyword-patterns.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import { buildKeywordPatterns } from "./keyword-patterns.js";

describe("buildKeywordPatterns", () => {
  test("splits on non-word, lowercases, removes stopwords/short words, dedupes", () => {
    const patterns = buildKeywordPatterns([
      "search the web for recent papers",
      "write a literature review",
    ]);
    const toolIds = patterns.map((p) => p.source);
    expect(toolIds.sort()).toEqual(
      ["literature", "papers", "recent", "review", "search", "web", "write"].sort(),
    );
  });

  test("returns empty array for empty objectives", () => {
    expect(buildKeywordPatterns([])).toEqual([]);
    expect(buildKeywordPatterns([""])).toEqual([]);
  });

  test("matches case-insensitively", () => {
    const [p] = buildKeywordPatterns(["search the web"]);
    expect(p?.test("WEB_SEARCH")).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "in", "on", "of", "and", "or",
]);

export function buildKeywordPatterns(
  objectives: readonly string[],
): readonly RegExp[] {
  const words = new Set<string>();
  for (const obj of objectives) {
    const tokens = obj.toLowerCase().split(/[^a-z0-9]+/);
    for (const t of tokens) {
      if (t.length > 2 && !STOPWORDS.has(t)) words.add(t);
    }
  }
  return [...words].map((w) => new RegExp(w, "i"));
}
```

- [ ] **Step 3: Tests pass.** Commit.

---

## Task 5 — `config.ts` (defaults + validation)

**Spec section:** `AgentMonitorConfig`, `validateAgentMonitorConfig`, "Threshold rationale".

- [ ] **Step 1: Define `AgentMonitorConfig`** matching the spec interface verbatim, plus `DEFAULT_THRESHOLDS` constant capturing the 12 defaults from the signal table.

```typescript
import type { Result } from "@koi/errors";  // or wherever Result lives
import type { AnomalySignal, SessionId } from "@koi/core";
import type { SessionMetricsSummary } from "./types.js";

export interface AgentMonitorThresholds {
  readonly maxToolCallsPerTurn: number;
  readonly maxErrorCallsPerSession: number;
  readonly maxConsecutiveRepeatCalls: number;
  readonly maxDeniedCallsPerSession: number;
  readonly latencyAnomalyFactor: number;
  readonly minLatencySamples: number;
  readonly maxDestructiveCallsPerTurn: number;
  readonly tokenSpikeAnomalyFactor: number;
  readonly maxDistinctToolsPerTurn: number;
  readonly maxPingPongCycles: number;
  readonly maxSessionDurationMs: number;
  readonly maxDelegationDepth: number;
}

export const DEFAULT_THRESHOLDS: AgentMonitorThresholds = {
  maxToolCallsPerTurn: 20,
  maxErrorCallsPerSession: 10,
  maxConsecutiveRepeatCalls: 5,
  maxDeniedCallsPerSession: 3,
  latencyAnomalyFactor: 3,
  minLatencySamples: 5,
  maxDestructiveCallsPerTurn: 3,
  tokenSpikeAnomalyFactor: 3,
  maxDistinctToolsPerTurn: 15,
  maxPingPongCycles: 4,
  maxSessionDurationMs: 300_000,
  maxDelegationDepth: 3,
};

export interface AgentMonitorConfig {
  readonly thresholds?: Partial<AgentMonitorThresholds>;
  readonly objectives?: readonly string[];
  readonly goalDrift?: {
    readonly threshold?: number;
    readonly scorer?: (
      toolIds: readonly string[],
      objectives: readonly string[],
    ) => number | Promise<number>;
  };
  readonly destructiveToolIds?: readonly string[];
  readonly spawnToolIds?: readonly string[];
  readonly agentDepth?: number;
  readonly onAnomaly?: (signal: AnomalySignal) => void | Promise<void>;
  readonly onAnomalyError?: (err: unknown, signal: AnomalySignal) => void;
  readonly onMetrics?: (sessionId: SessionId, summary: SessionMetricsSummary) => void;
}
```

- [ ] **Step 2: `validateAgentMonitorConfig(config: unknown): Result<AgentMonitorConfig, KoiError>`**

  Validate:
  - `thresholds.*` numbers ≥ 0; factors ≥ 1; `minLatencySamples` ≥ 1
  - `goalDrift.threshold` ∈ [0, 1] when provided
  - `objectives` strings non-empty
  - `agentDepth` ≥ 0
  - destructive/spawn tool IDs non-empty strings

  Return `{ ok: true, value: config }` for valid, `{ ok: false, error: KoiError("VALIDATION", …) }` for invalid.

- [ ] **Step 3: `config.test.ts`** — happy path + each invalid case yields `{ ok: false }`. ~12 tests.

- [ ] **Step 4: Tests pass.** Commit.

---

## Task 6 — `detector.ts` (11 pure functions)

**Spec section:** "12 anomaly signals" (signals 1–9, 11, 12 fire from per-call/per-turn detectors here; signals 4 & 10 use Welford and live in `monitor.ts`'s stream finally; signal 12 splits between `wrapToolCall` keyword match and `onBeforeTurn` evaluation).

The 11 functions live in `detector.ts` because they are pure — no I/O, no state mutation beyond their inputs. Each returns `AnomalyDetail | null`.

```typescript
import type { AnomalyDetail } from "@koi/core";
import type { SessionMetrics } from "./types.js";
import type { AgentMonitorThresholds } from "./config.js";

export function detectToolRateExceeded(
  m: SessionMetrics,
  t: AgentMonitorThresholds,
): AnomalyDetail | null {
  return m.toolCallsThisTurn > t.maxToolCallsPerTurn
    ? { kind: "tool_rate_exceeded", callsPerTurn: m.toolCallsThisTurn, threshold: t.maxToolCallsPerTurn }
    : null;
}
// … 10 more, one per signal. Reference v1 detector.ts.
```

- [ ] **Step 1: Write `detector.test.ts`** — for each function, three cases: under threshold (null), at threshold (null — strict `>` per spec), over threshold (signal). Plus `tool_repeated` resets when a different tool is called; `tool_ping_pong` requires alternation A↔B.

  Cover all 11: `tool_rate_exceeded`, `error_spike`, `tool_repeated`, `denied_tool_calls`, `irreversible_action_rate`, `tool_diversity_spike`, `tool_ping_pong`, `session_duration_exceeded`, `delegation_depth_exceeded`, `model_latency_anomaly`, `token_spike`. (Latency / token detectors are pure too — they take `latencyMs/outputTokens`, current stats, factor, and minSamples.)

  ~33 tests total.

- [ ] **Step 2: Implement.** Port from `archive/v1/packages/observability/agent-monitor/src/detector.ts`. Follow the threshold semantics in the spec table: `>` not `>=` unless spec explicitly says otherwise. For `model_latency_anomaly` and `token_spike`, gate on `count >= minLatencySamples`.

- [ ] **Step 3: Tests pass.** Commit.

---

## Task 7 — `monitor.ts` (the middleware factory + lifecycle wiring)

**Spec section:** "Internal module map", "Lifecycle hook mapping", "Data flow", "Execution model".

- [ ] **Step 1: Write `monitor.test.ts`** — high-coverage scenarios:

1. `name === "agent-monitor"` and `priority === 350`.
2. `onSessionStart` initializes a fresh `SessionMetrics` for the session ID.
3. `wrapToolCall` increments `totalToolCalls`/`toolCallsThisTurn`/`distinctToolsThisTurn`.
4. Exceeding `maxToolCallsPerTurn` fires `tool_rate_exceeded` exactly once per qualifying call (verifies the call still proceeds — middleware never blocks).
5. `error_spike`: tool returning a denied/error response increments `totalErrorCalls`; threshold fires `error_spike`.
6. `tool_repeated`: same toolId 6× in a row fires `tool_repeated`.
7. `tool_ping_pong`: A→B→A→B→A→B→A→B (4 alternations) fires.
8. `irreversible_action_rate`: destructive id called 4× in one turn fires.
9. `denied_tool_calls`: 4 denied calls fire `denied_tool_calls`.
10. `delegation_depth_exceeded`: when `agentDepth >= maxDelegationDepth` and toolId is in `spawnToolIds`, fires.
11. `model_latency_anomaly`: after 5 warm-up samples around 100ms, a 1000ms sample fires.
12. `token_spike`: same shape with `usage` chunks.
13. `session_duration_exceeded`: `onBeforeTurn` after exceeding duration fires.
14. `goal_drift`: turn N tool calls with no keyword match → goal_drift fires in `onBeforeTurn(N+1)`. Suppressed when at least one matched.
15. `wrapModelStream` runs latency/token checks even when consumer calls `.return()` early — emulate with a generator that breaks early.
16. `onAnomaly` async callbacks that throw/reject route to `onAnomalyError`.
17. `onAnomaly` is fire-and-forget — middleware does not await it before returning to caller.
18. `onSessionEnd` emits `onMetrics` exactly once and removes the session from the state map.
19. Multiple anomalies in one turn all fire (no first-write-wins suppression).
20. Async scorer for goal drift: rejected promise routes to `onAnomalyError`.

- [ ] **Step 2: Implement** — port from `archive/v1/packages/observability/agent-monitor/src/monitor.ts`. Adapt to the live `KoiMiddleware` and turn-context types from `@koi/core`. Skeleton outline:

```typescript
import type {
  AnomalySignal, KoiMiddleware, SessionContext, SessionId, TurnContext,
} from "@koi/core";
import {
  type AgentMonitorConfig, DEFAULT_THRESHOLDS, validateAgentMonitorConfig,
} from "./config.js";
import { emptyStats, welfordUpdate } from "./latency.js";
import { buildKeywordPatterns } from "./keyword-patterns.js";
import * as detect from "./detector.js";
import type { SessionMetrics, SessionMetricsSummary } from "./types.js";

export function createAgentMonitorMiddleware(
  rawConfig: AgentMonitorConfig,
): KoiMiddleware {
  const validated = validateAgentMonitorConfig(rawConfig);
  if (!validated.ok) throw new Error(`agent-monitor: ${validated.error.message}`);
  const config = validated.value;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.thresholds ?? {}) };
  const keywordPatterns = buildKeywordPatterns(config.objectives ?? []);
  const sessions = new Map<SessionId, SessionMetrics>();
  const driftThreshold = config.goalDrift?.threshold ?? 1.0;

  function fire(signal: AnomalySignal, m: SessionMetrics): void {
    m.anomalyCount++;
    const cb = config.onAnomaly;
    if (!cb) return;
    Promise.resolve()
      .then(() => cb(signal))
      .catch((err: unknown) => {
        try { config.onAnomalyError?.(err, signal); } catch { /* never throw */ }
      });
  }

  function metricsSnapshot(m: SessionMetrics): SessionMetricsSummary { /* … */ }

  return {
    name: "agent-monitor",
    priority: 350,
    describeCapabilities: () => undefined,

    onSessionStart: (ctx: SessionContext) => {
      sessions.set(ctx.sessionId, /* fresh SessionMetrics */);
    },

    onBeforeTurn: (ctx: TurnContext) => {
      const m = sessions.get(ctx.sessionId);
      if (!m) return;
      // Evaluate goal drift for previous turn before reset
      if (m.toolCallsThisTurn > 0 && (config.objectives?.length ?? 0) > 0) {
        if (config.goalDrift?.scorer) {
          // fire-and-forget async scorer
          Promise.resolve(config.goalDrift.scorer(m.toolIdsThisTurn, config.objectives ?? []))
            .then((score) => {
              if (score >= driftThreshold) fire(/* goal_drift signal */, m);
            })
            .catch((err) => config.onAnomalyError?.(err, /* synthetic */ {} as AnomalySignal));
        } else if (!m.goalDriftMatchedThisTurn) {
          fire(/* goal_drift score=1.0 */, m);
        }
      }
      // session_duration check
      const dur = Date.now() - m.startedAt;
      if (dur > thresholds.maxSessionDurationMs) {
        fire(/* session_duration_exceeded */, m);
      }
      // reset per-turn state
      m.toolCallsThisTurn = 0;
      m.distinctToolsThisTurn.clear();
      m.destructiveThisTurn.clear();
      m.goalDriftMatchedThisTurn = false;
      m.toolIdsThisTurn = [];
      m.turnIndex++;
    },

    wrapToolCall: async (ctx, request, next) => {
      const m = sessions.get(ctx.sessionId);
      const response = await next(request);              // never block on detection
      if (!m) return response;
      // increment counters
      m.totalToolCalls++; m.toolCallsThisTurn++;
      m.distinctToolsThisTurn.add(request.toolId);
      m.toolIdsThisTurn.push(request.toolId);
      // sequence trackers
      if (m.lastToolId === request.toolId) m.consecutiveRepeat++;
      else { m.lastToolId = request.toolId; m.consecutiveRepeat = 1; }
      // ping-pong: track A↔B alternation
      // destructive
      if ((config.destructiveToolIds ?? []).includes(request.toolId)) {
        m.totalDestructiveCalls++;
        const c = (m.destructiveThisTurn.get(request.toolId) ?? 0) + 1;
        m.destructiveThisTurn.set(request.toolId, c);
      }
      // delegation depth
      if ((config.spawnToolIds ?? []).includes(request.toolId)) {
        if ((config.agentDepth ?? 0) >= thresholds.maxDelegationDepth) {
          fire(/* delegation_depth_exceeded */, m);
        }
      }
      // error / denied — read response.status / response.kind per L0 contract
      // Run all relevant detectors and fire signals as they return non-null
      // Goal drift keyword match
      if (keywordPatterns.length > 0) {
        for (const p of keywordPatterns) {
          if (p.test(request.toolId)) { m.goalDriftMatchedThisTurn = true; break; }
        }
      }
      return response;
    },

    wrapModelStream: async function* (ctx, request, next) {
      const m = sessions.get(ctx.sessionId);
      const start = Date.now();
      let outputTokens = 0;
      try {
        for await (const chunk of next(request)) {
          if (m && chunk.kind === "usage" /* confirm L0 shape */) {
            outputTokens = chunk.outputTokens ?? outputTokens;
          }
          yield chunk;
        }
      } finally {
        if (m) {
          const latencyMs = Date.now() - start;
          m.latency = welfordUpdate(m.latency, latencyMs);
          // detect.detectModelLatencyAnomaly(latencyMs, m.latency, thresholds);
          if (outputTokens > 0) {
            m.outputTokens = welfordUpdate(m.outputTokens, outputTokens);
            // detect.detectTokenSpike(outputTokens, m.outputTokens, thresholds);
          }
          m.totalModelCalls++;
        }
      }
    },

    onSessionEnd: (ctx: SessionContext) => {
      const m = sessions.get(ctx.sessionId);
      if (!m) return;
      try { config.onMetrics?.(ctx.sessionId, metricsSnapshot(m)); } catch { /* swallow */ }
      sessions.delete(ctx.sessionId);
    },
  };
}
```

  Confirm exact `KoiMiddleware`, `TurnContext`, `SessionContext`, `ToolRequest`, `ToolResponse`, `ModelStreamChunk` shapes from `@koi/core` before final implementation. The above is the scaffold — port from v1 `monitor.ts` for the precise field names and guard conditions, but cross-check against current L0.

- [ ] **Step 3: Tests pass.** Run `bun --cwd packages/lib/agent-monitor test`.

- [ ] **Step 4: Commit.**

---

## Task 8 — End-to-end MW chain test

- [ ] **Step 1:** `src/__tests__/e2e-mw.test.ts`. Wire `createAgentMonitorMiddleware` into a hand-rolled middleware harness (`callMiddleware(mw, ctx, request, next)`); simulate a full session: `onSessionStart` → `onBeforeTurn` → 3× `wrapToolCall` (one error, one denied, one normal) → `wrapModelStream` chunks (5 latency samples + 1 outlier) → `onSessionEnd`. Assert exact set of fired signals + final `onMetrics` summary fields.

- [ ] **Step 2: Tests pass.** Commit.

---

## Task 9 — Index exports + repo gates

- [ ] **Step 1: `src/index.ts`**

```typescript
export { createAgentMonitorMiddleware } from "./monitor.js";
export {
  validateAgentMonitorConfig,
  DEFAULT_THRESHOLDS,
} from "./config.js";
export type {
  AgentMonitorConfig,
  AgentMonitorThresholds,
} from "./config.js";
export type { SessionMetricsSummary } from "./types.js";
```

- [ ] **Step 2: Repo gates**

```bash
bun --cwd packages/lib/agent-monitor test
bun --cwd packages/lib/agent-monitor run typecheck
bun --cwd packages/lib/agent-monitor run build
bun --cwd packages/lib/agent-monitor run lint
bun run check:layers
bun run check:unused
bun run check:duplicates
```

All exit 0.

- [ ] **Step 3: Commit any cleanups.**

---

## Task 10 — Wire to `@koi/runtime` (golden coverage)

- [ ] **Step 1:** Add dep + tsconfig reference in `packages/meta/runtime/{package.json,tsconfig.json}`. `bun install`.

- [ ] **Step 2: Add golden tests** in `packages/meta/runtime/src/__tests__/golden-replay.test.ts`:

```typescript
describe("Golden: @koi/agent-monitor", () => {
  test("fires tool_rate_exceeded after >maxToolCallsPerTurn calls", async () => {
    const { createAgentMonitorMiddleware } = await import("@koi/agent-monitor");
    const signals: string[] = [];
    const mw = createAgentMonitorMiddleware({
      thresholds: { maxToolCallsPerTurn: 2 },
      onAnomaly: (s) => signals.push(s.kind),
    });
    // hand-roll: onSessionStart → onBeforeTurn → 3 wrapToolCall → flush microtasks
    // assert signals.includes("tool_rate_exceeded")
  });

  test("fires model_latency_anomaly after warm-up + outlier sample", async () => {
    // similar shape: 5× ~100ms streams, 1× 1000ms stream → expect signal
  });
});
```

- [ ] **Step 3: Optionally add a recorded cassette + trajectory** to `packages/meta/runtime/scripts/record-cassettes.ts` named `agent-monitor` for the full live-LLM replay test. If skipping, document why.

- [ ] **Step 4:** Run runtime tests + `bun run check:orphans && bun run check:golden-queries`.

- [ ] **Step 5: Commit.**

---

## Task 11 — Doctor integration (verify)

**Spec section:** "Doctor integration".

Confirm the `rogue-agents:no-agent-monitor` doctor rule already exists in `@koi/doctor` (or wherever doctor rules live). If it does:

- [ ] **Step 1: Add a test** in the doctor package that asserts (a) rule fires when `manifest.delegation.enabled === true` and no monitor middleware is present; (b) rule is silent when middleware named `"agent-monitor"` (or alias `"monitor"`) is present.

- [ ] **Step 2: Run doctor tests.** Commit if anything changed.

If the rule does **not** yet exist, add a TODO note in the PR and link a follow-up issue rather than expanding scope here.

---

## Task 12 — PR

- [ ] Push, open PR titled `feat(agent-monitor): 12 OWASP-ASI10 anomaly signals (#1378)`. Body:
  - 12 signals implemented per `docs/L2/agent-monitor.md`.
  - Pure observer middleware, `priority: 350`, never blocks/throws.
  - Welford O(1) statistics; bounded memory per session.
  - Wired into `@koi/runtime` with 2 golden assertions.
  - Closes part 3 of #1378.
