# @koi/doctor — Agent Security Scanner

`@koi/doctor` is an L2 package that statically analyzes an `AgentManifest` against the
[OWASP Agentic Security Initiative Top 10 (Dec 2025)](https://genai.owasp.org/llmrisk/agentic-ai/).
It runs 30 built-in rules across all 10 threat axes, produces structured findings, and exports
SARIF for GitHub Code Scanning.

---

## Why it exists

An agent manifest is a declarative security posture.
`@koi/doctor` makes misconfigurations **visible before runtime** — the same way a compiler
catches type errors before the program runs.

```
                 Your agent manifest
                        │
                        ▼
              ┌─────────────────┐
              │  @koi/doctor    │
              │  30 rules       │
              │  OWASP ASI01–10 │
              └────────┬────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
    DoctorReport    SARIF file    advisoryError?
    (findings,      (GitHub       (CVE feed
    healthy,        Code Scan)    failures)
    owaspSummary)
```

---

## Architecture

### Layer position

```
L0  @koi/core        ─ AgentManifest, JsonObject (types only)
L2  @koi/doctor      ─ this package (no L1 dependency)
```

`@koi/doctor` only imports from `@koi/core`. It never touches `@koi/engine` (L1).
This means it can be run in any environment — CLI, CI, IDE plugin — without spinning up
the runtime.

### Internal module map

```
index.ts                 ← public re-exports
│
├── config.ts            ← validate + resolve DoctorConfig → ResolvedDoctorConfig
├── context.ts           ← lazy memoized DoctorContext from manifest
├── owasp.ts             ← aggregate findings → owaspSummary[]
├── metadata.ts          ← getMetadataKey() helper (safe unknown accessor)
├── sarif.ts             ← mapDoctorReportToSarif()
├── types.ts             ← all public types
├── runner.ts            ← createDoctor() + rule execution engine
└── rules/
    ├── index.ts         ← getBuiltinRules() (aggregates all 30)
    ├── goal-hijack.ts   ← ASI01 (2 rules)
    ├── tool-misuse.ts   ← ASI02 (3 rules)
    ├── code-execution.ts← ASI05 (3 rules)
    ├── privilege-abuse.ts← ASI03 (3 rules)
    ├── inter-agent-comms.ts ← ASI07 (4 rules)
    ├── supply-chain.ts  ← ASI04 (4 rules)
    ├── memory-poisoning.ts  ← ASI06 (2 rules)
    ├── cascading-failures.ts← ASI08 (3 rules)
    ├── human-trust.ts   ← ASI09 (2 rules)
    └── rogue-agents.ts  ← ASI10 (4 rules)
```

### Data flow

```
DoctorConfig
     │
     ▼
resolveConfig()          ─ fills defaults, validates
     │
     ▼
buildContext()           ─ wraps manifest in lazy accessor
     │
     ├──→ getBuiltinRules()   filtered by enabledCategories
     │    + customRules
     │
     ▼
Promise.allSettled(       ─ runs all rules concurrently
  rules.map(rule =>
    Promise.race([
      rule.check(ctx),
      timeout(ruleTimeoutMs),
      globalAbort,
    ])
  )
)
     │                     ─ concurrent with rules
     ├──→ runAdvisoryCallback()
     │
     ▼
collectResults()          ─ partitions fulfilled / rejected / timed-out
     │
     ▼
applySeverityOverrides()
applyThreshold()
applyMaxFindings()
computeOwaspSummary()
     │
     ▼
DoctorReport
```

---

## The 30 built-in rules

### Threat taxonomy (5 categories × OWASP IDs)

```
GOAL_INTEGRITY   ← ASI01: prompt injection, goal hijack
TOOL_SAFETY      ← ASI02: tool misuse, code execution (ASI05)
ACCESS_CONTROL   ← ASI03: privilege abuse, inter-agent auth (ASI07)
SUPPLY_CHAIN     ← ASI04: dependency & forge hygiene
RESILIENCE       ← ASI06: memory poisoning
                   ASI08: cascading failures / DoS
                   ASI09: human oversight
                   ASI10: rogue / unmonitored agents
```

### Full rule table

| Rule ID | OWASP | Severity | Fires when… |
|---|---|---|---|
| `goal-hijack:missing-sanitize-middleware` | ASI01 | HIGH | no `sanitize` middleware |
| `goal-hijack:missing-guardrails-middleware` | ASI01 | MEDIUM | no `guardrails` middleware |
| `goal-hijack:no-model-defense` | ASI01 | MEDIUM | `model.options.defense` not set |
| `tool-misuse:wildcard-allow` | ASI02 | CRITICAL | `permissions.allow` contains `"*"` |
| `tool-misuse:no-deny-list` | ASI02 | MEDIUM | no `permissions.deny` |
| `tool-misuse:dangerous-tool-names` | ASI02 | HIGH | tools named `exec`/`eval`/`shell` without sandbox |
| `code-execution:missing-sandbox-middleware` | ASI05 | HIGH | no `sandbox` middleware with code-exec tools |
| `code-execution:no-permissions-middleware` | ASI05 | MEDIUM | no `permissions` middleware |
| `code-execution:no-redaction-middleware` | ASI05 | MEDIUM | no `redaction` middleware when tools configured |
| `privilege-abuse:overly-broad-permissions` | ASI03 | MEDIUM | allow list has >10 tools |
| `privilege-abuse:no-permissions-config` | ASI03 | HIGH | no `permissions` block at all |
| `privilege-abuse:no-human-in-loop` | ASI03 | LOW | `permissions.ask` is empty |
| `insecure-delegation:unsigned-grants` | ASI07 | HIGH | delegation on but no `DELEGATION_SECRET` env key |
| `insecure-delegation:excessive-chain-depth` | ASI07 | MEDIUM | `maxChainDepth > 5` |
| `insecure-delegation:long-ttl` | ASI07 | LOW | `defaultTtlMs > 24h` |
| `insecure-delegation:no-a2a-auth` | ASI07 | HIGH | delegation on but no `a2a-auth` middleware |
| `supply-chain:known-vulnerable-patterns` | ASI04 | HIGH | dependencies match known-bad names/patterns |
| `supply-chain:excessive-dependencies` | ASI04 | LOW | >50 runtime dependencies |
| `supply-chain:no-dependency-audit` | ASI04 | MEDIUM | no advisory callback configured |
| `supply-chain:forge-verification-disabled` | ASI04 | HIGH | `metadata.forge.verification` absent or false |
| `memory-poisoning:memory-without-sanitize` | ASI06 | HIGH | `memory` middleware present but no `sanitize` |
| `memory-poisoning:unbounded-memory-context` | ASI06 | MEDIUM | memory used but no `compactor` middleware |
| `cascading-failures:no-call-limits` | ASI08 | HIGH | no `call-limits` middleware |
| `cascading-failures:no-circuit-breaker` | ASI08 | MEDIUM | delegation on but no circuit breaker |
| `cascading-failures:no-budget-limits` | ASI08 | MEDIUM | no `budget`/`pay` middleware or `maxCostUsd` |
| `human-trust:no-turn-acknowledgement` | ASI09 | MEDIUM | no `turn-ack` middleware and empty `ask` list |
| `human-trust:no-audit-trail` | ASI09 | MEDIUM | no `audit` middleware |
| `rogue-agents:no-governance` | ASI10 | HIGH | delegation on but no `governance` middleware |
| `rogue-agents:no-agent-monitor` | ASI10 | MEDIUM | delegation on but no `agent-monitor` middleware |
| `rogue-agents:no-turn-ack-with-delegation` | ASI10 | MEDIUM | delegation on but no `turn-ack` middleware |

---

## API

### `createDoctor(config)`

```typescript
import { createDoctor } from "@koi/doctor";

const doctor = createDoctor({
  manifest,                          // required: AgentManifest
  dependencies,                      // optional: Dependency[]
  envKeys,                           // optional: Set<string>
  enabledCategories,                 // optional: DoctorCategory[] (all if omitted)
  customRules,                       // optional: DoctorRule[]
  severityThreshold,                 // optional: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  severityOverrides,                 // optional: Record<string, Severity>
  maxFindings,                       // optional: number (default 500)
  ruleTimeoutMs,                     // optional: number (default 5_000)
  globalTimeoutMs,                   // optional: number (default 30_000)
  advisoryCallback,                  // optional: (deps) => DoctorFinding[] | Promise<>
});

const report = await doctor.run();
```

### `DoctorReport`

```typescript
interface DoctorReport {
  readonly healthy: boolean;          // true iff findings.length === 0
  readonly findings: DoctorFinding[]; // ordered by severity desc
  readonly ruleErrors: DoctorRuleError[];
  readonly rulesApplied: number;
  readonly owaspSummary: OwaspSummaryEntry[];
  readonly truncationWarning: boolean;
  readonly advisoryError?: string;    // set if advisoryCallback threw
}
```

### `mapDoctorReportToSarif(report, version?)`

```typescript
import { mapDoctorReportToSarif } from "@koi/doctor";

const sarif = mapDoctorReportToSarif(report, "1.2.3");
await Bun.write("results.sarif", JSON.stringify(sarif, null, 2));
```

---

## Examples

### 1. Minimal check in a deploy script

```typescript
import { createDoctor } from "@koi/doctor";
import { loadManifest } from "@koi/manifest";

const manifest = await loadManifest("./agent.yaml");
const doctor = createDoctor({ manifest });
const report = await doctor.run();

if (!report.healthy) {
  for (const f of report.findings) {
    console.error(`[${f.severity}] ${f.rule}: ${f.message}`);
  }
  process.exit(1);
}
```

### 2. Block deploys on CRITICAL/HIGH only

```typescript
const doctor = createDoctor({
  manifest,
  severityThreshold: "HIGH",   // ignore MEDIUM and LOW
});
const report = await doctor.run();
// report.findings contains only HIGH and CRITICAL
```

### 3. Downgrade a known-acceptable rule

```typescript
// Your team accepts wildcard allow in dev environments
const doctor = createDoctor({
  manifest,
  severityOverrides: {
    "tool-misuse:wildcard-allow": "LOW",
  },
  severityThreshold: "MEDIUM",
  // wildcard-allow is now LOW → filtered out at MEDIUM threshold
});
```

### 4. Plug in a CVE feed (OSV, Snyk, etc.)

```typescript
const doctor = createDoctor({
  manifest,
  dependencies: readPackageLockDeps(),    // your own dep parser
  advisoryCallback: async (deps) => {
    const results = await fetchOsvBatch(deps.map((d) => d.name));
    return results.map((r) => ({
      rule: `advisory:${r.id}`,
      severity: "HIGH",
      category: "SUPPLY_CHAIN",
      message: r.summary,
      owasp: ["ASI04"],
    }));
  },
});
```

If the advisory feed is unavailable, `report.advisoryError` is set but the rest
of the report is still valid — the scan is non-fatal.

### 5. Custom rule (organization policy)

```typescript
import type { DoctorRule } from "@koi/doctor";

const requireTelemetry: DoctorRule = {
  name: "policy:no-telemetry-middleware",
  category: "RESILIENCE",
  defaultSeverity: "MEDIUM",
  owasp: ["ASI09"],
  check: (ctx) => {
    if (ctx.middlewareNames().has("telemetry")) return [];
    return [{
      rule: "policy:no-telemetry-middleware",
      severity: "MEDIUM",
      category: "RESILIENCE",
      message: "Agents must include telemetry middleware per infra policy",
      fix: "Add { name: 'telemetry' } to manifest.middleware",
      owasp: ["ASI09"],
    }];
  },
};

const doctor = createDoctor({ manifest, customRules: [requireTelemetry] });
```

### 6. Export SARIF for GitHub Code Scanning

```yaml
# .github/workflows/agent-scan.yml
- name: Scan agent manifests
  run: bun run scan:agents

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: results.sarif
```

```typescript
// scripts/scan-agents.ts
import { createDoctor, mapDoctorReportToSarif } from "@koi/doctor";

const report = await createDoctor({ manifest }).run();
const sarif = mapDoctorReportToSarif(report, process.env.npm_package_version);
await Bun.write("results.sarif", JSON.stringify(sarif, null, 2));
```

---

## Writing a new rule

Every rule is a plain object. No class, no inheritance.

```typescript
// packages/doctor/src/rules/my-category.ts

import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

function checkMyPolicy(ctx: DoctorContext): readonly DoctorFinding[] {
  // ctx.manifest          — raw AgentManifest
  // ctx.middlewareNames() — memoized Set<string> of middleware names
  // ctx.toolNames()       — memoized Set<string> of tool names
  // ctx.dependencies      — Dependency[] (if provided)
  // ctx.envKeys           — Set<string> of present env vars

  if (ctx.middlewareNames().has("required-mw")) return [];

  return [{
    rule: "my-category:missing-required-mw",
    severity: "HIGH",
    category: "RESILIENCE",
    message: "required-mw is missing — explain the risk here",
    fix: "Add { name: 'required-mw' } to manifest.middleware",
    owasp: ["ASI08"],
    path: "middleware",      // optional: JSON path hint
  }];
}

export const myRules: readonly DoctorRule[] = [{
  name: "my-category:missing-required-mw",
  category: "RESILIENCE",
  defaultSeverity: "HIGH",
  owasp: ["ASI08"],
  check: checkMyPolicy,
}];
```

Then register it in `rules/index.ts`:

```typescript
import { myRules } from "./my-category.js";

const ALL_RULES: readonly DoctorRule[] = [
  ...existingRules,
  ...myRules,
];
```

**Rule authoring invariants:**

- `check()` must be pure — no side effects, no I/O
- Return `[]` (not `null`/`undefined`) when the rule passes
- The `rule` field in the finding must exactly match the rule's `name`
- Add a unit test colocated at `rules/my-category.test.ts`

---

## Execution model

```
createDoctor(config)
       │
       └── .run()
             │
    ┌────────┴──────────────────────────────────────────────┐
    │   Promise.allSettled([                                │
    │     ...rules.map(rule =>                              │
    │       Promise.race([                                  │
    │         rule.check(ctx),          ← the rule         │
    │         timeoutAfter(5_000),      ← per-rule cap     │
    │         globalAbort,              ← 30s hard stop    │
    │       ])                                              │
    │     ),                                                │
    │     runAdvisoryCallback(deps),    ← concurrent       │
    │   ])                                                  │
    └───────────────────────────────────────────────────────┘
             │
    ┌────────┴──────────────────────────────────────────────┐
    │  collectResults():                                    │
    │    fulfilled → findings[]                             │
    │    rejected  → ruleErrors[] (rule name + message)    │
    │    timed out → ruleErrors[] with timedOut: true       │
    └───────────────────────────────────────────────────────┘
```

**Key properties:**
- Rules cannot hang the scanner — every rule has a hard timeout
- A crashing rule records a `DoctorRuleError` but does not stop other rules
- Advisory callback failures set `report.advisoryError` but are non-fatal
- All rule checks are concurrent — 30 rules take ~rule_timeout_max, not 30×timeout

---

## The `DoctorContext` contract

```typescript
interface DoctorContext {
  readonly manifest: AgentManifest;
  readonly dependencies: readonly Dependency[];
  readonly envKeys: ReadonlySet<string>;
  readonly delegation: DelegationConfig | undefined;

  middlewareNames(): ReadonlySet<string>;   // memoized
  toolNames(): ReadonlySet<string>;         // memoized
}
```

`middlewareNames()` and `toolNames()` are lazy and memoized — computed once on first call,
reused for the lifetime of a `.run()` invocation. All 30 rules share the same context
instance per scan.

---

## OWASP summary

`report.owaspSummary` always contains exactly 10 entries (ASI01–ASI10), ordered:

```typescript
[
  { id: "ASI01", findingCount: 2, maxSeverity: "HIGH" },
  { id: "ASI02", findingCount: 3, maxSeverity: "CRITICAL" },
  { id: "ASI03", findingCount: 0, maxSeverity: null },   // ← passing axis
  // …
]
```

`findingCount: 0` means that threat axis has no problems. This makes it easy to
render a security scorecard.

---

## Secure manifest reference

A manifest that passes all 30 rules with zero CRITICAL/HIGH findings:

```typescript
const secureManifest: AgentManifest = {
  name: "my-agent",
  version: "1.0.0",
  model: {
    name: "claude-haiku",
    options: { defense: true },         // ASI01: prompt injection defense
  },
  tools: [{ name: "read_file" }],       // no exec/eval
  middleware: [
    { name: "sanitize" },               // ASI01
    { name: "guardrails" },             // ASI01
    { name: "sandbox" },                // ASI05
    { name: "permissions" },            // ASI03, ASI05
    { name: "redaction" },              // ASI05
    { name: "call-limits" },            // ASI08
    { name: "budget" },                 // ASI08
    { name: "compactor" },              // ASI06
    { name: "turn-ack" },               // ASI09, ASI10
    { name: "audit" },                  // ASI09
    { name: "governance" },             // ASI10
    { name: "agent-monitor" },          // ASI10
    { name: "a2a-auth" },               // ASI07
    { name: "memory" },
  ],
  permissions: {
    allow: ["read_file"],               // ASI02: no wildcard
    deny: ["exec"],                     // ASI02: explicit deny
    ask: ["read_file"],                 // ASI03: human-in-loop
  },
  delegation: {
    enabled: true,
    maxChainDepth: 3,                   // ASI07: ≤5
    defaultTtlMs: 3_600_000,            // ASI07: ≤24h
  },
  metadata: {
    forge: { verification: true },      // ASI04: provenance
  },
};

// Run with DELEGATION_SECRET in env for ASI07 unsigned-grants rule
const doctor = createDoctor({
  manifest: secureManifest,
  envKeys: new Set(["DELEGATION_SECRET"]),
});
const report = await doctor.run();
// report.healthy === true
```
