# @koi/forge — Self-Extension Runtime

`@koi/forge` is an L2 package that enables agents to create, verify, sign, and compose
tools, skills, and sub-agents at runtime. Every forged artifact passes a 4-stage verification
pipeline, receives a content-addressed identity, and carries SLSA v1.0–compatible provenance
metadata with optional cryptographic attestation.

---

## Why it exists

Agents need to extend their own capabilities mid-session — create a tool to parse CSV data,
compose a skill for a recurring workflow, or spawn a sub-agent for a specialized task.
`@koi/forge` makes this **safe by default**: every extension is statically analyzed,
sandbox-tested, trust-scored, and cryptographically signed before it can be used.

```
        Agent says:                         What happens:
        "Create a tool                ┌──────────────────────────┐
         that adds two       ───────> │  @koi/forge              │
         numbers"                     │                          │
                                      │  1. Static analysis      │
                                      │  2. Sandbox execution    │
                                      │  3. Self-test            │
                                      │  4. Trust scoring        │
                                      │  5. Content hash (BrickId)│
                                      │  6. Sign attestation     │
                                      │  7. Store in ForgeStore  │
                                      └────────────┬─────────────┘
                                                   │
                                                   ▼
                                      ┌──────────────────────────┐
                                      │  BrickArtifact           │
                                      │  id: sha256:a1b2c3...    │
                                      │  provenance: signed ✓    │
                                      │  trustTier: "sandbox"    │
                                      └──────────────────────────┘
                                                   │
                              ┌────────────────────┼────────────────────┐
                              ▼                    ▼                    ▼
                        Hot-attach           ForgeRuntime          SLSA export
                        (ComponentProvider)  (resolveTool)         (in-toto v1)
```

---

## Architecture

### Layer position

```
L0  @koi/core         ─ BrickArtifact, ForgeStore, ForgeProvenance, SigningBackend (types only)
L0u @koi/hash          ─ computeContentHash()
L0u @koi/test-utils    ─ DEFAULT_PROVENANCE fixture
L2  @koi/forge         ─ this package (no L1 dependency)
```

`@koi/forge` only imports from `@koi/core` (L0) and L0-utility packages.
It never touches `@koi/engine` (L1). This means forge tools can run in any
environment — CLI, test harness, CI — without the full runtime.

### Internal module map

```
index.ts                         ← public re-exports (60+ symbols)
│
├── config.ts                    ← ForgeConfig validation + defaults
├── types.ts                     ← ForgeInput, ForgeResult, VerificationReport
├── errors.ts                    ← typed ForgeError factories
│
├── tools/                       ← primordial forge tools (6 brick kinds)
│   ├── shared.ts                ← runForgePipeline(), buildBaseFields(), ForgeDeps
│   ├── forge-tool.ts            ← forge_tool
│   ├── forge-skill.ts           ← forge_skill
│   ├── forge-agent.ts           ← forge_agent
│   ├── forge-middleware.ts      ← forge_middleware
│   ├── forge-channel.ts         ← forge_channel
│   └── promote-forge.ts         ← promote_forge, search_forge
│
├── verify.ts                    ← 4-stage verification orchestrator
├── verify-static.ts             ← stage 1: static analysis
├── verify-sandbox.ts            ← stage 2: sandbox execution
├── verify-self-test.ts          ← stage 3: self-test + pluggable verifiers
├── verify-trust.ts              ← stage 4: trust assignment
│
├── attestation.ts               ← provenance creation, signing, verification
├── attestation-cache.ts         ← integrity result caching
├── integrity.ts                 ← 3-variant IntegrityResult verification
├── brick-content.ts             ← shared content extraction for hashing
├── slsa-serializer.ts           ← Koi provenance → SLSA v1.0 + in-toto Statement
│
├── governance.ts                ← depth-aware tool filtering, session limits
├── requires-check.ts            ← BrickRequires validation (bins, env, tools)
│
├── memory-store.ts              ← in-memory ForgeStore implementation
├── store-notifier.ts            ← StoreChangeNotifier (pub/sub)
│
├── forge-runtime.ts             ← ForgeRuntime (hot-load tools mid-session)
├── forge-component-provider.ts  ← ComponentProvider (hot-attach at assembly)
├── forge-resolver.ts            ← Resolver adapter for brick discovery
├── brick-conversion.ts          ← ToolArtifact → executable Tool wrapper
├── generate-skill-md.ts         ← skill body → markdown template
│
└── __tests__/
    ├── forge-lifecycle.test.ts  ← unit E2E: forge → sign → verify → resolve → tamper
    ├── e2e.test.ts              ← real LLM E2E with createKoi + forge tools
    └── e2e-provenance.test.ts   ← real LLM E2E: provenance + SLSA + attestation
```

