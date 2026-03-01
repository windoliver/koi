# @koi/security-analyzer — Dynamic Risk Classification for Tool Calls

`@koi/security-analyzer` is an L2 package that evaluates tool calls and assigns a
`RiskLevel` before the human-in-the-loop approval prompt appears. It separates
**risk assessment** from **enforcement**, so analyzers (rules, LLM, composite) are
swappable without touching the approval UI or middleware logic.

---

## Why it exists

`@koi/exec-approvals` and `@koi/middleware-permissions` already handle enforcement —
progressive decisions, allow/deny/ask tiers, circuit breaking. What they lacked was
**context**: when a user is shown an approval prompt for `bash("rm -rf /home")`, they
received no signal about *why* this call might be risky.

`@koi/security-analyzer` fills that gap:

```
Before                              After
──────────────────────────────      ────────────────────────────────────
bash("rm -rf /home") triggers ask   bash("rm -rf /home") triggers ask
                                     │
                                     ▼ SecurityAnalyzer runs first
                                    ┌──────────────────────────────┐
                                    │ RiskAnalysis                 │
                                    │ riskLevel: "high"            │
                                    │ findings:                    │
                                    │   - "rm -rf" matched         │
                                    │ rationale: "1 pattern match" │
                                    └──────────────────────────────┘
                                     │
onAsk({ toolId, input,               ▼
        matchedPattern })            onAsk({ toolId, input,
                                            matchedPattern,
                                            riskAnalysis })  ← enriched
```

Additionally: `critical` risk auto-denies without ever prompting — zero user
interaction overhead for truly dangerous calls.

---

## Architecture

### Layer position

```
L0  @koi/core                ─ SecurityAnalyzer, RiskAnalysis,
                                RiskLevel, RiskFinding (types only)
L2  @koi/security-analyzer   ─ this package
L2  @koi/exec-approvals      ─ consumer (ExecApprovalRequest enriched with riskAnalysis)
L2  @koi/middleware-permissions ─ consumer (optional, same HOF)
```

`@koi/security-analyzer` imports only from `@koi/core`. It never touches `@koi/engine`
(L1) and has zero peer L2 dependencies.

### Internal module map

```
index.ts              ← public re-exports
│
├── rules.ts          ← createRulesSecurityAnalyzer()
│                        DEFAULT_HIGH_RISK_PATTERNS
│                        DEFAULT_MEDIUM_RISK_PATTERNS
│                        defaultExtractCommand()
│                        maxRiskLevel()
│
├── composite.ts      ← createCompositeSecurityAnalyzer()
│                        parallel Promise.all, take max risk
│
├── monitor-bridge.ts ← createMonitorBridgeAnalyzer()
│                        elevates risk when agent-monitor
│                        reports recent anomalies
│
└── hof.ts            ← withRiskAnalysis()
                         higher-order function that wraps
                         any onAsk handler with analyzer
                         pre-processing
```

---

## How it works

### The risk levels

```
  unknown ──── low ──── medium ──── high ──── critical
     │                                            │
  analyzer                                   auto-deny
  error or                                (never prompts
  timeout                                    the user)
  (fail-open)
```

| Level | Meaning | What exec-approvals does |
|-------|---------|--------------------------|
| `low` | No risky patterns found | `onAsk` called normally |
| `medium` | Network fetch, package install | `onAsk` called with enriched context |
| `high` | sudo, rm -rf, chmod 777, eval | `onAsk` called with enriched context |
| `critical` | Classified critical by a custom analyzer | Auto-deny, `onAsk` never called |
| `unknown` | Analyzer timed out or threw | Fail-open: `onAsk` called normally |

### Tool call flow with SecurityAnalyzer

```
Agent → bash("sudo rm -rf /home")
           │
           ▼
    [exec-approvals]
     ask-tier match: "bash"
           │
           ▼ (only on ask-tier — zero cost for allow/deny paths)
    [SecurityAnalyzer.analyze("bash", { command: "sudo rm -rf /home" })]
           │
           ├── timeout? → RISK_ANALYSIS_UNKNOWN (fail-open)
           ├── throws?  → RISK_ANALYSIS_UNKNOWN (fail-open)
           │
           ▼
    RiskAnalysis {
      riskLevel: "high",
      findings: [
        { pattern: "sudo",   riskLevel: "high" },
        { pattern: "rm -rf", riskLevel: "high" },
      ],
      rationale: "2 pattern(s) matched"
    }
           │
    riskLevel === "critical"? ──yes──▶ throw PERMISSION (auto-deny)
           │ no
           ▼
    onAsk({
      toolId: "bash",
      input: { command: "sudo rm -rf /home" },
      matchedPattern: "bash",
      riskAnalysis: { riskLevel: "high", findings: [...] }
    })
           │
    user sees enriched prompt
```

