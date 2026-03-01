# @koi/scope — Linux Namespace-Style Scoped Component Views

Gives Koi agents a confined view of infrastructure: filesystem restricted to a root path, browser locked to an allowlist of domains, credentials filtered by key pattern, and memory isolated by namespace. Each scope compiles once at assembly time and validates every call with minimal overhead. You can only narrow access, never widen it.

---

## Why It Exists

An unrestricted agent has the same access as the process that runs it. If the process can read `/etc/passwd`, so can the agent. If the process can navigate to `http://169.254.169.254` (cloud metadata), so can the agent. This is the capability equivalent of running as root.

`@koi/scope` implements capability attenuation — the same principle behind Linux namespaces, seccomp-bpf, and Android permission scoping. The agent declares what it needs in its manifest, and the runtime wraps each backend so the agent physically cannot exceed its declared boundary.

Without this package, you'd need to:
1. Write path-traversal guards for every filesystem operation
2. Implement URL allowlist/blocklist checking for every navigation
3. Filter credential keys manually before handing them to agents
4. Tag memory entries with namespaces and enforce isolation at read time
5. Do all of the above again for each agent in a multi-agent system

---

## What This Enables

### YAML-Driven Agent Confinement

```
  koi.yaml                               Runtime
  ─────────                               ───────
  name: research-agent
  model: anthropic:claude-sonnet-4-5       ┌──────────────────────────────────┐
                                           │  @koi/starter auto-wiring        │
  scope:                                   │                                  │
    filesystem:            ──────────────► │  FileSystemBackend               │
      root: /workspace/src                 │    → scoped(/workspace/src, ro)  │
      mode: ro                             │    → enforced(policy)            │
    browser:               ──────────────► │  BrowserDriver                   │
      allowedDomains:                      │    → scoped(docs.example.com)    │
        - docs.example.com                 │    → enforced(policy)            │
      blockPrivateAddresses: true          │                                  │
    credentials:           ──────────────► │  CredentialComponent             │
      keyPattern: "api_key_*"              │    → scoped(api_key_*)           │
    memory:                ──────────────► │  MemoryComponent                 │
      namespace: research                  │    → scoped(research)            │
                                           └──────────────────────────────────┘
```

### Multi-Agent Isolation

```
  Operator deploys 3 agents sharing one machine
  ─────────────────────────────────────────────

  Agent A (researcher)              Agent B (writer)              Agent C (reviewer)
  scope:                            scope:                        scope:
    filesystem:                       filesystem:                   filesystem:
      root: /workspace/agent-a          root: /workspace/agent-b      root: /workspace
      mode: ro                          mode: rw                      mode: ro
    browser:                          browser:
      allowedDomains:                   allowedDomains:
        - docs.example.com               - cms.internal.com
    credentials:                      credentials:
      keyPattern: "SEARCH_*"            keyPattern: "CMS_*"
    memory:                           memory:                       memory:
      namespace: researcher             namespace: writer             namespace: reviewer

  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │                          /workspace (shared filesystem)                              │
  │                                                                                     │
  │   /workspace/agent-a/         /workspace/agent-b/         /workspace/shared/         │
  │   ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐         │
  │   │ research.md     │        │ draft.md        │        │ guidelines.md   │         │
  │   │ notes.md        │        │ images/         │        │                 │         │
  │   └─────────────────┘        └─────────────────┘        └─────────────────┘         │
  │         ▲                          ▲                          ▲                      │
  │    Agent A: read ✓            Agent B: read/write ✓     Agent C: read ✓             │
  │    Agent A: write ✗           Agent B: agent-a/ ✗       Agent C: write ✗            │
  │    Agent A: agent-b/ ✗        Agent B: shared/ ✗        Agent C: all dirs ✓ (ro)    │
  └─────────────────────────────────────────────────────────────────────────────────────┘
```

### Two-Layer Defense Model

