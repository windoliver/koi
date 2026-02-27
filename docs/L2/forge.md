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
                                      │  2. Dependency resolve   │
                                      │  3. Sandbox execution    │
                                      │  4. Self-test            │
                                      │  5. Trust scoring        │
                                      │  6. Content hash (BrickId)│
                                      │  7. Sign attestation     │
                                      │  8. Store in ForgeStore  │
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
L0  @koi/core         ─ BrickArtifact, ForgeStore, ForgeProvenance, SigningBackend,
                        SandboxExecutor, ExecutionContext (types only)
L0u @koi/hash          ─ computeContentHash() (dep hash for workspaces)
L0u @koi/validation    ─ validateWith() (config validation)
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
├── verify.ts                    ← 5-stage verification orchestrator
├── verify-static.ts             ← stage 1: static analysis (+ network evasion detection)
├── verify-resolve.ts            ← stage 1.5: dependency audit + install + entry file
├── verify-sandbox.ts            ← stage 2: sandbox execution
├── verify-self-test.ts          ← stage 3: self-test + pluggable verifiers
├── verify-trust.ts              ← stage 4: trust assignment
│
├── dependency-audit.ts          ← allowlist/blocklist + transitive dep audit
├── verify-install-integrity.ts  ← post-install lockfile + node_modules verification
├── workspace-manager.ts         ← per-dep-hash workspace creation + LRU cleanup
├── workspace-scan.ts            ← post-install node_modules code scanner
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
    ├── forge-lifecycle.test.ts      ← unit E2E: forge → sign → verify → resolve → tamper
    ├── e2e.test.ts                  ← real LLM E2E with createKoi + forge tools
    ├── e2e-agent.test.ts            ← cooperating adapter E2E: forge → reuse → hot-attach
    ├── e2e-full-assembly.test.ts    ← real LLM E2E: full pipeline (lifecycle, hot-attach,
    │                                   priority ordering, cache invalidation)
    ├── e2e-deps.test.ts             ← real LLM E2E: dependency management + subprocess
    └── e2e-provenance.test.ts       ← real LLM E2E: provenance + SLSA + attestation
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
                     │   5-STAGE VERIFICATION  │──── fail ──> ForgeError
                     │  static → resolve →     │
                     │  sandbox → self-test →  │
                     │  trust                  │
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

### Dependency management

Bricks can declare npm package dependencies via `requires.packages`. The forge pipeline
audits, installs, and isolates these dependencies automatically.

```
  Agent says:                              What @koi/forge does:
  "Create a tool that
   validates emails             ┌─────────────────────────────────────────┐
   using zod"                   │  requires: { packages: { zod: "3.23.8" } }
                                │                                         │
                                │  1. Audit:                              │
  ┌──────────────────┐          │     allowlist/blocklist check           │
  │  BrickRequires   │          │     max 20 direct deps                  │
  │  ├── packages    │──────────│     exact semver only (no ranges)       │
  │  ├── network     │          │     package name format validation      │
  │  ├── bins        │          │                                         │
  │  ├── env         │          │  2. Install:                            │
  │  └── tools       │          │     bun install --ignore-scripts        │
  └──────────────────┘          │     content-addressed workspace         │
                                │     timeout: 15s (capped to budget)     │
                                │                                         │
                                │  3. Post-install scan:                  │
                                │     transitive dep count (≤ 200)        │
                                │     code scan for child_process, etc.   │
                                │     symlink escape detection (lstat)    │
                                │                                         │
                                │  4. Integrity verification:             │
                                │     lockfile matches declared deps      │
                                │     node_modules matches lockfile       │
                                │                                         │
                                │  5. Write entry file:                   │
                                │     <workspace>/<brick-name>.ts         │
                                └─────────────────────────────────────────┘
```

**Workspace layout** (content-addressed by dep hash):

```
  $XDG_CACHE_HOME/koi/brick-workspaces/    (default: ~/.cache/koi/brick-workspaces/)
    <sha256(sorted deps)>/
      ├── package.json         ← generated from requires.packages
      ├── bun.lock             ← generated by bun install
      ├── node_modules/        ← installed dependencies
      └── my-brick.ts          ← brick entry file (import() target)
```