### Analyzer runs only on the ask-tier

```
Tier         SecurityAnalyzer called?
──────────   ────────────────────────
allow-tier   NO  (zero overhead)
deny-tier    NO  (zero overhead)
ask-tier     YES (before onAsk)
```

### Fail-open semantics

The analyzer is never on the critical path for correctness. If it errors or times
out, `riskAnalysis` is set to `RISK_ANALYSIS_UNKNOWN` and `onAsk` still runs — the
user still gets to decide. No tool calls are silently blocked due to analyzer failure.

```
analyzer timeout (>2000ms) → riskLevel: "unknown" → onAsk still fires
analyzer throws             → riskLevel: "unknown" → onAsk still fires
```

---

## The `SecurityAnalyzer` interface (L0)

Defined in `@koi/core/security-analyzer`:

```typescript
interface SecurityAnalyzer {
  readonly analyze: (
    toolId: string,
    input: JsonObject,
    context?: JsonObject,  // session/turn metadata (sessionId, agentId, etc.)
  ) => RiskAnalysis | Promise<RiskAnalysis>;
}

interface RiskAnalysis {
  readonly riskLevel: RiskLevel;              // max across all findings
  readonly findings: readonly RiskFinding[];
  readonly rationale: string;                 // shown in approval prompts
}

interface RiskFinding {
  readonly pattern: string;      // e.g. "rm -rf"
  readonly description: string;
  readonly riskLevel: RiskLevel;
}

type RiskLevel = "low" | "medium" | "high" | "critical" | "unknown";
```

Return type is `RiskAnalysis | Promise<RiskAnalysis>` — implementations can be
synchronous (rules-based) or asynchronous (LLM, remote API) without changing callers.

---

## Built-in analyzers

### `createRulesSecurityAnalyzer(config?)`

Fast synchronous pattern matcher. Pre-compiles RegExps at construction time — sub-millisecond per call, no async, no I/O.

```typescript
import { createRulesSecurityAnalyzer } from "@koi/security-analyzer";

const analyzer = createRulesSecurityAnalyzer();

// or with custom patterns:
const custom = createRulesSecurityAnalyzer({
  highPatterns: ["DROP TABLE", "DELETE FROM", "TRUNCATE"],
  mediumPatterns: ["UPDATE", "INSERT", "BEGIN TRANSACTION"],
  extractCommand: (toolId, input) =>
    typeof input.query === "string" ? `${toolId} ${input.query}` : toolId,
});
```

#### Default high-risk patterns

| Pattern | Why |
|---------|-----|
| `rm -rf` | Recursive deletion |
| `sudo` | Privilege escalation |
| `chmod 777` | World-writable permissions |
| `chmod +s` | Setuid bit |
| `> /dev/` | Direct device write |
| `dd if=` | Raw disk access |
| `mkfs` | Format filesystem |
| `shred` | Secure deletion |
| `:(){:\|:&};:` | Fork bomb |
| `eval(` | Code injection |
| `exec(` | Code execution |

#### Default medium-risk patterns

`curl`, `wget`, `git clone`, `npm install`, `pip install`, `apt-get`, `brew install`, `chmod`, `chown`

#### `extractCommand(toolId, input)`

Controls what string the patterns are matched against. Defaults to:
1. `input.command` if it's a string
2. `input.cmd` if it's a string
3. `input.args` if it's a string
4. `${toolId} ${JSON.stringify(input)}` as fallback

Override to match tool-specific input shapes (SQL queries, API parameters, etc.).

---

### `createCompositeSecurityAnalyzer(analyzers)`

Runs multiple analyzers **in parallel** via `Promise.all` and takes the maximum risk level across all results.