### Data flow

```
                     forge_tool("adder", impl, schema)
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │    GOVERNANCE CHECK     │
                     │  depth ≤ maxForgeDepth? │
                     │  session < maxForges?   │
                     │  tool allowed at depth? │
                     └───────────┬────────────┘
                                 │ pass
                                 ▼
                     ┌────────────────────────┐
                     │   4-STAGE VERIFICATION  │──── fail ──> ForgeError
                     │  static → sandbox →     │
                     │  self-test → trust      │
                     └───────────┬────────────┘
                                 │ pass
                                 ▼
                     ┌────────────────────────┐
                     │   CONTENT HASH          │
                     │  SHA-256(kind + content) │
                     │  = BrickId              │
                     └───────────┬────────────┘
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │   PROVENANCE            │
                     │  who, when, what,       │
                     │  verification summary   │
                     └───────────┬────────────┘
                                 │
                          signer provided?
                          ┌──────┴──────┐
                          │ yes         │ no
                          ▼             ▼
                     ┌──────────┐  ┌──────────┐
                     │  SIGN    │  │  STORE   │
                     │  HMAC    │  │  as-is   │
                     │  SHA-256 │  └──────────┘
                     └────┬─────┘
                          │
                          ▼
                     ┌────────────────────────┐
                     │   STORE (ForgeStore)    │
                     │  save(BrickArtifact)    │
                     │  notify(StoreChange)    │
                     └────────────────────────┘
```

---

## Core concepts

### Brick kinds

Koi agents extend themselves by forging **bricks** — typed artifacts stored in a
content-addressed registry.

| Kind | What it is | Trust minimum | Has code? |
|------|-----------|--------------|-----------|
| `tool` | Executable function with schema | `sandbox` | Yes |
| `skill` | Reusable prompt / knowledge | `sandbox` | No |
| `agent` | Sub-agent manifest (YAML) | `sandbox` | No |
| `middleware` | Interposition logic | `promoted` | Yes |
| `channel` | I/O adapter | `promoted` | Yes |

```
  BrickArtifact (discriminated union on `kind`)
  ├── ToolArtifact      { implementation, inputSchema, testCases }
  ├── SkillArtifact     { content (markdown body) }
  ├── AgentArtifact     { manifestYaml }
  ├── MiddlewareArtifact{ implementation }
  └── ChannelArtifact   { implementation }
```

### Content-addressed identity

Every brick's ID **is** its integrity proof:

```
  BrickId = SHA-256(kind + content)

  kind = "tool"
  content = "return input.a + input.b;"
                    │
                    ▼
            ┌──────────────┐
            │   SHA-256    │ ──> sha256:a1b2c3d4e5f6...
            └──────────────┘

  Change one character → completely different hash.
  The ID itself proves the content hasn't been modified.
```

### Trust tiers

```
  sandbox ────────> verified ────────> promoted
  (auto)            (auto or manual)   (human approval required)

  sandbox:   safe to run in isolated sandbox, no network/fs
  verified:  passed extended testing, higher usage threshold
  promoted:  human-approved for interposition (middleware, channel)
```

Auto-promotion (optional):

