# @koi/cli — manifest-driven middleware (zone B)

Extends the existing manifest loader in `packages/meta/cli/src/manifest.ts` with
per-middleware control: ordered list, per-entry options, enable/disable, and a
narrow, auditable escape hatch for security layers.

---

## Why it exists

v1 allowed a manifest to declare the full middleware chain by name (`archive/v1/packages/kernel/manifest/src/schema.ts:249-262`). v2 replaced that with preset
**stacks** — bundles of code-owned contributions (middleware + providers +
hookExtras + exports + lifecycle + phase). Stacks are great for packages that
need runtime wiring beyond interposition, but they collapsed the user-facing
surface from "chain of middleware" to "set of stacks," losing granular control.

This feature restores v1's per-middleware control for the subset of L2
packages that are pure interposition (no providers, no exports, no
hookExtras) while keeping v2's secure-by-construction baseline and phase
model intact.

---

## The three-zone chain

```
[ zone A:       preset extras     — code-owned stack middleware         ] trusted
[ zone C-top:   hook              — required                            ] code-owned
                permissions       — required (terminal-capable)
                exfiltrationGuard — required (terminal-capable)
[ zone B:       manifest list     — user order, options, enable/disable ] repo-authored
[ zone C-bottom: modelRouter?
                goal?
                systemPrompt?
                sessionTranscript? ]                                      code-owned
```

Zone A is the existing `presetExtras` contribution from stacks. It runs
outermost because it is code-owned and trusted to see raw traffic for
tracing purposes (observability, checkpoint, rules-loader). Users cannot
add to zone A via manifest.

Zone C-top is the security guard: `hook`, `permissions`, and
`exfiltration-guard`. It wraps zone B from the **outside**. This is the
critical security invariant: zone B middleware only ever sees traffic that
has already been gated by permissions and redacted by exfiltration-guard.
A repo-authored manifest cannot add a middleware that logs raw prompts or
tool inputs before the guard runs, because by the time any zone B entry's
`wrapModelCall` is invoked, the guard has already sanitized the payload.

Zone B is new. Users declare it in the manifest as an ordered list. Order
is authoritative within zone B only — zone B as a whole always sits inside
zone C-top (the guard) and outside zone C-bottom (optional innermost
layers).

Zone C-bottom (modelRouter/goal/systemPrompt/sessionTranscript) sits
innermost because those layers need to be the last thing touching the
model payload: modelRouter routes the final call, systemPrompt injects
the final instructions, sessionTranscript records the final state.

The mandatory subset (`hook`, `permissions`, `exfiltrationGuard`) is
asserted via `enforceRequiredMiddleware` after composition; missing
layers refuse to boot unless a host-controlled `trustedHost` opt-out is
set (see below).

### Spawn inheritance

Spawned child agents inherit the same manifest-declared middleware as
their parent, in the same relative order:

```
permissions → exfiltration-guard → hook → zoneB[...] → systemPrompt?
```

This prevents a split-brain runtime where delegated work silently
escapes manifest policy. The inheritance list is built in
`buildInheritedMiddlewareForChildren` (`compose-middleware.ts`), which
is unit-tested independently of the runtime factory. Per-runtime
innermost slots (`modelRouter`, `goal`, `sessionTranscript`) are NOT
inherited — they carry per-runtime mutable state that does not make
sense to share across the delegation boundary.

---

## Manifest schema additions

```yaml
model:
  name: claude-opus-4-6
instructions: ./SYSTEM.md
stacks: [observability, execution, skills]   # existing — zone A
middleware:                                   # NEW — zone B
  - "@koi/middleware-audit":                  # shorthand form
      filePath: ./session.audit.ndjson
  - name: "@koi/middleware-audit"             # explicit form
    options:
      filePath: ./session-secondary.audit.ndjson
    enabled: false                            # declared but turned off
# trustedHost is NOT accepted in koi.yaml — it is host-controlled only.
# See the "Security opt-outs" section below.
#
# @koi/middleware-audit opens an NDJSON file at resolution time, so
# it is ONLY registered when the host opts in via
# `allowManifestFileSinks: true` on createKoiRuntime config. Without
# the host opt-in, naming this middleware throws
# `UnknownManifestMiddlewareError` at runtime assembly. Repo-authored
# koi.yaml cannot flip the opt-in — it is a programmatic host
# decision.
```