```
  Tool call: fs.read("/workspace/agent-a/../agent-b/secrets.txt")
                │
                ▼
  ┌─────────────────────────────────────────────┐
  │  Layer 1: Scoped Wrapper (hard boundary)     │
  │                                              │
  │  resolve("/workspace/agent-a",               │
  │    "../agent-b/secrets.txt")                 │
  │  = "/workspace/agent-b/secrets.txt"          │
  │                                              │
  │  startsWith("/workspace/agent-a/")? NO       │
  │  ──► DENIED (path escapes root)              │
  │                                              │
  │  Compiled at assembly. Immutable.            │
  │  Cannot be changed by agent or enforcer.     │
  └─────────────────────────────────────────────┘

  Tool call: fs.read("/workspace/agent-a/research.md")
                │
                ▼
  ┌─────────────────────────────────────────────┐
  │  Layer 2: Enforced Wrapper (dynamic policy)  │
  │                                              │
  │  enforcer.checkAccess({                      │
  │    subsystem: "filesystem",                  │
  │    operation: "read",                        │
  │    resource: "/workspace/agent-a/research.md"│
  │  })                                          │
  │                                              │
  │  Enforcer says: true ──► pass through        │
  │  Enforcer says: false ──► DENIED by policy   │
  │                                              │
  │  Dynamic. Can change per-call.               │
  │  But can never exceed scoped boundary.       │
  └──────────────────────┬──────────────────────┘
                         │ allowed
                         ▼
  ┌─────────────────────────────────────────────┐
  │  Raw Backend                                 │
  │  Actually reads the file from disk.          │
  └─────────────────────────────────────────────┘
```

### Pluggable Enforcement Backends

```
  ScopeEnforcer interface (L0)
  ┌────────────────────────────────────────────────────────────┐
  │  checkAccess(request: ScopeAccessRequest)                   │
  │    → boolean | Promise<boolean>                             │
  │                                                             │
  │  dispose?()                                                 │
  │    → void | Promise<void>                                   │
  └──────────────────────┬─────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
  ┌───────────┐   ┌───────────┐   ┌───────────────┐
  │  Local     │   │  SQLite   │   │  Nexus ReBAC  │
  │  Rules     │   │  Policy   │   │  (HTTP)       │
  │            │   │           │   │               │
  │  In-memory │   │  Single   │   │  Centralized  │
  │  patterns  │   │  file DB  │   │  policy       │
  │  Sync ✓    │   │  Async ✓  │   │  Async ✓      │
  │  Zero deps │   │  Durable  │   │  Multi-agent  │
  └───────────┘   └───────────┘   └───────────────┘
    Development      Production      Enterprise
```

### Manifest = Ceiling, Enforcer = Floor

```
  ┌─────────────────────────────────────────────────────────────┐
  │                    MANIFEST SCOPE ROOT                       │
  │                    /workspace (ceiling)                      │
  │                                                             │
  │   Compiled at assembly time. Immutable. Cannot be changed   │
  │   by agent, enforcer, or operator after assembly.           │
  │                                                             │
  │   ┌─────────────────────────────────────────────────────┐   │
  │   │             ENFORCER POLICY (floor)                  │   │
  │   │             /workspace/agent-a (initial)             │   │
  │   │                                                     │   │
  │   │   Dynamic. Operator can widen enforcer policy:      │   │
  │   │   /workspace/agent-a → /workspace/shared            │   │
  │   │   But NEVER beyond /workspace (manifest ceiling).   │   │
  │   │                                                     │   │
  │   │   ┌─────────────────────────────────────────────┐   │   │
  │   │   │          AGENT ACCESS (actual)               │   │   │
  │   │   │                                             │   │   │
  │   │   │   intersection(scoped, enforced)             │   │   │
  │   │   │   = narrowest of both layers                │   │   │
  │   │   └─────────────────────────────────────────────┘   │   │
  │   └─────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────┘

  Key insight:
    manifest root: /workspace           ← hard wall (scoped wrapper enforces)
    enforcer start: /workspace/agent-a  ← soft wall (enforcer decides)
    enforcer later: /workspace/shared   ← operator expanded (still within ceiling)
    enforcer tries: /etc/passwd         ← BLOCKED by scoped wrapper (above ceiling)
```

---

## Architecture

`@koi/scope` is an **L0u utility package** — it depends only on `@koi/core` (L0) for type contracts. The `ScopeEnforcer` interface lives in L0 itself.