```
                    CompositeSecurityAnalyzer
                    ┌─────────────────────────┐
  tool call ──────► │  Promise.all             │
                    └──┬──────────┬────────────┘
                       │          │
                  RulesAnalyzer  LLMAnalyzer   (future)
                  sync, fast     async, deep
                       │          │
                       └────┬─────┘
                            │  maxRiskLevel()
                            ▼
                     RiskAnalysis { riskLevel: "high" }
```

Total latency = slowest single analyzer (not the sum).

```typescript
import {
  createCompositeSecurityAnalyzer,
  createRulesSecurityAnalyzer,
} from "@koi/security-analyzer";

const analyzer = createCompositeSecurityAnalyzer([
  createRulesSecurityAnalyzer(),
  myLlmAnalyzer,      // hypothetical async LLM classifier
]);
```

---

### `createMonitorBridgeAnalyzer(config)`

Wraps another analyzer and elevates risk when `@koi/agent-monitor` has recently
detected anomalies in the current session. Decoupled from `@koi/agent-monitor` via a
callback — no L2-to-L2 dependency.

```
Session history has anomalies?   Tool call risk
─────────────────────────────    ──────────────
No anomalies                  →  base analysis unchanged
1+ anomalies                  →  riskLevel = max(base, "high")
callback throws               →  fail-open, base analysis unchanged
no sessionId in context       →  base analysis unchanged
```

```typescript
import {
  createMonitorBridgeAnalyzer,
  createRulesSecurityAnalyzer,
} from "@koi/security-analyzer";

// monitor is an AgentMonitor instance from @koi/agent-monitor
const recentSignals = new Map<string, AnomalySignal[]>();

monitor.onAnomaly = (signal) => {
  const bucket = recentSignals.get(signal.sessionId) ?? [];
  recentSignals.set(signal.sessionId, [...bucket, signal]);
};

const analyzer = createMonitorBridgeAnalyzer({
  wrapped: createRulesSecurityAnalyzer(),
  getRecentAnomalies: (sessionId) => recentSignals.get(sessionId) ?? [],
  // optional: only elevate on specific anomaly kinds
  elevateOnAnomalyKinds: ["denied_tool_calls", "tool_rate_exceeded"],
});
```

**Effect on risk level:**

```
agent previously hit denied_tool_calls anomaly
     │
     ▼
bash("ls")
     │
base analysis:     riskLevel: "low"   (harmless command)
bridge elevation:  riskLevel: "high"  (session context suspicious)
     │
onAsk shows:  ⚠ HIGH RISK — 1 recent anomaly signal(s) detected
```

---

## `withRiskAnalysis` HOF

Utility for wiring a `SecurityAnalyzer` into any `onAsk`-style handler. Used internally
by `@koi/exec-approvals` and available for direct use in `@koi/middleware-permissions`.

```typescript
import { withRiskAnalysis } from "@koi/security-analyzer";

const wrappedOnAsk = withRiskAnalysis(
  analyzer,
  originalOnAsk,
  2000, // analyzerTimeoutMs, default 2000
);

// wrappedOnAsk has the same signature as originalOnAsk,
// but the request object will have riskAnalysis attached.
```

**Behavior:**

```
wrappedOnAsk(req)
    │
    ├── run analyzer with timeout
    │     ├── times out → RISK_ANALYSIS_UNKNOWN
    │     └── throws    → RISK_ANALYSIS_UNKNOWN
    │
    ├── riskLevel === "critical"?
    │     YES → return { kind: "deny_once", reason: "Critical risk: ..." }
    │           (onAsk never called)
    │
    └── NO → onAsk({ ...req, riskAnalysis })
```

---

## Integrating with `@koi/exec-approvals`

Add `securityAnalyzer` to `ExecApprovalsConfig`:

```typescript
import { createExecApprovalsMiddleware } from "@koi/exec-approvals";
import { createRulesSecurityAnalyzer } from "@koi/security-analyzer";

const mw = createExecApprovalsMiddleware({
  rules: {
    allow: ["read_file", "list_dir"],
    deny: [],
    ask: ["bash", "write_file", "delete_file"],
  },
  onAsk: async (req) => {
    // req.riskAnalysis is now populated when securityAnalyzer is configured
    const risk = req.riskAnalysis;
    console.log(`[${risk?.riskLevel ?? "no-analysis"}] ${req.toolId}: ${risk?.rationale}`);

    // your approval UI here — show riskLevel, findings, rationale to the user
    return { kind: "allow_once" };
  },
  securityAnalyzer: createRulesSecurityAnalyzer(),
  analyzerTimeoutMs: 2000,  // default
});
```