### Entry forms

Both forms normalize to `{name, options, enabled}`:

```yaml
# Explicit form
- name: "@koi/middleware-audit"
  options: { filePath: "./session.audit.ndjson" }
  enabled: true

# Shorthand form
- "@koi/middleware-audit": { filePath: "./session.audit.ndjson" }
```

See the "Built-in registrations" section below for the supported
options on each built-in middleware.

### Core-name blocklist

Naming a core middleware in `middleware[]` is rejected at load:

```
manifest.middleware[2]: "@koi/permissions" is a core middleware — configure it via host flags, not the manifest.
blocked names: hook, permissions, exfiltrationGuard, modelRouter, goal, systemPrompt, sessionTranscript
```

This keeps zone C fixed and prevents users from accidentally reordering or
replacing security layers.

### trustedHost — host-controlled only (NOT in manifest YAML)

Security baseline opt-outs (`disablePermissions`,
`disableExfiltrationGuard`) are deliberately **not** accepted from
`koi.yaml`. The manifest loader rejects any top-level `trustedHost:`
field with an error directing users to host configuration.

**Rationale.** `koi.yaml` is repository content. Letting a committed
manifest disable `permissions` or `exfiltration-guard` would let
anyone with repo write access silently downgrade the security posture
of every developer who opens the project. That is not an escape
hatch; it is a trust-boundary regression.

**How hosts opt out.** Hosts that genuinely need to relax the
baseline (e.g. a sandboxed CI runner with compensating controls)
thread a `TrustedHostConfig` directly into `createKoiRuntime` from:

- a CLI flag (`--trust-host=disable-permissions`)
- an environment variable (`KOI_TRUST_HOST=disable-exfiltration-guard`)
- an out-of-band policy store that cannot be set by repository content

Every enabled opt-out logs a bright startup warning. Today no `koi
tui` / `koi start` CLI flag exposes this — it exists only as a
programmatic contract for embedders, which is the deliberate
friction for security-critical relaxations.

---

## Middleware registry

New in `packages/meta/cli/src/middleware-registry.ts`. Decouples manifest
names from code imports.

```typescript
interface ManifestMiddlewareEntry {
  readonly name: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly enabled?: boolean;
}

interface ManifestMiddlewareContext {
  readonly sessionId: SessionId;
  readonly hostId: string;
  readonly workingDirectory: string;
  readonly stackExports: Readonly<Record<string, unknown>>;
}

type ManifestMiddlewareFactory = (
  entry: ManifestMiddlewareEntry,
  ctx: ManifestMiddlewareContext,
) => Promise<KoiMiddleware> | KoiMiddleware;

class MiddlewareRegistry {
  register(name: string, factory: ManifestMiddlewareFactory): void;
  get(name: string): ManifestMiddlewareFactory | undefined;
  names(): readonly string[];
}

function createDefaultManifestRegistry(): MiddlewareRegistry;
```

### Decision rule: stack vs manifest-registerable

A package is **stack-only** if any of the following is true:

- It contributes a provider or export
- It contributes hookExtras that must be merged before the hook middleware is built
- It has a session-reset or shutdown lifecycle
- It needs late-phase activation (reads `inheritedMiddleware`)

Otherwise it is **manifest-registerable**: pure `KoiMiddleware` that
interposes model/tool calls without runtime wiring.

### Supported built-in manifest entries (this release)

Only `@koi/middleware-audit` is registered in the built-in registry,
and only when the host sets `allowManifestFileSinks: true`. Every
other L2 middleware in the tree is either already wired via a
preset stack (where it contributes providers/exports/lifecycle
alongside its interposition) or does not expose a manifest factory.