```
  ForgeConfig.autoPromotion = {
    enabled: true,
    sandboxToVerifiedThreshold: 5,     // after 5 successful uses
    verifiedToPromotedThreshold: 20,   // after 20 successful uses
  }
```

### Brick lifecycle

```
  draft ──> verifying ──> active ──> deprecated
                │                       │
                ▼                       ▼
              failed               quarantined ──> draft (remediation)
```

Only `active` bricks are discoverable by `ForgeRuntime` and `ForgeComponentProvider`.

### Scope visibility

```
  Scope        Who can see it
  ─────────    ────────────────────────────────
  agent        Only the agent that forged it
  zone         All agents in the same zone
  global       All agents in the system

  Visibility rule: agent sees agent + zone + global
                   zone sees zone + global
                   global sees only global
```

---

## Verification pipeline

Four sequential stages. Fail-fast: stops on first failure if `config.verification.failFast = true`.

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                                                                 │
  │  Stage 1: STATIC ANALYSIS                       (sync, ≤1s)    │
  │  ├── Name pattern: alphanumeric, 3-50 chars                     │
  │  ├── Description length: ≤500 chars                             │
  │  ├── Schema structure: valid JSON Schema                        │
  │  ├── Size check: ≤50KB                                          │
  │  ├── Security: no path traversal, no dangerous keys             │
  │  ├── Manifest parsing: valid YAML (for agent kind)              │
  │  └── All brick kinds validated                                  │
  │                                                                 │
  │  Stage 2: SANDBOX EXECUTION                     (async, ≤5s)    │
  │  ├── Runs implementation in isolated sandbox                    │
  │  ├── No network, no filesystem, no process access               │
  │  ├── Validates: no crash, no timeout, no OOM                    │
  │  └── Skipped for: skill, agent (no executable code)             │
  │                                                                 │
  │  Stage 3: SELF-TEST + VERIFIERS                 (async, ≤10s)   │
  │  ├── Runs provided testCases against sandbox                    │
  │  ├── Compares actual vs expected output (deep equality)         │
  │  ├── Runs pluggable ForgeVerifier instances                     │
  │  │   ├── Injection detection                                    │
  │  │   ├── Exfiltration detection                                 │
  │  │   ├── Resource exhaustion scanning                           │
  │  │   ├── Content scanning                                       │
  │  │   └── Structural hiding detection                            │
  │  └── All verifiers must pass                                    │
  │                                                                 │
  │  Stage 4: TRUST ASSIGNMENT                      (sync)          │
  │  ├── All prior stages must have passed                          │
  │  ├── Assigns trust tier (default: "sandbox")                    │
  │  ├── Never auto-assigns "promoted" (requires human)             │
  │  └── Returns final VerificationReport                           │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘

  Overall timeout: 30s (configurable)
```

Result:

```typescript
interface VerificationReport {
  readonly stages: readonly StageReport[];
  readonly finalTrustTier: TrustTier;
  readonly totalDurationMs: number;
  readonly passed: boolean;
}
```

---

## Provenance & attestation

Every forged brick carries provenance metadata recording who created it, how it was
verified, and when. This is modeled after the [SLSA v1.0](https://slsa.dev/) provenance
specification.

### Provenance structure

```
  ForgeProvenance
  ├── source
  │   ├── origin: "forged"
  │   ├── forgedBy: "agent-007"         ← agent that created it
  │   └── sessionId: "sess-abc"
  │
  ├── buildDefinition
  │   ├── buildType: "koi.forge/tool/v1"
  │   ├── externalParameters: { name, kind, description, tags, ... }
  │   ├── internalParameters?: { sandboxTimeout, ... }
  │   └── resolvedDependencies?: [ { uri, digest, name } ]
  │
  ├── builder
  │   ├── id: "koi.forge/pipeline/v1"
  │   └── version?: "2.1.0"
  │
  ├── metadata
  │   ├── invocationId: "uuid-..."
  │   ├── startedAt: 1709000000000
  │   ├── finishedAt: 1709000000026
  │   ├── sessionId: "sess-abc"
  │   ├── agentId: "agent-007"
  │   └── depth: 0
  │
  ├── verification
  │   ├── passed: true
  │   ├── finalTrustTier: "sandbox"
  │   ├── totalDurationMs: 26
  │   └── stageResults: [ {stage, passed, durationMs}, ... ]
  │
  ├── classification: "internal"        ← data sensitivity
  ├── contentMarkers: ["pii"]           ← content flags
  ├── contentHash: "sha256:a1b2c3..."
  │
  └── attestation?                      ← cryptographic signature
      ├── algorithm: "hmac-sha256"
      └── signature: "7f3a8b..."