`riskAnalysis` is `undefined` on the request when no `securityAnalyzer` is configured —
fully backwards-compatible.

### `ExecApprovalRequest` shape

```typescript
interface ExecApprovalRequest {
  readonly toolId: string;
  readonly input: JsonObject;
  readonly matchedPattern: string;
  readonly riskAnalysis?: RiskAnalysis;  // present when securityAnalyzer configured
}
```

---

## Composing with `@koi/agent-monitor`

```
                     Agent session
                     ─────────────
  tool call ──► [agent-monitor] ──► observes behavior
                     │
                     │ onAnomaly fires → store in recentSignals map
                     │
  (next tool call)
  tool call ──► [exec-approvals / ask-tier]
                     │
                     ▼
             [MonitorBridgeAnalyzer]
                     │
                     ├── getRecentAnomalies(sessionId)
                     │   └── returns stored signals
                     │
                     ├── anomalies present? → elevate to "high"
                     └── no anomalies?      → delegate to wrapped
                          │
                          ▼
                    [RulesAnalyzer]
                    pattern matching
                          │
                          ▼
                    RiskAnalysis → onAsk (enriched)
```

The monitor observes passively (fire-and-forget). The bridge reads that signal at
approval time. The two packages remain fully decoupled.

---

## API reference

### `createRulesSecurityAnalyzer(config?)`

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `extractCommand` | `(toolId, input) => string` | `defaultExtractCommand` | Derive match target from input |
| `highPatterns` | `readonly string[]` | `DEFAULT_HIGH_RISK_PATTERNS` | Patterns → riskLevel "high" |
| `mediumPatterns` | `readonly string[]` | `DEFAULT_MEDIUM_RISK_PATTERNS` | Patterns → riskLevel "medium" |

Returns: `SecurityAnalyzer` (synchronous `analyze`)

### `createCompositeSecurityAnalyzer(analyzers)`

| Param | Type | Description |
|-------|------|-------------|
| `analyzers` | `readonly SecurityAnalyzer[]` | All run in parallel; empty → `riskLevel: "low"` |

Returns: `SecurityAnalyzer` (async `analyze`)

### `createMonitorBridgeAnalyzer(config)`

| Config | Type | Description |
|--------|------|-------------|
| `wrapped` | `SecurityAnalyzer` | Underlying analyzer to delegate to |
| `getRecentAnomalies` | `(sessionId: string) => readonly AnomalySignalLike[]` | Callback bridge — must be synchronous |
| `elevateOnAnomalyKinds` | `readonly string[]` | Which anomaly kinds trigger elevation; default: all |

Returns: `SecurityAnalyzer` (async `analyze`)

### `withRiskAnalysis(analyzer, onAsk, timeoutMs?)`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `analyzer` | `SecurityAnalyzer` | — | Classifier to run before `onAsk` |
| `onAsk` | `(req & { riskAnalysis }) => Promise<TDecision>` | — | Original handler |
| `timeoutMs` | `number` | `2000` | Analyzer timeout; exceeded → `RISK_ANALYSIS_UNKNOWN` |

Returns: `(req) => Promise<TDecision>` — same signature as `onAsk`

### Exported constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_HIGH_RISK_PATTERNS` | `readonly string[]` | 11 built-in high-risk shell patterns |
| `DEFAULT_MEDIUM_RISK_PATTERNS` | `readonly string[]` | 9 built-in medium-risk patterns |
| `DEFAULT_ANALYZER_TIMEOUT_MS` | `2000` | Default analyzer timeout |
| `RISK_ANALYSIS_UNKNOWN` | `RiskAnalysis` | Sentinel for fail-open cases |
| `RISK_LEVEL_ORDER` | `readonly RiskLevel[]` | Canonical ordering for comparison |

---

## Examples

### 1. Rules analyzer with exec-approvals