| Package | Classification |
|---|---|
| `@koi/middleware-audit` | ✅ supported (when host opt-in `allowManifestFileSinks: true`) |
| `@koi/event-trace` | stack-only — contributes `hookExtras` + `trajectoryStore` export |
| `@koi/checkpoint` | stack-only — contributes `checkpointHandle` export + reset lifecycle |
| `@koi/tools-bash` | stack-only — contributes `bashHandle` export |
| `@koi/mcp` | stack-only — contributes providers + lifecycle |
| `@koi/memory`, `@koi/skills-runtime` | stack-only — contribute providers |
| `@koi/spawn` (child agents) | stack-only — late-phase, reads `inheritedMiddleware` |
| `@koi/middleware-extraction` | stack-only — already wired in the memory preset stack; registering it here would double-wire |
| `@koi/middleware-semantic-retry` | stack-only — already wired in the observability preset stack; registering it here would double-wire |
| `@koi/context-manager` | not registerable — exports policy utilities only, no middleware factory |

A manifest entry whose name is not in the supported row above
throws `UnknownManifestMiddlewareError` at runtime assembly. Host
hosts or plugins may register additional factories via a custom
`MiddlewareRegistry`, but the built-in set is intentionally small
and locked to the one audited entry.

---

## Required-set enforcement

New in `packages/meta/cli/src/required-middleware.ts`. Runs **after**
`composeRuntimeMiddleware` and asserts the invariant that terminal-capable
runtimes ship with the full security baseline.

```typescript
interface RequiredMiddlewareOptions {
  readonly terminalCapable: boolean;
  readonly trustedHost: ManifestConfig["trustedHost"];
}

function enforceRequired(
  chain: readonly KoiMiddleware[],
  options: RequiredMiddlewareOptions,
): void;   // throws RequiredMiddlewareError on missing layer
```

Required layers by runtime capability:

| Layer | Always required | Terminal-capable only | Opt-out flag |
|---|---|---|---|
| `hook` | ✓ | | (none — cannot be opted out) |
| `permissions` | | ✓ | `trustedHost.disablePermissions` |
| `exfiltration-guard` | | ✓ | `trustedHost.disableExfiltrationGuard` |

Missing a required layer without the corresponding opt-out throws
`RequiredMiddlewareError` and refuses to boot. This matches the existing
invariant tested in `packages/meta/runtime/src/__tests__/security-defaults.test.ts:158-177`.

---

## Resolution flow

```
1. Load manifest YAML → ManifestConfig
2. Reject zone B entries naming a core middleware
3. Activate early-phase stacks → collect contributions
4. Resolve zone B: for each enabled entry, look up registry and invoke factory
5. Build core middleware with merged hookExtras from step 3
6. Snapshot inheritedMiddleware = [permissions, exfiltrationGuard, hook, systemPrompt]
7. Activate late-phase stacks with host.inheritedMiddleware populated
8. composeRuntimeMiddleware({ presetExtras: zoneA, manifestMiddleware: zoneB, ...zoneC })
9. enforceRequired(composed, { terminalCapable, trustedHost })
10. Runtime starts
```

Step 9 is the single authoritative invariant check — it runs even when no
manifest is provided, so programmatic callers get the same safety.

---

## Migration

Existing manifests continue to work unchanged. Zone B is empty by default.

Programmatic callers of `createKoiRuntime({middleware: [...]})` still work
— user-supplied middleware is appended to the resolved zone B, with the
same core-name blocklist applied.

No v1 → v2 name translation is needed because v2 uses canonical `@koi/*`
package names throughout.

---

## Tests

See `packages/meta/cli/src/__tests__/manifest-middleware.test.ts`:

1. YAML shorthand normalizes to `{name, options}`
2. Unknown name throws at load with registered-name list
3. Core name in manifest.middleware throws with clear error
4. Zone B entries appear in declared order in resolved chain
5. `enabled: false` excludes an entry
6. Options passed verbatim to factory
7. Zone composition: A outer, B middle, C inner — exact order asserted
8. Observability stack still contributes onExecuted tap even with manifest middleware present
9. Spawn stack's late phase still sees inheritedMiddleware containing permissions + exfiltrationGuard + hook + systemPrompt
10. `trustedHost.disableExfiltrationGuard: true` → chain lacks exfiltration-guard, warning logged
11. Terminal-capable runtime missing exfiltration-guard without opt-out → throws at boot
12. Existing `security-defaults.test.ts` passes unchanged