```

### Signing flow

When a `SigningBackend` is provided, the forge pipeline signs the provenance record
after creation:

```
  1. Serialize provenance (without attestation field) to canonical JSON
     ├── Keys sorted alphabetically at every nesting level
     ├── undefined values omitted
     └── Deterministic: same input always produces same output

  2. HMAC-SHA256(canonical_json, secret_key) → signature bytes

  3. Hex-encode signature → attestation.signature

  4. Attach to provenance:
     attestation: { algorithm: "hmac-sha256", signature: "7f3a8b..." }
```

### Two-layer tamper detection

```
  Layer 1: CONTENT HASH
  ─────────────────────
  BrickId = SHA-256(kind + content)

  Stored id:   sha256:a1b2c3...
  Recomputed:  SHA-256(current content)

  Match?  → proceed to layer 2
  Differ? → IntegrityContentMismatch ✗

  Layer 2: ATTESTATION SIGNATURE
  ──────────────────────────────
  Re-serialize provenance → canonical JSON
  HMAC-SHA256(canonical_json, secret_key) → expected signature

  Stored signature:  "7f3a8b..."
  Computed:          "7f3a8b..."

  Match?  → IntegrityOk ✓
  Differ? → IntegrityAttestationFailed ✗
```

Why two layers:
- **Hash** catches accidental corruption or naive tampering
- **Signature** catches sophisticated attacks where both content and hash are forged
  (attacker cannot forge the HMAC without the secret key)

### IntegrityResult (3-variant discriminated union)

```typescript
type IntegrityResult =
  | { kind: "ok";                ok: true;  brickId: BrickId }
  | { kind: "content_mismatch"; ok: false; expectedId: BrickId; actualId: BrickId }
  | { kind: "attestation_failed"; ok: false; reason: "missing" | "invalid" | "algorithm_mismatch" }
```

---

## SLSA serialization

Provenance can be exported as a standard [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
envelope wrapping an [SLSA Provenance v1](https://slsa.dev/provenance/v1) predicate.

```
  in-toto Statement v1
  ┌───────────────────────────────────────────────┐
  │ _type: "https://in-toto.io/Statement/v1"     │
  │                                               │
  │ subject:                                      │
  │   - name: "sha256:a1b2c3..."  (BrickId)      │
  │     digest: { sha256: "a1b2c3..." }           │
  │                                               │
  │ predicateType:                                │
  │   "https://slsa.dev/provenance/v1"            │
  │                                               │
  │ predicate:                                    │
  │   ┌───────────────────────────────────────┐   │
  │   │ SLSA Provenance v1                    │   │
  │   │                                       │   │
  │   │ buildDefinition:                      │   │
  │   │   buildType: "koi.forge/tool/v1"      │   │
  │   │   externalParameters: { ... }         │   │
  │   │                                       │   │
  │   │ runDetails:                           │   │
  │   │   builder: { id: "koi.forge/..." }    │   │
  │   │   metadata:                           │   │
  │   │     startedOn: "2025-03-01T..."       │   │
  │   │     finishedOn: "2025-03-01T..."      │   │
  │   │     invocationId: "uuid-..."          │   │
  │   │                                       │   │
  │   │ ── Koi Vendor Extensions ──           │   │
  │   │ koi_classification: "internal"        │   │
  │   │ koi_contentMarkers: ["pii"]           │   │
  │   │ koi_verification:                     │   │
  │   │   passed: true                        │   │
  │   │   finalTrustTier: "sandbox"           │   │
  │   │   totalDurationMs: 26                 │   │
  │   └───────────────────────────────────────┘   │
  └───────────────────────────────────────────────┘