Bricks with identical dependencies share the same workspace (deduplication).
Workspaces are evicted by LRU: age > 30 days or total size > 1 GB.

**Execution path** depends on trust tier:

```
  sandbox / verified tier:
    subprocess-executor → spawns child process → restricted env
    ├── env: only PATH, HOME, TMPDIR, NODE_ENV, BUN_INSTALL
    ├── NODE_PATH: <workspace>/node_modules
    ├── timeout: SIGKILL
    ├── stdout cap: 10 MB
    ├── no access to host secrets (ANTHROPIC_API_KEY, etc.)
    ├── network isolation: Seatbelt (macOS) / Bubblewrap (Linux)
    │   when requires.network: false
    └── resource limits: ulimit -v (memory), ulimit -u (PIDs, Linux)

  promoted tier:
    promoted-executor → in-process import() → LRU cache (256 cap)
    ├── query-string cache busting for fresh imports
    └── Promise.race timeout with cleanup
```

**Network isolation**: runtime enforcement via OS sandbox (Seatbelt on macOS, Bubblewrap on
Linux). Bricks with `requires.network: false` are wrapped in `sandbox-exec -p <deny-network>`
(macOS) or `bwrap --unshare-net` (Linux). Combined with static analysis that catches 19
evasion patterns — `globalThis.fetch`, variable aliasing, `node:` prefix imports,
third-party HTTP libraries, computed property access, and more.

**Resource limits**: subprocess memory and PID limits are enforced via `ulimit` before
executing the brick. Configurable via `dependencies.maxBrickMemoryMb` (default: 256 MB)
and `dependencies.maxBrickPids` (default: 32, Linux only).

**Post-install integrity**: after `bun install`, the workspace manager verifies that each
declared package appears in `bun.lock` with the correct version and that `node_modules`
contains matching `package.json` files. Any mismatch triggers `INTEGRITY_MISMATCH` and the
workspace is deleted.

---

## Verification pipeline

Five sequential stages. Fail-fast: stops on first failure if `config.verification.failFast = true`.

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                                                                 │
  │  Stage 1: STATIC ANALYSIS                       (sync, ≤1s)    │
  │  ├── Name: starts with letter, alphanumeric/hyphen/underscore, 3-50 │
  │  ├── Description length: ≤500 chars                             │
  │  ├── Schema structure: valid JSON Schema                        │
  │  ├── Size check: ≤50KB                                          │
  │  ├── Syntax check: Bun.Transpiler on tool/middleware/channel    │
  │  ├── Security: no path traversal, no dangerous keys             │
  │  ├── Network evasion: 19 patterns (fetch, axios, etc.)          │
  │  ├── Package validation: name format, exact semver              │
  │  ├── Manifest: non-empty + size check (YAML parsed pre-pipeline)│
  │  └── All brick kinds validated                                  │
  │                                                                 │
  │  Stage 1.5: RESOLVE DEPENDENCIES               (async, ≤15s)   │
  │  ├── Audit: allowlist/blocklist, max deps, semver format        │
  │  ├── Install: bun install --ignore-scripts (timeout capped      │
  │  │   to remaining pipeline budget)                              │
  │  ├── Transitive audit: parse bun.lock, count ≤ 200, blocklist   │
  │  ├── Code scan: child_process, execSync → reject                │
  │  ├── Symlink check: lstat, skip symlinks                        │
  │  ├── Write entry file: <workspace>/<brick>.ts                   │
  │  └── Skipped if: no requires.packages declared                  │
  │                                                                 │
  │  Stage 2: SANDBOX EXECUTION                     (async, ≤5s)    │
  │  ├── Runs implementation in isolated sandbox                    │
  │  ├── Uses subprocess executor if workspace available            │
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

  Overall timeout: 60s (configurable, install timeout capped to remaining budget)
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

## Atomic scope promotion (Issue #404)

When an agent promotes a brick's scope (e.g., `agent → zone`), the store must update
**both** the storage tier (physical location) **and** metadata (trust, lifecycle, tags)
in a single operation. Without atomicity, a crash or failure between the two steps leaves
the brick in a partial state — physically moved but with stale metadata.

### The problem