```
┌───────────────────────────────────────────────────────────────────────┐
│  @koi/scope (L0u)                                                     │
│                                                                       │
│  Scoped wrappers (compile-once, validate-per-call)                    │
│  ┌─────────────────────┐  ┌─────────────────────┐                    │
│  │ scoped-filesystem.ts│  │ scoped-browser.ts   │                    │
│  │                     │  │                     │                    │
│  │ createScopedFile-   │  │ createScopedBrowser │                    │
│  │ System()            │  │ compileBrowserScope │                    │
│  │ compileFileSystem-  │  │ validateUrl()       │                    │
│  │ Scope()             │  │                     │                    │
│  └─────────────────────┘  └─────────────────────┘                    │
│                                                                       │
│  ┌─────────────────────┐  ┌─────────────────────┐                    │
│  │ scoped-credentials  │  │ scoped-memory.ts    │                    │
│  │ .ts                 │  │                     │                    │
│  │ createScoped-       │  │ createScopedMemory  │                    │
│  │ Credentials()       │  │ createScopedMemory- │                    │
│  │ compileCredentials- │  │ Provider()          │                    │
│  │ Scope()             │  │                     │                    │
│  └─────────────────────┘  └─────────────────────┘                    │
│                                                                       │
│  Audited wrappers (credential access audit trail)                    │
│  ┌─────────────────────────────────────────────────────┐             │
│  │ audited-credentials.ts                              │             │
│  │                                                     │             │
│  │ createAuditedCredentials(component, config)         │             │
│  │ AuditedCredentialsConfig { sink, onError? }         │             │
│  └─────────────────────────────────────────────────────┘             │
│                                                                       │
│  Enforced wrappers (pluggable policy on top of scoped)                │
│  ┌─────────────────────────────────────────────────────┐             │
│  │ enforced-backends.ts                                │             │
│  │                                                     │             │
│  │ createEnforcedFileSystem(backend, enforcer)         │             │
│  │ createEnforcedBrowser(driver, enforcer)             │             │
│  │ createEnforcedCredentials(component, enforcer)      │             │
│  │ createEnforcedMemory(component, enforcer)           │             │
│  └─────────────────────────────────────────────────────┘             │
│                                                                       │
│  URL security (canonical home, re-exported by @koi/tool-browser)      │
│  ┌─────────────────────────────────────────────────────┐             │
│  │ url-security.ts                                     │             │
│  │                                                     │             │
│  │ compileNavigationSecurity()                         │             │
│  │ parseSecureUrl() / parseSecureOptionalUrl()         │             │
│  │ runSecurityChecks()                                 │             │
│  └─────────────────────────────────────────────────────┘             │
│                                                                       │
│  types.ts — FileSystemScope, BrowserScope, CredentialsScope,         │
│             MemoryScope, compiled variants                            │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│  Dependencies                                                         │
│  @koi/core (L0)              FileSystemBackend, BrowserDriver,        │
│                               CredentialComp., MemoryComponent,       │
│                               ScopeEnforcer, AuditSink, AuditEntry    │
│  @koi/execution-context (L0u) getExecutionContext()                   │
│  node:path (std)              resolve(), sep (filesystem scope only)  │
└───────────────────────────────────────────────────────────────────────┘
```

### Composition Chain

The full composition for a filesystem operation:

```
  Agent calls fs_read("/workspace/agent-a/file.md")
       │
       ▼
  ┌──────────────────────────────┐
  │  Enforced Wrapper             │  enforcer.checkAccess() → allow/deny
  │  createEnforcedFileSystem()   │  (pluggable policy: local/SQLite/ReBAC)
  └──────────────┬───────────────┘
                 │ allowed
                 ▼
  ┌──────────────────────────────┐
  │  Scoped Wrapper               │  resolve + startsWith boundary check
  │  createScopedFileSystem()     │  + mode guard (ro blocks write/edit/delete)
  └──────────────┬───────────────┘
                 │ within boundary
                 ▼
  ┌──────────────────────────────┐
  │  Raw FileSystemBackend        │  Actually reads the file
  └──────────────────────────────┘
```

When wired via `@koi/starter` auto-wiring:

```
  koi.yaml                         @koi/starter                     Runtime
  ────────                         ────────────                     ───────

  scope:                           resolveManifestScope()
    filesystem:       ──────────►    mapManifestFsScope()
      root: /src                     ──► FileSystemScope { root, mode }
      mode: ro                       ──► createFileSystemProvider({
                                           backend: createEnforcedFileSystem(
                                             rawFsBackend, enforcer
                                           ),
                                           scope: { root: "/src", mode: "ro" }
                                         })
                                     ──► ComponentProvider
                                           │
                                           ▼
                                     createKoi({
                                       providers: [fsProvider, ...]
                                     })
```

---