```

Two serialization functions:

| Function | Returns | Use case |
|----------|---------|----------|
| `mapProvenanceToSlsa(provenance)` | `SlsaProvenanceV1` (predicate only) | Composition into custom envelopes |
| `mapProvenanceToStatement(provenance, brickId)` | `InTotoStatementV1<...>` (full envelope) | Standard SLSA toolchain integration |

---

## Governance

Forge access is depth-aware: deeper agents get fewer capabilities.

```
  Depth 0 (root agent):
    forge_tool, forge_skill, forge_agent,
    forge_middleware, forge_channel,
    search_forge, promote_forge

  Depth 1 (sub-agent):
    forge_tool, forge_skill,
    search_forge, promote_forge

  Depth 2+ (deeper):
    search_forge only
```

Session-level limits:

```
  maxForgeDepth: 1          ← max nesting for forge calls
  maxForgesPerSession: 5    ← total forges per session
```

Scope promotion requires governance approval:

```
  agent → zone:   requires minTrustForZone ("verified")
  zone → global:  requires minTrustForGlobal ("promoted")
                   + human approval if requireHumanApproval = true
```

---

## Runtime integration

### ForgeComponentProvider (assembly-time)

Implements the L0 `ComponentProvider` interface. Attaches forged bricks as agent
components during assembly. Lazy-loads from `ForgeStore` on first `attach()`.

```
  createKoi({
    manifest,
    adapter,
    providers: [
      createForgeComponentProvider({     ← all active bricks attached here
        store,
        executor,
      })
    ]
  })
```

Features:
- **Lazy loading**: bricks loaded on first `attach()`, cached for reuse
- **Scope filtering**: only bricks visible at the agent's scope are attached
- **Zone filtering**: zone-scoped bricks filtered by `zoneId` tag
- **Trust enforcement**: all kinds checked against minimum trust thresholds
- **Requirements check**: skips bricks with unsatisfied `requires` (bins, env, tools)
- **Delta invalidation**: targeted cache clear on `StoreChangeEvent`

### ForgeRuntime (use-time)

Hot-loads tools mid-session without re-assembly. Verifies integrity on every
`resolveTool()` call.

```
  const runtime = createForgeRuntime({ store, executor, signer });

  // Resolves tool by name — with integrity + attestation verification
  const tool = await runtime.resolveTool("adder");

  // Lists all active tool descriptors (no integrity check)
  const descriptors = await runtime.toolDescriptors();

  // Resolves any brick kind
  const skill = await runtime.resolve("skill", "research-primer");
```

Features:
- **Integrity verification**: content hash + attestation check on every `resolveTool()`
- **Attestation cache**: results cached by BrickId for O(1) repeat lookups
- **Fast path**: cold cache does `store.search({ text, limit: 1 })` before full scan
- **Store watch**: auto-invalidates cache on store changes
- **External listeners**: `runtime.watch()` for downstream notification

```
  Fast path (cold cache):

    resolveTool("adder")
         │
         ▼
    store.search({text:"adder", limit:1})  ──> 1 brick
         │
         ▼
    exact name match? ──> verify integrity ──> return Tool ✓
         │ no
         ▼
    ensureCache() ──> load all ──> lookup ──> verify ──> return