```
  promote_forge(scope: "zone", trust: "verified")
                      │
                      ▼
          ┌───────────────────────┐
          │  store.promote(id,    │   Step 1: move brick
          │    "zone")            │   agent/ → zone/
          └───────────┬───────────┘
                      │ ✅ success
                      ▼
          ┌───────────────────────┐
          │  store.update(id,     │   Step 2: update metadata
          │    {trust: "verified"})│
          └───────────┬───────────┘
                      │ ❌ FAILS
                      ▼
      ╔═══════════════════════════════╗
      ║   PARTIAL STATE               ║
      ║   Brick in zone/ tier         ║
      ║   but trust still "sandbox"   ║
      ║   tags stale                  ║
      ╚═══════════════════════════════╝
```

### The solution: `promoteAndUpdate()`

`ForgeStore` exposes an optional `promoteAndUpdate()` method that combines scope promotion
with metadata update in a single operation.

```
  promote_forge(scope: "zone", trust: "verified")
                      │
                      ▼
          ┌───────────────────────────────┐
          │  store.promoteAndUpdate(      │
          │    id, "zone",               │
          │    {trust: "verified",       │   Single operation:
          │     tags: ["zone:team-1"]})  │   all or nothing
          └───────────┬─────────────────┘
                      │
             ┌────────┴────────┐
          ✅ success         ❌ failure
             │                 │
             ▼                 ▼
  ┌──────────────────┐  ┌──────────────────┐
  │ ALL changes      │  │ NO changes       │
  │ applied:         │  │ applied:         │
  │ • scope → zone   │  │ • brick stays    │
  │ • trust → verified│ │   where it was   │
  │ • tags updated   │  │ • clean error    │
  └──────────────────┘  └──────────────────┘
```

### How it works (overlay store)

The overlay store implements `promoteAndUpdate()` as a single load-merge-save:

```
  1. Load brick from source tier (e.g., agent/)
  2. Merge ALL updates in memory:
     { ...brick, scope: "zone", trustTier: "verified", tags: [...] }
  3. Save merged brick to target tier (zone/) ← single write
  4. Remove from source tier (non-fatal if fails — content-addressed = harmless dup)
```

No window exists where the brick is in the new tier with old metadata.

For the in-memory store, it's trivially atomic — a single `Map.set()`.

### Fallback chain

The `promote_forge` handler tries methods in priority order for backward compatibility:

```
  ┌──────────────────────────┐
  │ store.promoteAndUpdate?  │── yes ──▶ ATOMIC (preferred)
  └──────────┬───────────────┘          single operation
             │ undefined
             ▼
  ┌──────────────────────────┐
  │ store.promote?           │── yes ──▶ LEGACY (two-step)
  └──────────┬───────────────┘          promote() + update()
             │ undefined
             ▼
  ┌──────────────────────────┐
  │ store.update()           │────────▶ BASIC (metadata only)
  └──────────────────────────┘          no tier move
```

Both `promoteAndUpdate` and `promote` are optional on `ForgeStore` — existing store
implementations compile without them. The handler degrades gracefully.

### L0 interface

```typescript
// packages/core/src/brick-store.ts

interface ForgeStore {
  // ... existing methods ...

  /** Atomic scope promotion with metadata update. Optional. */
  readonly promoteAndUpdate?: (
    id: BrickId,
    targetScope: ForgeScope,
    updates: BrickUpdate,
  ) => Promise<Result<void, KoiError>>;
}
```

### Store change events

When `promoteAndUpdate()` succeeds, a `"promoted"` event is emitted:

```typescript
{ kind: "promoted", brickId: "sha256:...", scope: "zone" }
```