## Subsystem Details

### Filesystem Scope

Path confinement via `resolve()` + `startsWith()` guard:

```
Scope: { root: "/workspace/src", mode: "ro" }

  Compile-once:
    root      = resolve("/workspace/src")      → "/workspace/src"
    rootWithSep = "/workspace/src/"             → fast prefix check

  Per-call validation:
    read("data.json")
      resolve("/workspace/src", "data.json")   → "/workspace/src/data.json"
      startsWith("/workspace/src/")            → ✓ allowed

    read("../../etc/passwd")
      resolve("/workspace/src", "../../etc/passwd")  → "/etc/passwd"
      startsWith("/workspace/src/")                  → ✗ DENIED

    write("output.txt", content)
      mode === "ro"                             → ✗ DENIED (read-only)
```

### Browser Scope

URL allowlist with protocol, domain, and private-address checks:

```
Scope: {
  navigation: {
    allowedDomains: ["docs.example.com"],
    allowedProtocols: ["https:"],
    blockPrivateAddresses: true
  },
  trustTier: "verified"
}

  navigate("https://docs.example.com/api")    → ✓ allowed
  navigate("https://evil.com/phish")          → ✗ domain not in allowlist
  navigate("http://docs.example.com")         → ✗ protocol not allowed
  navigate("https://192.168.1.1/admin")       → ✗ private address blocked
  evaluate("alert(1)")                        → ✗ requires trustTier: "promoted"
```

### Credentials Scope

Glob-to-RegExp filter (principle of least information):

```
Scope: { keyPattern: "API_*" }

  Compile-once:
    pattern = /^API_[^]*$/

  Per-call:
    get("API_KEY_PROD")     → ✓ matches, returns value
    get("DB_PASSWORD")      → ✗ doesn't match, returns undefined
    get("API_KEY_STAGING")  → ✓ matches, returns value

  Non-matching keys return undefined — agent can't tell if the key
  exists or doesn't. Principle of least information.
```

### Memory Scope

Namespace injection + client-side filter:

```
Scope: { namespace: "research" }

  store("finding: X is Y", { tags: ["important"] })
    → backend.store("finding: X is Y", { tags: ["important"], namespace: "research" })

  recall("what is X?")
    → backend.recall("what is X?", { namespace: "research" })
    → client-side filter: only results where metadata.namespace === "research"
```

### Audited Credentials

Emits a structured `AuditEntry` on every credential access — for SOC2/HIPAA compliance. Never logs the secret value, only the key name and whether access was granted.

```
  Agent calls credentials.get("API_KEY")
       │
       ▼
  ┌──────────────────────────────────────────────────┐
  │  Audited Wrapper                                  │
  │  createAuditedCredentials(component, { sink })    │
  │                                                   │
  │  1. Read execution context (agent, session, turn) │
  │  2. Delegate to inner component                   │
  │  3. Measure duration                              │
  │  4. Emit AuditEntry (fire-and-forget):            │
  │     {                                             │
  │       kind: "secret_access",                      │
  │       agentId: "research-agent",                  │
  │       sessionId: "sess-123",                      │
  │       turnIndex: 7,                               │
  │       metadata: {                                 │
  │         credentialKey: "API_KEY",   ← key name    │
  │         granted: true              ← NOT value    │
  │       },                                          │
  │       durationMs: 2                               │
  │     }                                             │
  │                                                   │
  │  Sink errors swallowed — never blocks access.     │
  └──────────────────────┬───────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────┐
  │  Inner CredentialComponent                        │
  │  (scoped, enforced, or raw)                       │
  └──────────────────────────────────────────────────┘
```

Full composition chain when wired via `@koi/starter`:

```
  raw backend → enforced (policy) → scoped (glob filter) → audited (audit trail)
```

```typescript
import { createAuditedCredentials } from "@koi/scope";

const audited = createAuditedCredentials(scopedCredentials, {
  sink: myAuditSink,
  onError: (error, entry) => {
    console.error("Audit sink failed for key:", entry.metadata?.credentialKey, error);
  },
});

// Every .get() now emits an audit entry
const key = await audited.get("API_KEY");
```

When `auditSink` is provided in `ScopeBackends`, the `@koi/starter` auto-wiring composes the audit wrapper automatically:

```typescript
const runtime = await createConfiguredKoi({
  manifest: loadedManifest,
  backends: {
    credentials: envCredentials,
    auditSink: myAuditSink,  // ← enables credential access audit trail
  },
});
```