```

---

## Configuration

```typescript
const config = createDefaultForgeConfig({
  // Override any defaults:
  maxForgesPerSession: 10,
  verification: {
    sandboxTimeoutMs: 10_000,
  },
});
```

### Defaults

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Master switch |
| `maxForgeDepth` | `1` | Max nesting depth for forge calls |
| `maxForgesPerSession` | `5` | Total forges allowed per session |
| `defaultScope` | `"agent"` | Initial scope for new bricks |
| `defaultTrustTier` | `"sandbox"` | Initial trust for new bricks |
| `verification.staticTimeoutMs` | `1,000` | Stage 1 timeout |
| `verification.sandboxTimeoutMs` | `5,000` | Stage 2 timeout |
| `verification.selfTestTimeoutMs` | `10,000` | Stage 3 timeout |
| `verification.totalTimeoutMs` | `30,000` | Overall pipeline timeout |
| `verification.maxBrickSizeBytes` | `50,000` | Max brick content size |
| `verification.failFast` | `true` | Stop on first failure |
| `autoPromotion.enabled` | `false` | Auto-promote on usage |
| `scopePromotion.requireHumanApproval` | `true` | Human-in-the-loop |

---

## API reference

### Primordial tools (agent-facing)

These are the tools an agent calls to forge bricks:

| Tool | Input | Output |
|------|-------|--------|
| `forge_tool` | `{ name, description, inputSchema, implementation, testCases? }` | `ForgeResult` |
| `forge_skill` | `{ name, description, body }` | `ForgeResult` |
| `forge_agent` | `{ name, description, manifestYaml }` or `{ name, description, brickIds }` | `ForgeResult` |
| `forge_middleware` | `{ name, description, implementation }` | `ForgeResult` |
| `forge_channel` | `{ name, description, implementation }` | `ForgeResult` |
| `search_forge` | `{ query?, kind?, scope?, lifecycle? }` | `BrickArtifact[]` |
| `promote_forge` | `{ brickId, scope?, trustTier?, lifecycle? }` | `PromoteResult` |

All inputs accept optional `classification`, `contentMarkers`, `tags`, `requires`, and `files`.

### Factory functions

```typescript
// Create forge tools with custom deps
createForgeToolTool(deps: ForgeDeps): Tool
createForgeSkillTool(deps: ForgeDeps): Tool
createForgeAgentTool(deps: ForgeDeps): Tool
createForgeMiddlewareTool(deps: ForgeDeps): Tool
createForgeChannelTool(deps: ForgeDeps): Tool
createSearchForgeTool(deps: ForgeDeps): Tool
createPromoteForgeTool(deps: ForgeDeps): Tool

// Attestation
createForgeProvenance(options: CreateProvenanceOptions): ForgeProvenance
signAttestation(provenance: ForgeProvenance, signer: SigningBackend): Promise<ForgeProvenance>
verifyAttestation(provenance: ForgeProvenance, signer: SigningBackend): Promise<boolean>

// Integrity
verifyBrickIntegrity(brick: BrickArtifact): IntegrityResult
verifyBrickAttestation(brick: BrickArtifact, signer: SigningBackend): Promise<IntegrityResult>
loadAndVerify(id: BrickId, store: ForgeStore, signer?: SigningBackend): Promise<IntegrityResult>

// Runtime
createForgeRuntime(options: CreateForgeRuntimeOptions): ForgeRuntimeInstance
createForgeComponentProvider(config: ForgeComponentProviderConfig): ForgeComponentProviderInstance

// Storage
createInMemoryForgeStore(): ForgeStore
createMemoryStoreChangeNotifier(): StoreChangeNotifier
createAttestationCache(): AttestationCache

// Configuration
createDefaultForgeConfig(overrides?: Partial<ForgeConfig>): ForgeConfig
validateForgeConfig(raw: unknown): Result<ForgeConfig, KoiError>

// SLSA
mapProvenanceToSlsa(provenance: ForgeProvenance): SlsaProvenanceV1
mapProvenanceToStatement(provenance: ForgeProvenance, brickId: BrickId): InTotoStatementV1<SlsaProvenanceV1WithExtensions>