This triggers cache invalidation in `ForgeRuntime` and notifies any
`StoreChangeNotifier` subscribers for cross-agent invalidation.

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
| `verification.totalTimeoutMs` | `60,000` | Overall pipeline timeout |
| `verification.maxBrickSizeBytes` | `50,000` | Max brick content size |
| `verification.failFast` | `true` | Stop on first failure |
| `autoPromotion.enabled` | `false` | Auto-promote on usage |
| `scopePromotion.requireHumanApproval` | `true` | Human-in-the-loop |
| `dependencies.maxDependencies` | `20` | Max direct npm deps per brick |
| `dependencies.installTimeoutMs` | `15,000` | Per-install timeout |
| `dependencies.maxCacheSizeBytes` | `1,073,741,824` | Max total workspace disk (1 GB) |
| `dependencies.maxWorkspaceAgeDays` | `30` | LRU eviction age |
| `dependencies.maxTransitiveDependencies` | `200` | Max transitive deps after install |
| `dependencies.maxBrickMemoryMb` | `256` | Max virtual memory (MB) per brick subprocess |
| `dependencies.maxBrickPids` | `32` | Max child processes per brick (Linux only) |
| `dependencies.allowedPackages` | `undefined` | Allowlist (empty = all allowed) |
| `dependencies.blockedPackages` | `undefined` | Blocklist (takes precedence) |

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
`requires.packages` enables npm dependency management (audit → install → scan → execute).

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

// Dependencies + integrity
auditDependencies(packages, config): Result<void, ForgeError>
verifyInstallIntegrity(workspacePath, declaredPackages): Promise<Result<void, ForgeError>>
auditTransitiveDependencies(lockContent, config): Result<void, ForgeError>
computeDependencyHash(packages): string
resolveWorkspacePath(depHash, cacheDir?): string
createBrickWorkspace(packages, config, cacheDir?): Promise<Result<WorkspaceResult, ForgeError>>
writeBrickEntry(workspacePath, implementation, brickName): Promise<string>
cleanupStaleWorkspaces(config, cacheDir?): Promise<number>
scanWorkspaceCode(workspacePath, config): Promise<Result<ScanResult, ForgeError>>

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

### With npm dependencies

```typescript
const result = await forgeTool.execute({
  name: "validate-email",
  description: "Validates email addresses using zod",
  inputSchema: { type: "object", properties: { email: { type: "string" } } },
  implementation: `
    import { z } from "zod";
    const schema = z.string().email();
    export default function run(input: { email: string }) {
      const result = schema.safeParse(input.email);
      return { valid: result.success, error: result.error?.message };
    }
  `,
  requires: {
    packages: { zod: "3.23.8" },   // exact semver required
    network: false,                  // static analysis enforces this
  },
});

// Pipeline: static → resolve (audit + install + scan) → sandbox → trust
// Workspace created at ~/.cache/koi/brick-workspaces/<dep-hash>/
// Entry file written: <workspace>/validate-email.ts
// Executed via subprocess with restricted env
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

### Atomic promote through L1 runtime

```typescript
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import {
  createDefaultForgeConfig,
  createInMemoryForgeStore,
  createPromoteForgeTool,
} from "@koi/forge";
import { toolToken } from "@koi/core";

// 1. Store with a brick
const store = createInMemoryForgeStore();
await store.save(myBrick); // scope: "agent", trustTier: "sandbox"

// 2. Create promote_forge as entity tool
const promoteTool = createPromoteForgeTool({
  store,
  executor: tieredExecutor,
  verifiers: [],
  config: createDefaultForgeConfig(),
  context: { agentId: "agent-1", depth: 0, sessionId: "s1", forgesThisSession: 0 },
});

// 3. Register via ComponentProvider
const toolProvider = {
  name: "promote-provider",
  attach: async () => new Map([[ toolToken("promote_forge"), promoteTool ]]),
};

// 4. Wire through createKoi — promote_forge is now callable by the LLM
const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-haiku-4-5-20251001" } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 5 }),
  providers: [toolProvider],
});

// When the LLM calls promote_forge with:
//   { brickId: "sha256:...", targetScope: "zone", targetTrustTier: "verified" }
// The handler uses store.promoteAndUpdate() → atomic scope + metadata change.
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

### Hot-attach via ForgeRuntime (mid-session)

```typescript
import { createKoi } from "@koi/engine";
import { createForgeRuntime, createForgeComponentProvider } from "@koi/forge";

// ForgeRuntime enables hot-attach: tools forged mid-session become
// callable in the next turn without restarting the agent.
const forgeRuntime = createForgeRuntime({ store, executor });

const runtime = await createKoi({
  manifest,
  adapter: loopAdapter,
  providers: [primordialProvider],  // includes forge_tool
  forge: forgeRuntime,              // ← enables hot-attach
});

// Turn 0: LLM calls forge_tool → "adder" saved to store
//         store.watch fires → forgeRuntime cache invalidated
// Turn 1: LLM sees "adder" in tool list → calls it → result returned
//
// No restart. No invalidate(). Same session. Same createKoi.
```