**Security guarantees:**
- Secret values never appear in audit entries (tested: `JSON.stringify(entry)` checked against value)
- Sink failures never block credential access (fire-and-forget via `void promise.catch()`)
- Graceful fallback without execution context: `agentId: "unknown"`, `turnIndex: -1`
- `onError` callback failures are swallowed to preserve the fire-and-forget guarantee

---

## Enforced Backends

The four `createEnforced*` factories add a pluggable `ScopeEnforcer` check before every operation. They compose on top of (or below) the scoped wrappers.

```typescript
// Filesystem: enforcer checks before every read/write/edit/list/search/delete/rename
createEnforcedFileSystem(backend: FileSystemBackend, enforcer: ScopeEnforcer): FileSystemBackend

// Browser: enforcer checks navigate and tabNew (URL operations)
createEnforcedBrowser(driver: BrowserDriver, enforcer: ScopeEnforcer): BrowserDriver

// Credentials: enforcer checks get
createEnforcedCredentials(component: CredentialComponent, enforcer: ScopeEnforcer): CredentialComponent

// Memory: enforcer checks store and recall
createEnforcedMemory(component: MemoryComponent, enforcer: ScopeEnforcer): MemoryComponent
```

Dispose propagation: enforced wrappers forward `dispose()` to both the underlying backend and the enforcer, ensuring cleanup of connection pools, timers, or database handles.

---

## ScopeEnforcer Interface (L0)

```typescript
type ScopeSubsystem = "filesystem" | "browser" | "credentials" | "memory";

interface ScopeAccessRequest {
  readonly subsystem: ScopeSubsystem;
  readonly operation: string;      // "read", "write", "navigate", "get", "store", etc.
  readonly resource: string;       // normalized path, URL, key, namespace
  readonly context?: Readonly<Record<string, unknown>>;
}

interface ScopeEnforcer {
  readonly checkAccess: (request: ScopeAccessRequest) => boolean | Promise<boolean>;
  readonly dispose?: () => void | Promise<void>;
}
```

The `boolean | Promise<boolean>` return type supports both sync (in-memory pattern matching) and async (HTTP, database) backends. Callers always `await`.

---

## Manifest Schema (@koi/manifest)

The `scope:` section in `koi.yaml` is validated by Zod and mapped to runtime types:

```yaml
scope:
  filesystem:
    root: /workspace/src        # required: path root for confinement
    mode: ro                    # optional: "rw" (default) or "ro"
  browser:
    allowedDomains:             # optional: domain allowlist
      - docs.example.com
    allowedProtocols:           # optional: protocol allowlist (default: https:)
      - https:
    blockPrivateAddresses: true # optional: block 10.x, 172.16.x, 192.168.x, etc.
    trustTier: verified         # optional: "sandbox" | "verified" | "promoted"
  credentials:
    keyPattern: "API_*"         # required: glob pattern for key filtering
  memory:
    namespace: research         # required: namespace for memory isolation
```

All fields are optional at the top level — an agent can declare any combination of scopes.

---

## Auto-Wiring (@koi/starter)

`resolveManifestScope()` maps manifest scope config + raw backends to scoped `ComponentProvider` instances:

```typescript
function resolveManifestScope(
  scopeConfig: ManifestScopeConfig,
  backends: ScopeBackends,
  enforcer?: ScopeEnforcer,
): readonly ComponentProvider[]
```

Used by `createConfiguredKoi()`:

```typescript
const runtime = await createConfiguredKoi({
  manifest: loadedManifest,      // has scope: { filesystem: ... }
  adapter: createPiAdapter(...),
  backends: {                    // raw backends (shared across agents)
    filesystem: realFsBackend,
    browser: playwrightDriver,
    credentials: envCredentials,
    memory: sqliteMemory,
  },
  enforcer: myEnforcer,          // optional pluggable policy
});
// Scoped providers auto-wired from manifest — zero manual wiring
```

---

## Performance

### Compile-Once / Validate-Per-Call

```
Assembly time (once):
  compileFileSystemScope()     → resolved root + rootWithSep
  compileNavigationSecurity()  → domain Set, protocol Set, regex patterns
  compileCredentialsScope()    → compiled RegExp from glob

Per tool call (hot path):
  Filesystem: resolve() + startsWith()    ← O(1) string ops
  Browser:    Set.has(hostname)           ← O(1) lookup
  Credentials: RegExp.test(key)           ← O(1) regex
  Memory:     string equality check       ← O(1)
  Enforcer:   checkAccess() call          ← depends on backend
```