```typescript
import { createExecApprovalsMiddleware } from "@koi/exec-approvals";
import { createRulesSecurityAnalyzer } from "@koi/security-analyzer";

const mw = createExecApprovalsMiddleware({
  rules: { allow: [], deny: [], ask: ["bash"] },
  onAsk: async (req) => {
    if (req.riskAnalysis?.riskLevel === "high") {
      // Show rich warning in your approval UI
      console.warn(`⚠ HIGH RISK: ${req.riskAnalysis.rationale}`);
      for (const f of req.riskAnalysis.findings) {
        console.warn(`  pattern matched: "${f.pattern}"`);
      }
    }
    return { kind: "allow_once" };
  },
  securityAnalyzer: createRulesSecurityAnalyzer(),
});
```

### 2. Custom SQL injection detector

```typescript
const sqlAnalyzer = createRulesSecurityAnalyzer({
  highPatterns: ["DROP TABLE", "DROP DATABASE", "TRUNCATE"],
  mediumPatterns: ["DELETE FROM", "UPDATE.*SET", "INSERT INTO"],
  extractCommand: (_toolId, input) =>
    typeof input.query === "string" ? input.query : JSON.stringify(input),
});
```

### 3. Composite: rules + LLM (hypothetical)

```typescript
import { createCompositeSecurityAnalyzer, createRulesSecurityAnalyzer } from "@koi/security-analyzer";
import type { SecurityAnalyzer, RiskAnalysis } from "@koi/core";

// Fast rules check runs in parallel with the async LLM check
const llmAnalyzer: SecurityAnalyzer = {
  analyze: async (toolId, input) => {
    const verdict = await askLlm(`Is this tool call risky? ${toolId} ${JSON.stringify(input)}`);
    return verdict;
  },
};

const analyzer = createCompositeSecurityAnalyzer([
  createRulesSecurityAnalyzer(),  // sync, < 1ms
  llmAnalyzer,                    // async, ~500ms
  // total latency ≈ 500ms (parallel), not 501ms (sequential)
]);
```

### 4. Monitor bridge — session-aware risk elevation

```typescript
import {
  createMonitorBridgeAnalyzer,
  createRulesSecurityAnalyzer,
} from "@koi/security-analyzer";
import { createAgentMonitorMiddleware } from "@koi/agent-monitor";

const recentAnomalies = new Map<string, AnomalySignal[]>();

const monitorMw = createAgentMonitorMiddleware({
  onAnomaly: (signal) => {
    const prev = recentAnomalies.get(String(signal.sessionId)) ?? [];
    recentAnomalies.set(String(signal.sessionId), [...prev, signal]);
  },
});

const securityMw = createExecApprovalsMiddleware({
  rules: { allow: [], deny: [], ask: ["bash"] },
  onAsk: async (req) => {
    console.log("risk:", req.riskAnalysis?.riskLevel);
    return { kind: "allow_once" };
  },
  securityAnalyzer: createMonitorBridgeAnalyzer({
    wrapped: createRulesSecurityAnalyzer(),
    getRecentAnomalies: (sessionId) =>
      recentAnomalies.get(sessionId) ?? [],
  }),
});

// Register both in the agent:
// middleware: [monitorMw, securityMw]
```

---

## Layer compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    SecurityAnalyzer, RiskAnalysis, RiskFinding,            │
    RiskLevel, RISK_ANALYSIS_UNKNOWN, RISK_LEVEL_ORDER      │
                                                            │
L2  @koi/security-analyzer ◄────────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports @koi/exec-approvals or other L2 peers
    ✗ zero external dependencies

L2  @koi/exec-approvals ◄──────────────────────────────────
    imports SecurityAnalyzer interface from @koi/core (L0)
    accepts SecurityAnalyzer as optional config field
    does NOT import @koi/security-analyzer directly
```

The `@koi/exec-approvals` middleware receives a `SecurityAnalyzer` via its config
(dependency injection). It never imports `@koi/security-analyzer` at runtime — the
interface comes from L0.

---

## Related packages

| Package | Relationship |
|---------|-------------|
| `@koi/exec-approvals` | Primary consumer — `ExecApprovalRequest.riskAnalysis` |
| `@koi/middleware-permissions` | Secondary consumer — same `withRiskAnalysis` HOF |
| `@koi/agent-monitor` | Data source for `createMonitorBridgeAnalyzer` |
| `@koi/core` | Defines `SecurityAnalyzer`, `RiskAnalysis`, `RiskLevel` (L0) |