### Cache invalidation + re-assembly

```typescript
// Assembly 1: only tool-alpha visible
const forgeProvider = createForgeComponentProvider({ store, executor });
const runtime1 = await createKoi({ manifest, adapter, providers: [forgeProvider] });

// ... forge tool-beta into the same store ...

// Invalidate the SAME provider instance
forgeProvider.invalidate();

// Assembly 2: both tool-alpha AND tool-beta visible
const runtime2 = await createKoi({ manifest, adapter, providers: [forgeProvider] });
```

---

## Full L1 assembly pipeline

The full assembly pipeline connects all forge subsystems through the L1 runtime
(`createKoi`). This is what the `e2e-full-assembly.test.ts` validates end-to-end
with a real LLM.

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                    createKoi() Assembly                            │
  │                                                                     │
  │  Inputs:                                                           │
  │    manifest ──────┐                                                │
  │    adapter ───────┤                                                │
  │    providers[] ───┤── createKoi() ──▶ KoiRuntime                   │
  │    middleware[] ───┤                                                │
  │    forge? ────────┘                                                │
  │                                                                     │
  │  ┌──────────────────────────────────────────────────────────────┐  │
  │  │  Middleware Lifecycle (onion model)                          │  │
  │  │                                                              │  │
  │  │   ① onSessionStart                                          │  │
  │  │   │                                                          │  │
  │  │   │  ┌─── per turn ────────────────────────────────┐        │  │
  │  │   │  │                                              │        │  │
  │  │   │  │  ② onBeforeTurn                              │        │  │
  │  │   │  │  │                                            │        │  │
  │  │   │  │  │  ③ wrapModelCall ──▶ LLM ──▶ response     │        │  │
  │  │   │  │  │  │                                         │        │  │
  │  │   │  │  │  │  ④ wrapToolCall ──▶ tool ──▶ result    │        │  │
  │  │   │  │  │  │     (if LLM requested a tool call)     │        │  │
  │  │   │  │  │                                            │        │  │
  │  │   │  │  ⑤ onAfterTurn                               │        │  │
  │  │   │  │                                              │        │  │
  │  │   │  └──────────────────────────────────────────────┘        │  │
  │  │   │                                                          │  │
  │  │   ⑥ onSessionEnd                                            │  │
  │  └──────────────────────────────────────────────────────────────┘  │
  │                                                                     │
  │  ┌──────────────────────────────────────────────────────────────┐  │
  │  │  Middleware Priority Ordering                                │  │
  │  │                                                              │  │
  │  │   Lower priority = outer onion layer (executes first)       │  │
  │  │                                                              │  │
  │  │   ┌─────────────────────────────────────────┐               │  │
  │  │   │  priority: 100 (outer)                   │               │  │
  │  │   │  ┌─────────────────────────────────────┐ │               │  │
  │  │   │  │  priority: 300 (middle)             │ │               │  │
  │  │   │  │  ┌─────────────────────────────────┐│ │               │  │
  │  │   │  │  │  priority: 500 (inner)          ││ │               │  │
  │  │   │  │  │  ┌─────────────────────────────┐││ │               │  │
  │  │   │  │  │  │   tool / model executes     │││ │               │  │
  │  │   │  │  │  └─────────────────────────────┘││ │               │  │
  │  │   │  │  └─────────────────────────────────┘│ │               │  │
  │  │   │  └─────────────────────────────────────┘ │               │  │
  │  │   └─────────────────────────────────────────┘               │  │
  │  │                                                              │  │
  │  │   Execution order: outer → middle → inner → tool → inner    │  │
  │  │                    → middle → outer                          │  │
  │  └──────────────────────────────────────────────────────────────┘  │
  │                                                                     │
  │  ┌──────────────────────────────────────────────────────────────┐  │
  │  │  Hot-Attach (forge: ForgeRuntime)                           │  │
  │  │                                                              │  │
  │  │   Turn 0: tools = [forge_tool]                              │  │
  │  │           LLM calls forge_tool({name: "adder", ...})        │  │
  │  │                        │                                     │  │
  │  │                        ▼                                     │  │
  │  │           store.save() ──▶ store.watch fires                │  │
  │  │                             │                                │  │
  │  │                             ▼                                │  │
  │  │           ForgeRuntime cache invalidated automatically      │  │
  │  │                                                              │  │
  │  │   Turn 1: tools = [forge_tool, adder]  ◀── hot-attached     │  │
  │  │           LLM calls adder({a: 17, b: 25})                   │  │
  │  │                        │                                     │  │
  │  │                        ▼                                     │  │
  │  │           {sum: 42}                                          │  │
  │  │                                                              │  │
  │  │   No restart. No manual invalidate(). Same session.         │  │
  │  └──────────────────────────────────────────────────────────────┘  │
  │                                                                     │
  │  ┌──────────────────────────────────────────────────────────────┐  │
  │  │  Cache Invalidation + Re-Assembly                           │  │
  │  │                                                              │  │
  │  │   Assembly 1: provider.attach()                             │  │
  │  │                store has [tool-alpha]                        │  │
  │  │                agent sees: tool-alpha ✓, tool-beta ✗        │  │
  │  │                                                              │  │
  │  │   forge tool-beta → store.save()                            │  │
  │  │   provider.invalidate() → cached = undefined                │  │
  │  │                                                              │  │
  │  │   Assembly 2: provider.attach() re-queries store            │  │
  │  │                store has [tool-alpha, tool-beta]             │  │
  │  │                agent sees: tool-alpha ✓, tool-beta ✓        │  │
  │  │                                                              │  │
  │  │   Same provider instance. Cache cleared. Fresh query.       │  │
  │  └──────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────┘