// Governance
checkGovernance(context: ForgeContext, config: ForgeConfig, toolName?: string): Result<void, ForgeError>
checkScopePromotion(/* ... */): GovernanceResult
```

---

## Examples

### Minimal: forge a tool with verification

```typescript
import { createForgeToolTool, createInMemoryForgeStore, createDefaultForgeConfig } from "@koi/forge";

const store = createInMemoryForgeStore();
const deps = {
  store,
  executor: myTieredExecutor,
  verifiers: [],
  config: createDefaultForgeConfig(),
  context: { agentId: "my-agent", depth: 0, sessionId: "sess-1", forgesThisSession: 0 },
};

const forgeTool = createForgeToolTool(deps);
const result = await forgeTool.execute({
  name: "adder",
  description: "Adds two numbers",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  implementation: "return { sum: input.a + input.b };",
});

// result.value.id = "sha256:..." (content-addressed)
// result.value.trustTier = "sandbox"
```

### With signing: cryptographic attestation

```typescript
import { signAttestation, verifyAttestation } from "@koi/forge";

const signer: SigningBackend = {
  algorithm: "hmac-sha256",
  sign: (data) => hmacSha256(secretKey, data),
  verify: (data, sig) => constantTimeEqual(hmacSha256(secretKey, data), sig),
};

// Add signer to deps — pipeline auto-signs provenance
const deps = { ...baseDeps, signer };
const forgeTool = createForgeToolTool(deps);
const result = await forgeTool.execute({ /* ... */ });

// Load and verify
const brick = (await store.load(result.value.id)).value;
const valid = await verifyAttestation(brick.provenance, signer);
// valid === true
```

### Integrity verification with 3-variant result

```typescript
import { verifyBrickIntegrity, verifyBrickAttestation } from "@koi/forge";

const result = verifyBrickIntegrity(brick);
switch (result.kind) {
  case "ok":
    console.log("Content hash verified:", result.brickId);
    break;
  case "content_mismatch":
    console.error("Tampered!", result.expectedId, "≠", result.actualId);
    break;
  case "attestation_failed":
    console.error("Signature invalid:", result.reason);
    break;
}
```

### SLSA export for supply-chain tooling

```typescript
import { mapProvenanceToStatement } from "@koi/forge";

const statement = mapProvenanceToStatement(brick.provenance, brick.id);
// statement._type === "https://in-toto.io/Statement/v1"
// statement.predicateType === "https://slsa.dev/provenance/v1"
// statement.predicate.koi_classification === "internal"
// statement.predicate.koi_verification.passed === true

// Export as JSON for SLSA Verifier or sigstore integration
const json = JSON.stringify(statement, null, 2);
```

### ForgeRuntime: hot-load with tamper detection

```typescript
import { createForgeRuntime } from "@koi/forge";

const runtime = createForgeRuntime({ store, executor, signer });

// Resolves tool — verifies integrity + attestation on every call
const tool = await runtime.resolveTool("adder");
if (tool !== undefined) {
  const result = await tool.execute({ a: 40, b: 2 });
  // result.value.output === { sum: 42 }
}

// Tampered brick → returns undefined (silently rejected)
// Integrity result cached — O(1) for repeat lookups

runtime.dispose?.();
```

### Full L1 integration: createKoi with forge

```typescript
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createForgeComponentProvider } from "@koi/forge";

const forgeProvider = createForgeComponentProvider({
  store,
  executor: tieredExecutor,
});

const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-haiku-4-5-20251001" } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 10 }),
  providers: [forgeProvider],  // all active bricks auto-attached
});

// Agent can now use forged tools via LLM tool calls
for await (const event of runtime.run({ kind: "text", text: "Use adder to add 2 + 3" })) {
  // events stream: model_start, tool_start, tool_end, model_end, done
}
```

---

## Related

- [Koi Architecture](../architecture/Koi.md) — system overview and layer rules
- [Brick Auto-Discovery](../architecture/brick-auto-discovery.md) — how bricks are discovered at scale
- [@koi/doctor](./doctor.md) — static security scanning for agent manifests