### Zero-Overhead Bypass

When no enforcer or audit sink is provided, the composition skips those layers entirely — no empty function calls, no Promise wrapping:

```
Full chain:       raw → enforced(policy) → scoped(boundary) → audited(audit trail) → result
No enforcer:      raw → scoped(boundary) → audited(audit trail) → result
No audit sink:    raw → enforced(policy) → scoped(boundary) → result
Minimal:          raw → scoped(boundary) → result
```

---

## Examples

### Basic Filesystem Scoping

```typescript
import { createScopedFileSystem } from "@koi/scope";

const scopedFs = createScopedFileSystem(rawFsBackend, {
  root: "/workspace/agent-a",
  mode: "ro",
});

// Within scope — returns file content
const result = await scopedFs.read("notes.md");

// Escapes scope — returns PERMISSION error
const escaped = await scopedFs.read("../../etc/passwd");
// { ok: false, error: { code: "PERMISSION", message: "...escapes root..." } }

// Write blocked by mode — returns PERMISSION error
const writeResult = await scopedFs.write("output.txt", "data");
// { ok: false, error: { code: "PERMISSION", message: "...read-only..." } }
```

### Browser Scoping with Trust Tiers

```typescript
import { createScopedBrowser } from "@koi/scope";

const scopedBrowser = createScopedBrowser(playwrightDriver, {
  navigation: {
    allowedDomains: ["docs.example.com"],
    blockPrivateAddresses: true,
  },
  trustTier: "verified",
});

// Allowed domain — navigates
await scopedBrowser.navigate("https://docs.example.com/api");

// Blocked domain — PERMISSION error
await scopedBrowser.navigate("https://evil.com");

// JS eval requires "promoted" trust — blocked for "verified"
await scopedBrowser.evaluate("document.title");
```

### Enforcer + Scoped Wrapper Composition

```typescript
import { createEnforcedFileSystem } from "@koi/scope";

const enforcer: ScopeEnforcer = {
  checkAccess: async (req) => {
    // Check ReBAC policy server
    const resp = await fetch(`https://nexus.internal/check`, {
      method: "POST",
      body: JSON.stringify(req),
    });
    return resp.ok;
  },
  dispose: async () => { /* close connection pool */ },
};

const enforcedFs = createEnforcedFileSystem(rawFsBackend, enforcer);
// enforcedFs checks policy before every operation
// Compose with scoped wrapper for both policy + boundary:
const scopedAndEnforced = createScopedFileSystem(enforcedFs, {
  root: "/workspace",
  mode: "rw",
});
```

### Manifest-Driven Auto-Wiring

```typescript
import { createConfiguredKoi } from "@koi/starter";

const runtime = await createConfiguredKoi({
  manifest: await loadManifest("./koi.yaml"),
  adapter: createPiAdapter({
    model: "anthropic:claude-sonnet-4-5-20250929",
    getApiKey: async () => process.env.ANTHROPIC_API_KEY,
  }),
  backends: {
    filesystem: createNodeFsBackend(),
    browser: createPlaywrightBrowserDriver(),
    credentials: createEnvCredentials(),
    memory: createSqliteMemory(),
  },
  enforcer: createSqliteEnforcer("./policy.db"),
});

// manifest.scope auto-wired: each backend wrapped with scope + enforcement
// Agent sees only what the manifest declares
```

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────────────────┐
    ScopeEnforcer, ScopeAccessRequest, ScopeSubsystem — types only  │
    FileSystemBackend, BrowserDriver, CredentialComponent,          │
    MemoryComponent, Result, KoiError — interface contracts         │
                                                                    │
L0u @koi/scope ◄────────────────────────────────────────────────────┘
    imports from L0 + peer L0u only (+ node:path standard library)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ @koi/core + @koi/execution-context are the only workspace deps

L3  @koi/starter
    resolveManifestScope() — auto-wiring that combines:
      @koi/scope (scoped + enforced wrappers)
      @koi/filesystem (createFileSystemProvider)
      @koi/tool-browser (createBrowserProvider)
      @koi/manifest (ManifestScopeConfig types)
```