```

### E2E test coverage matrix

| Test file | Test | What it proves |
|-----------|------|----------------|
| `e2e.test.ts` | Forged tool callable by LLM | forge → provider → createKoi → LLM calls tool |
| `e2e.test.ts` | Middleware spy | forged tool call flows through middleware chain |
| `e2e.test.ts` | Requires enforcement | bricks with missing env vars skipped |
| `e2e.test.ts` | configSchema | stored and retrievable on middleware artifact |
| `e2e.test.ts` | Listener guards | subscriber/listener limits enforced |
| `e2e.test.ts` | Provenance + integrity | content hash + attestation round-trip |
| `e2e.test.ts` | Tamper detection | modified brick rejected on load |
| `e2e-agent.test.ts` | Cooperating adapter | forge → call → verify with mock adapter |
| `e2e-agent.test.ts` | Cache invalidate | second run sees newly forged tools |
| `e2e-agent.test.ts` | Self-extending | forge in run 1, reuse in run 2 |
| `e2e-agent.test.ts` | Hot-attach (mock) | mid-session tool visibility via store.watch |
| **`e2e-full-assembly.test.ts`** | **Lifecycle ordering** | **all 6 hooks fire in correct order with real LLM** |
| **`e2e-full-assembly.test.ts`** | **Hot-attach (real LLM)** | **forge_tool → LLM forges → adder callable next turn** |
| **`e2e-full-assembly.test.ts`** | **Priority ordering** | **3 middleware fire in ascending priority (100→300→500)** |
| **`e2e-full-assembly.test.ts`** | **Cache invalidation** | **same provider, invalidate(), re-assembly sees new tools** |

---

## Related

- [Koi Architecture](../architecture/Koi.md) — system overview and layer rules
- [Brick Auto-Discovery](../architecture/brick-auto-discovery.md) — how bricks are discovered at scale
- [@koi/doctor](./doctor.md) — static security scanning for agent manifests
- [@koi/sandbox-executor](./sandbox-executor.md) — trust-tiered executor dispatch (subprocess + promoted + fallback)
- [#72](https://github.com/windoliver/koi/issues/72) — OS-level sandbox isolation (Seatbelt/bubblewrap/gVisor)
- [#394](https://github.com/windoliver/koi/issues/394) — cross-device workspace sync via Nexus
