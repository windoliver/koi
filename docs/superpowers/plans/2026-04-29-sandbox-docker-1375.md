# Phase 3 sandbox-1: `@koi/sandbox-docker` + `@koi/sandbox-executor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore two L2 sandbox packages: `@koi/sandbox-docker` (Docker-backed `SandboxAdapter` from `@koi/core`) and `@koi/sandbox-executor` (subprocess-backed `SandboxExecutor` from `@koi/core`). Together they provide containerized command execution and isolated code execution for Phase 3 forge/code-runner workflows.

**Architecture:**
- `sandbox-docker` implements `SandboxAdapter` by translating `SandboxProfile` → Docker container options. Docker is **optional** (runtime detect; missing Docker → typed error). Injectable `DockerClient` keeps the adapter unit-testable without a daemon. Default client wraps the Docker CLI via `Bun.spawn`.
- `sandbox-executor` implements `SandboxExecutor` by spawning a Bun subprocess that runs untrusted code via `subprocess-runner.ts`, framing the result through stderr. OS-level isolation is **delegated to `@koi/sandbox-os`** (consumed by callers), keeping this package focused on command building, output capture, and timeout enforcement.
- Both packages depend only on `@koi/core` (L0). Layer-strict.

**Tech Stack:** Bun 1.3.x, TypeScript 6 strict, `bun:test`, tsup, Biome. No new runtime deps. Docker CLI as ambient binary.

**Out of scope:** persistence/`findOrCreate` (defer to follow-up — issue scope does not require it), seatbelt/bwrap regeneration (already in `@koi/sandbox-os`), cloud sandboxes (#1376/#1377/#1379).

**LOC budget:** ≤ ~400 LOC source + ~300 tests across both packages (issue says "~400"; v1 was 3.3K — heavy simplification).

---

## File Structure

### `packages/sandbox/sandbox-docker/` (new)

```
package.json                     manifest, deps: @koi/core
tsup.config.ts                   ESM-only build
tsconfig.json                    extends ../../../tsconfig.base.json
src/
  index.ts                       public re-exports
  types.ts                       DockerClient, DockerContainer, DockerExecResult, DockerCreateOpts, DockerAdapterConfig
  validate.ts                    validateDockerConfig() — fills defaults, returns Result
  classify.ts                    classifyDockerError() — exit code → KoiError
  profile-to-opts.ts             mapProfileToDockerOpts(profile, image) — SandboxProfile → DockerCreateOpts + network info
  network.ts                     resolveDockerNetwork(profile.network) — networkMode + capAdd
  instance.ts                    createDockerInstance(container, networkConfig) — wraps DockerContainer as SandboxInstance
  default-client.ts              createDefaultDockerClient() — Bun.spawn over `docker` CLI
  detect.ts                      detectDocker() — `docker version` probe with cache
```

Tests are colocated (`*.test.ts` next to source).

### `packages/sandbox/sandbox-executor/` (new)

```
package.json                     manifest, deps: @koi/core
tsup.config.ts                   ESM-only build (preserve subprocess-runner.ts as asset)
tsconfig.json                    extends base
src/
  index.ts                       public re-exports
  types.ts                       internal types (SubprocessOutput, RunnerOptions)
  subprocess-runner.ts           CHILD entry — loads code, frames result on stderr
  subprocess-executor.ts         createSubprocessExecutor() — SandboxExecutor impl, Bun.spawn host side
```

### Shared / wiring

```
packages/meta/runtime/package.json           add deps
packages/meta/runtime/tsconfig.json          add references
packages/meta/runtime/scripts/record-cassettes.ts   add QueryConfig "sandbox-docker-noop"
packages/meta/runtime/src/__tests__/golden-replay.test.ts   add 2 standalone golden queries per package
docs/L2/sandbox-docker.md                    Doc-gate: package overview
docs/L2/sandbox-executor.md                  Doc-gate: package overview
scripts/layers.ts                            register both as L2
```

---

## Task 1: Doc-gate — write `docs/L2/sandbox-docker.md`

**Files:**
- Create: `docs/L2/sandbox-docker.md`

- [ ] **Step 1: Write the doc**

```markdown
# @koi/sandbox-docker — Docker-backed SandboxAdapter

Implements the `SandboxAdapter` contract from `@koi/core` using Docker containers.
Each call to `create(profile)` produces a fresh container; the returned `SandboxInstance`
is a thin wrapper around a `DockerContainer` that translates `SandboxProfile`
filesystem/network/resource policies into container creation options.

---

## Why it exists

Cloud and forge workflows need stronger isolation than OS-level sandboxes provide.
A Docker container gives full filesystem isolation, configurable network policy,
and hard resource limits without depending on a hosted vendor. This package is the
local container backend that pairs with `@koi/sandbox-os` (process-level) and the
hosted backends (#1376 e2b/daytona, #1377 wasm/cf/vercel).

## Layer

```
L2  @koi/sandbox-docker
    depends on: @koi/core (L0)
    does NOT import: @koi/engine (L1), peer L2
```

Docker is optional — `koi` field `optional: true`. Missing Docker yields a typed
`SANDBOX_UNAVAILABLE` error from `createDockerAdapter`; nothing throws.

## Public API

```typescript
export interface DockerAdapterConfig {
  readonly socketPath?: string;            // default: /var/run/docker.sock
  readonly image?: string;                 // default: "ubuntu:22.04"
  readonly client?: DockerClient;          // injectable for tests
}

export function createDockerAdapter(
  config: DockerAdapterConfig,
): Result<SandboxAdapter, KoiError>;
```

`adapter.create(profile)` returns a `SandboxInstance` whose `exec`, `readFile`,
`writeFile`, and `destroy` methods proxy to the container. Profile mapping:

| Profile field            | Docker option           |
|--------------------------|-------------------------|
| `network.allow=false`    | `--network none`        |
| `network.allow=true`     | `--network bridge`      |
| `resources.maxPids`      | `--pids-limit`          |
| `resources.maxMemoryMb`  | `--memory <N>m`         |
| `filesystem.denyRead`    | (validated; not bound)  |
| `nexusMounts`            | `--mount type=bind,...` |

## Errors

- `SANDBOX_UNAVAILABLE` — `docker` CLI not on PATH, daemon unreachable
- `SANDBOX_TIMEOUT` — exec exceeded `timeoutMs`
- `SANDBOX_CRASH` — non-zero exit code, OOM, or signal

## v1 references

`archive/v1/packages/virt/sandbox-docker` — ported `types.ts`, `profile-to-opts.ts`,
`network.ts`, `instance.ts`, `validate.ts`, `classify.ts`, `default-client.ts`.
Dropped: `findOrCreate` / scope persistence (deferred).
```

- [ ] **Step 2: Commit**

```bash
git add docs/L2/sandbox-docker.md
git commit -m "docs(sandbox-docker): L2 package overview (#1375)"
```

---

## Task 2: Doc-gate — write `docs/L2/sandbox-executor.md`

**Files:**
- Create: `docs/L2/sandbox-executor.md`

- [ ] **Step 1: Write the doc**

```markdown
# @koi/sandbox-executor — Subprocess-backed SandboxExecutor

Implements the `SandboxExecutor` contract from `@koi/core` by spawning a Bun
subprocess that loads untrusted code, runs it, and returns the result through a
stderr-framed protocol. OS-level isolation (seatbelt/bwrap) is delegated to
`@koi/sandbox-os`; this package is the executor wrapper.

## Why it exists

`@koi/forge` (verifier) and `@koi/sandbox-ipc` need to run brick code in a separate
process so timeouts can SIGKILL, OOM crashes don't take down the host, and the
host heap is invisible. This package is the *minimal* subprocess executor: it
spawns Bun, frames the result, captures bounded output, and translates exit
modes into typed `SandboxError` values.

## Layer

```
L2  @koi/sandbox-executor
    depends on: @koi/core (L0)
    does NOT import: @koi/engine (L1), peer L2
```

## Public API

```typescript
export interface SubprocessExecutorConfig {
  readonly bunPath?: string;       // default: "bun"
  readonly maxOutputBytes?: number; // default: 10 MiB
  readonly cwd?: string;
}

export function createSubprocessExecutor(
  config?: SubprocessExecutorConfig,
): SandboxExecutor;
```

`executor.execute(code, input, timeoutMs, context?)`:

1. Writes `code` to a temp file under `os.tmpdir()`.
2. Spawns `bun run <runner.ts>` with the temp path + JSON-encoded `input` on argv.
3. Reads stderr until the `__KOI_RESULT__\n` marker; rest is `SubprocessOutput`.
4. SIGKILLs on timeout; classifies non-zero exits as `CRASH`/`OOM`/`PERMISSION`.
5. Returns `Result<SandboxResult, SandboxError>`.

## v1 references

`archive/v1/packages/virt/sandbox-executor` — ported `subprocess-runner.ts`,
trimmed `subprocess-executor.ts` (517 → ~200 LOC). Dropped inline
seatbelt/bwrap profile generation (callers now compose with `@koi/sandbox-os`).
```

- [ ] **Step 2: Commit**

```bash
git add docs/L2/sandbox-executor.md
git commit -m "docs(sandbox-executor): L2 package overview (#1375)"
```

---

## Task 3: Scaffold `@koi/sandbox-docker` package

**Files:**
- Create: `packages/sandbox/sandbox-docker/package.json`
- Create: `packages/sandbox/sandbox-docker/tsconfig.json`
- Create: `packages/sandbox/sandbox-docker/tsup.config.ts`
- Create: `packages/sandbox/sandbox-docker/src/index.ts` (empty placeholder)
- Modify: `scripts/layers.ts` — register as L2

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@koi/sandbox-docker",
  "description": "Docker-backed SandboxAdapter for containerized command execution",
  "version": "0.1.0",
  "private": true,
  "koi": { "optional": true },
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "dependencies": {
    "@koi/core": "workspace:*"
  },
  "devDependencies": {}
}
```

- [ ] **Step 2: Create tsconfig.json**

Copy `packages/sandbox/sandbox-os/tsconfig.json` verbatim.

- [ ] **Step 3: Create tsup.config.ts**

Copy `packages/sandbox/sandbox-os/tsup.config.ts` verbatim.

- [ ] **Step 4: Create empty `src/index.ts`**

```typescript
export {};
```

- [ ] **Step 5: Register in `scripts/layers.ts`**

Add `@koi/sandbox-docker` to the L2 list following the same pattern as `@koi/sandbox-os`.

- [ ] **Step 6: Verify layers + install**

```bash
bun install
bun run check:layers
```

Expected: `bun install` succeeds, `check:layers` passes.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox/sandbox-docker scripts/layers.ts package.json bun.lock
git commit -m "chore(sandbox-docker): scaffold L2 package (#1375)"
```

---

## Task 4: `types.ts` — port v1 type contracts

**Files:**
- Create: `packages/sandbox/sandbox-docker/src/types.ts`

- [ ] **Step 1: Write the file**

```typescript
/**
 * Internal Docker adapter types. Public adapter is exported via index.ts.
 */

export interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DockerExecOpts {
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface DockerContainer {
  readonly id: string;
  readonly exec: (cmd: string, opts?: DockerExecOpts) => Promise<DockerExecResult>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, content: Uint8Array) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly remove: () => Promise<void>;
}

export interface DockerCreateOpts {
  readonly image: string;
  readonly networkMode: "none" | "bridge" | string;
  readonly env?: Readonly<Record<string, string>>;
  readonly memoryMb?: number;
  readonly pidsLimit?: number;
  readonly binds?: readonly string[];
  readonly capAdd?: readonly string[];
}

export interface DockerClient {
  readonly createContainer: (opts: DockerCreateOpts) => Promise<DockerContainer>;
}

export interface DockerAdapterConfig {
  readonly socketPath?: string;
  readonly image?: string;
  readonly client?: DockerClient;
}

export interface ResolvedDockerConfig {
  readonly socketPath: string;
  readonly image: string;
  readonly client: DockerClient;
}
```

- [ ] **Step 2: Typecheck**

```bash
bun run --cwd packages/sandbox/sandbox-docker typecheck
```

Expected: PASS (zero errors).

- [ ] **Step 3: Commit**

```bash
git add packages/sandbox/sandbox-docker/src/types.ts
git commit -m "feat(sandbox-docker): internal type contracts (#1375)"
```

---

## Task 5: `validate.ts` + tests — fill defaults, enforce config invariants

**Files:**
- Create: `packages/sandbox/sandbox-docker/src/validate.test.ts`
- Create: `packages/sandbox/sandbox-docker/src/validate.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { validateDockerConfig } from "./validate.js";

describe("validateDockerConfig", () => {
  test("returns error when no client and no socketPath defaults available", () => {
    const result = validateDockerConfig({ client: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SANDBOX_UNAVAILABLE");
    }
  });

  test("uses provided client and applies image default", () => {
    const stubClient = { createContainer: async () => ({}) as never };
    const result = validateDockerConfig({ client: stubClient });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.image).toBe("ubuntu:22.04");
      expect(result.value.client).toBe(stubClient);
    }
  });

  test("preserves explicit image override", () => {
    const stubClient = { createContainer: async () => ({}) as never };
    const result = validateDockerConfig({ client: stubClient, image: "alpine:3.19" });
    expect(result.ok && result.value.image).toBe("alpine:3.19");
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test packages/sandbox/sandbox-docker/src/validate.test.ts
```

Expected: FAIL ("module not found").

- [ ] **Step 3: Implement**

```typescript
import type { KoiError, Result } from "@koi/core";
import type { DockerAdapterConfig, ResolvedDockerConfig } from "./types.js";

const DEFAULT_IMAGE = "ubuntu:22.04";
const DEFAULT_SOCKET = "/var/run/docker.sock";

export function validateDockerConfig(
  config: DockerAdapterConfig,
): Result<ResolvedDockerConfig, KoiError> {
  if (config.client === undefined) {
    const error: KoiError = {
      code: "SANDBOX_UNAVAILABLE",
      message: "Docker client not provided and default-client probe not yet wired",
      retryable: false,
    };
    return { ok: false, error };
  }

  return {
    ok: true,
    value: {
      socketPath: config.socketPath ?? DEFAULT_SOCKET,
      image: config.image ?? DEFAULT_IMAGE,
      client: config.client,
    },
  };
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
bun test packages/sandbox/sandbox-docker/src/validate.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-docker/src/validate.ts packages/sandbox/sandbox-docker/src/validate.test.ts
git commit -m "feat(sandbox-docker): config validation + defaults (#1375)"
```

---

## Task 6: `network.ts` + tests — profile network → Docker network mode

**Files:**
- Create: `packages/sandbox/sandbox-docker/src/network.test.ts`
- Create: `packages/sandbox/sandbox-docker/src/network.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { resolveDockerNetwork } from "./network.js";

describe("resolveDockerNetwork", () => {
  test("network.allow=false → networkMode 'none'", () => {
    const r = resolveDockerNetwork({ allow: false });
    expect(r.networkMode).toBe("none");
  });

  test("network.allow=true → networkMode 'bridge'", () => {
    const r = resolveDockerNetwork({ allow: true });
    expect(r.networkMode).toBe("bridge");
  });

  test("undefined network defaults to denied", () => {
    const r = resolveDockerNetwork(undefined);
    expect(r.networkMode).toBe("none");
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test packages/sandbox/sandbox-docker/src/network.test.ts
```

- [ ] **Step 3: Implement**

```typescript
import type { SandboxProfile } from "@koi/core";

export interface ResolvedDockerNetwork {
  readonly networkMode: "none" | "bridge";
}

export function resolveDockerNetwork(
  network: SandboxProfile["network"] | undefined,
): ResolvedDockerNetwork {
  if (network?.allow === true) {
    return { networkMode: "bridge" };
  }
  return { networkMode: "none" };
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-docker/src/network.ts packages/sandbox/sandbox-docker/src/network.test.ts
git commit -m "feat(sandbox-docker): profile→network resolver (#1375)"
```

---

## Task 7: `profile-to-opts.ts` + tests — full profile mapping

**Files:**
- Create: `packages/sandbox/sandbox-docker/src/profile-to-opts.test.ts`
- Create: `packages/sandbox/sandbox-docker/src/profile-to-opts.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";

describe("mapProfileToDockerOpts", () => {
  test("denies network and applies pids/memory limits", () => {
    const { opts } = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: { maxPids: 64, maxMemoryMb: 256 },
      },
      "ubuntu:22.04",
    );
    expect(opts.networkMode).toBe("none");
    expect(opts.pidsLimit).toBe(64);
    expect(opts.memoryMb).toBe(256);
    expect(opts.image).toBe("ubuntu:22.04");
  });

  test("allows bridge network when profile permits", () => {
    const { opts } = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: true },
        resources: {},
      },
      "alpine:3.19",
    );
    expect(opts.networkMode).toBe("bridge");
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
import type { SandboxProfile } from "@koi/core";
import { resolveDockerNetwork } from "./network.js";
import type { DockerCreateOpts } from "./types.js";

export interface ProfileMapping {
  readonly opts: DockerCreateOpts;
  readonly networkMode: "none" | "bridge";
}

export function mapProfileToDockerOpts(
  profile: SandboxProfile,
  image: string,
): ProfileMapping {
  const { networkMode } = resolveDockerNetwork(profile.network);
  const opts: DockerCreateOpts = {
    image,
    networkMode,
    ...(profile.resources?.maxPids !== undefined
      ? { pidsLimit: profile.resources.maxPids }
      : {}),
    ...(profile.resources?.maxMemoryMb !== undefined
      ? { memoryMb: profile.resources.maxMemoryMb }
      : {}),
    ...(profile.env !== undefined ? { env: profile.env } : {}),
  };
  return { opts, networkMode };
}
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-docker/src/profile-to-opts.{ts,test.ts}
git commit -m "feat(sandbox-docker): SandboxProfile → DockerCreateOpts (#1375)"
```

---

## Task 8: `classify.ts` + tests — exit code → KoiError

**Files:**
- Create: `packages/sandbox/sandbox-docker/src/classify.test.ts`
- Create: `packages/sandbox/sandbox-docker/src/classify.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { classifyDockerExit } from "./classify.js";

describe("classifyDockerExit", () => {
  test("exitCode 137 → OOM-killed", () => {
    const e = classifyDockerExit({ exitCode: 137, stdout: "", stderr: "" });
    expect(e.code).toBe("SANDBOX_CRASH");
    expect(e.context?.["oomKilled"]).toBe(true);
  });

  test("exitCode 124 → TIMEOUT", () => {
    const e = classifyDockerExit({ exitCode: 124, stdout: "", stderr: "" });
    expect(e.code).toBe("SANDBOX_TIMEOUT");
  });

  test("exitCode 0 → undefined (no error)", () => {
    expect(classifyDockerExit({ exitCode: 0, stdout: "", stderr: "" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
import type { KoiError } from "@koi/core";
import type { DockerExecResult } from "./types.js";

export function classifyDockerExit(result: DockerExecResult): KoiError | undefined {
  if (result.exitCode === 0) return undefined;
  if (result.exitCode === 124) {
    return {
      code: "SANDBOX_TIMEOUT",
      message: `Docker exec timed out`,
      retryable: false,
      context: { exitCode: result.exitCode, stderr: result.stderr.slice(0, 512) },
    };
  }
  const oomKilled = result.exitCode === 137;
  return {
    code: "SANDBOX_CRASH",
    message: `Docker exec failed with exit code ${result.exitCode}`,
    retryable: false,
    context: {
      exitCode: result.exitCode,
      oomKilled,
      stderr: result.stderr.slice(0, 512),
    },
  };
}
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-docker/src/classify.{ts,test.ts}
git commit -m "feat(sandbox-docker): exit-code classifier (#1375)"
```

---

## Task 9: `instance.ts` + tests — wrap DockerContainer as SandboxInstance

**Files:**
- Create: `packages/sandbox/sandbox-docker/src/instance.test.ts`
- Create: `packages/sandbox/sandbox-docker/src/instance.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createDockerInstance } from "./instance.js";
import type { DockerContainer, DockerExecResult } from "./types.js";

function stubContainer(execResult: DockerExecResult): DockerContainer {
  return {
    id: "stub",
    exec: async () => execResult,
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    stop: async () => {},
    remove: async () => {},
  };
}

describe("createDockerInstance", () => {
  test("exec returns SandboxAdapterResult with exit code + duration", async () => {
    const inst = createDockerInstance(stubContainer({ exitCode: 0, stdout: "hi", stderr: "" }));
    const r = await inst.exec("echo", ["hi"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi");
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("destroy stops and removes the container", async () => {
    let stopped = 0;
    let removed = 0;
    const inst = createDockerInstance({
      ...stubContainer({ exitCode: 0, stdout: "", stderr: "" }),
      stop: async () => { stopped += 1; },
      remove: async () => { removed += 1; },
    });
    await inst.destroy();
    expect(stopped).toBe(1);
    expect(removed).toBe(1);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
import type { SandboxAdapterResult, SandboxInstance } from "@koi/core";
import type { DockerContainer } from "./types.js";

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function createDockerInstance(container: DockerContainer): SandboxInstance {
  return {
    exec: async (command, args, options) => {
      const start = Date.now();
      const cmd = [command, ...args].map(quoteArg).join(" ");
      const result = await container.exec(cmd, {
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      const adapterResult: SandboxAdapterResult = {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - start,
        timedOut: result.exitCode === 124,
        oomKilled: result.exitCode === 137,
      };
      return adapterResult;
    },
    readFile: (path) => container.readFile(path),
    writeFile: (path, content) => container.writeFile(path, content),
    destroy: async () => {
      await container.stop();
      await container.remove();
    },
  };
}
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-docker/src/instance.{ts,test.ts}
git commit -m "feat(sandbox-docker): SandboxInstance wrapper (#1375)"
```

---

## Task 10: `default-client.ts` + `detect.ts` — real Docker CLI client

**Files:**
- Create: `packages/sandbox/sandbox-docker/src/detect.ts`
- Create: `packages/sandbox/sandbox-docker/src/detect.test.ts`
- Create: `packages/sandbox/sandbox-docker/src/default-client.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { detectDocker } from "./detect.js";

describe("detectDocker", () => {
  test("returns available=false when bun spawn returns non-zero", async () => {
    const result = await detectDocker({ probe: async () => 1 });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("docker");
  });

  test("returns available=true when probe exits 0", async () => {
    const result = await detectDocker({ probe: async () => 0 });
    expect(result.available).toBe(true);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `detect.ts`**

```typescript
export interface DockerAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface DetectOptions {
  readonly probe?: () => Promise<number>;
}

export async function detectDocker(options: DetectOptions = {}): Promise<DockerAvailability> {
  const probe =
    options.probe ??
    (async (): Promise<number> => {
      const proc = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return await proc.exited;
    });

  try {
    const code = await probe();
    if (code === 0) return { available: true };
    return { available: false, reason: `docker probe exited ${code}` };
  } catch (err) {
    return { available: false, reason: `docker probe failed: ${(err as Error).message}` };
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Implement `default-client.ts`** (no separate test — integration covered by `instance.test.ts` via stub; CLI client only used when Docker present)

```typescript
import type {
  DockerClient,
  DockerContainer,
  DockerCreateOpts,
  DockerExecOpts,
  DockerExecResult,
} from "./types.js";

async function runDocker(args: readonly string[], stdin?: string): Promise<DockerExecResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function buildCreateArgs(opts: DockerCreateOpts): readonly string[] {
  const args: string[] = ["create", "--network", opts.networkMode];
  if (opts.pidsLimit !== undefined) args.push("--pids-limit", String(opts.pidsLimit));
  if (opts.memoryMb !== undefined) args.push("--memory", `${opts.memoryMb}m`);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
  for (const bind of opts.binds ?? []) args.push("--volume", bind);
  for (const cap of opts.capAdd ?? []) args.push("--cap-add", cap);
  args.push(opts.image, "sleep", "infinity");
  return args;
}

export function createDefaultDockerClient(): DockerClient {
  return {
    createContainer: async (opts) => {
      const create = await runDocker(buildCreateArgs(opts));
      if (create.exitCode !== 0) {
        throw new Error(`docker create failed: ${create.stderr}`, { cause: create });
      }
      const id = create.stdout.trim();
      const start = await runDocker(["start", id]);
      if (start.exitCode !== 0) {
        throw new Error(`docker start failed: ${start.stderr}`, { cause: start });
      }
      return makeContainer(id);
    },
  };
}

function makeContainer(id: string): DockerContainer {
  return {
    id,
    exec: async (cmd, execOpts: DockerExecOpts = {}) => {
      const args = ["exec"];
      for (const [k, v] of Object.entries(execOpts.env ?? {})) args.push("--env", `${k}=${v}`);
      args.push(id, "sh", "-c", cmd);
      return runDocker(args, execOpts.stdin);
    },
    readFile: async (path) => {
      const r = await runDocker(["exec", id, "cat", path]);
      if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr}`);
      return new TextEncoder().encode(r.stdout);
    },
    writeFile: async (path, content) => {
      const text = new TextDecoder().decode(content);
      const r = await runDocker(["exec", "-i", id, "sh", "-c", `cat > ${path}`], text);
      if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr}`);
    },
    stop: async () => {
      await runDocker(["stop", id]);
    },
    remove: async () => {
      await runDocker(["rm", "-f", id]);
    },
  };
}
```

- [ ] **Step 6: Typecheck**

```bash
bun run --cwd packages/sandbox/sandbox-docker typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox/sandbox-docker/src/{detect,default-client}.{ts,test.ts}
git commit -m "feat(sandbox-docker): detection + default CLI client (#1375)"
```

---

## Task 11: `index.ts` — `createDockerAdapter` factory + public exports

**Files:**
- Create: `packages/sandbox/sandbox-docker/src/adapter.test.ts`
- Modify: `packages/sandbox/sandbox-docker/src/index.ts`
- Create: `packages/sandbox/sandbox-docker/src/adapter.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createDockerAdapter } from "./adapter.js";
import type { DockerClient } from "./types.js";

const stubClient: DockerClient = {
  createContainer: async () => ({
    id: "c1",
    exec: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    stop: async () => {},
    remove: async () => {},
  }),
};

describe("createDockerAdapter", () => {
  test("returns a SandboxAdapter named 'docker'", () => {
    const r = createDockerAdapter({ client: stubClient });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("docker");
  });

  test("create(profile) yields a SandboxInstance with working exec", async () => {
    const r = createDockerAdapter({ client: stubClient });
    if (!r.ok) throw new Error("setup failed");
    const inst = await r.value.create({
      filesystem: { defaultReadAccess: "open" },
      network: { allow: false },
      resources: {},
    });
    const out = await inst.exec("echo", ["ok"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("ok");
  });

  test("missing client returns SANDBOX_UNAVAILABLE", () => {
    const r = createDockerAdapter({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SANDBOX_UNAVAILABLE");
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `adapter.ts`**

```typescript
import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createDockerInstance } from "./instance.js";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";
import type { DockerAdapterConfig } from "./types.js";
import { validateDockerConfig } from "./validate.js";

export function createDockerAdapter(
  config: DockerAdapterConfig,
): Result<SandboxAdapter, KoiError> {
  const validated = validateDockerConfig(config);
  if (!validated.ok) return validated;
  const { client, image } = validated.value;

  return {
    ok: true,
    value: {
      name: "docker",
      create: async (profile: SandboxProfile) => {
        const { opts } = mapProfileToDockerOpts(profile, image);
        const container = await client.createContainer(opts);
        return createDockerInstance(container);
      },
    },
  };
}
```

- [ ] **Step 4: Update `index.ts`**

```typescript
export { createDockerAdapter } from "./adapter.js";
export { createDefaultDockerClient } from "./default-client.js";
export { detectDocker } from "./detect.js";
export type {
  DockerAdapterConfig,
  DockerClient,
  DockerContainer,
  DockerExecOpts,
  DockerExecResult,
} from "./types.js";
```

- [ ] **Step 5: Run all package tests + typecheck + lint**

```bash
bun test packages/sandbox/sandbox-docker
bun run --cwd packages/sandbox/sandbox-docker typecheck
bun run --cwd packages/sandbox/sandbox-docker lint
```

All PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/sandbox-docker/src/{adapter,index}.{ts,test.ts}
git commit -m "feat(sandbox-docker): public createDockerAdapter factory (#1375)"
```

---

## Task 12: Scaffold `@koi/sandbox-executor` package

**Files:**
- Create: `packages/sandbox/sandbox-executor/package.json`
- Create: `packages/sandbox/sandbox-executor/tsconfig.json`
- Create: `packages/sandbox/sandbox-executor/tsup.config.ts`
- Create: `packages/sandbox/sandbox-executor/src/index.ts` (placeholder)
- Modify: `scripts/layers.ts`

- [ ] **Step 1: Create `package.json`** (mirrors sandbox-docker; description: "Subprocess-backed SandboxExecutor for isolated code execution")

- [ ] **Step 2: Copy tsconfig + tsup config**

- [ ] **Step 3: Empty `src/index.ts`**

```typescript
export {};
```

- [ ] **Step 4: Register L2**

Add `@koi/sandbox-executor` to `scripts/layers.ts`.

- [ ] **Step 5: Verify**

```bash
bun install
bun run check:layers
```

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/sandbox-executor scripts/layers.ts package.json bun.lock
git commit -m "chore(sandbox-executor): scaffold L2 package (#1375)"
```

---

## Task 13: Port `subprocess-runner.ts` (child entrypoint)

**Files:**
- Create: `packages/sandbox/sandbox-executor/src/subprocess-runner.ts`

This is the *child-side* script — Bun loads it, the host parses framed output. It runs in the spawned subprocess only.

- [ ] **Step 1: Port from v1 verbatim with minor tightening**

Copy `archive/v1/packages/virt/sandbox-executor/src/subprocess-runner.ts` → `src/subprocess-runner.ts`. Key invariants preserved:
- Reads `process.argv[2]` (code path) and `process.argv[3]` (input JSON).
- Dynamic-imports the code path and calls its default export with input.
- Frames result as `__KOI_RESULT__\n<json>` on **stderr** (stdout reserved for code's own output).
- Catches all errors, frames as `{ ok: false, error: <message> }`.

(No tests — this is exercised end-to-end by `subprocess-executor.test.ts`.)

- [ ] **Step 2: Typecheck**

```bash
bun run --cwd packages/sandbox/sandbox-executor typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/sandbox/sandbox-executor/src/subprocess-runner.ts
git commit -m "feat(sandbox-executor): port v1 subprocess runner (#1375)"
```

---

## Task 14: `subprocess-executor.ts` + tests — host-side SandboxExecutor

**Files:**
- Create: `packages/sandbox/sandbox-executor/src/subprocess-executor.test.ts`
- Create: `packages/sandbox/sandbox-executor/src/subprocess-executor.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createSubprocessExecutor } from "./subprocess-executor.js";

describe("createSubprocessExecutor", () => {
  test("runs simple code and returns output", async () => {
    const exec = createSubprocessExecutor();
    const code = `export default async (input) => ({ doubled: input * 2 });`;
    const r = await exec.execute(code, 21, 5_000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.output).toEqual({ doubled: 42 });
  });

  test("kills on timeout and returns SandboxError TIMEOUT", async () => {
    const exec = createSubprocessExecutor();
    const code = `export default async () => { while (true) {} };`;
    const r = await exec.execute(code, null, 250);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TIMEOUT");
  });

  test("classifies thrown error as CRASH", async () => {
    const exec = createSubprocessExecutor();
    const code = `export default async () => { throw new Error("boom"); };`;
    const r = await exec.execute(code, null, 5_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CRASH");
      expect(r.error.message).toContain("boom");
    }
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement** (target ~150 LOC; v1 was 517)

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutionContext,
  SandboxError,
  SandboxExecutor,
  SandboxResult,
} from "@koi/core";

export interface SubprocessExecutorConfig {
  readonly bunPath?: string;
  readonly maxOutputBytes?: number;
}

const RESULT_MARKER = "__KOI_RESULT__";
const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024;

function resolveRunnerPath(): string {
  const here = import.meta.dir;
  if (here.endsWith("/dist") || here.endsWith("\\dist")) {
    return join(here, "..", "src", "subprocess-runner.ts");
  }
  return join(here, "subprocess-runner.ts");
}

function writeCodeFile(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "koi-sandbox-"));
  const path = join(dir, "code.ts");
  writeFileSync(path, code, "utf8");
  return path;
}

function parseFramedResult(stderr: string):
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: string }
  | undefined {
  const idx = stderr.lastIndexOf(`${RESULT_MARKER}\n`);
  if (idx === -1) return undefined;
  const json = stderr.slice(idx + RESULT_MARKER.length + 1).trim();
  try {
    return JSON.parse(json) as never;
  } catch {
    return undefined;
  }
}

export function createSubprocessExecutor(
  config: SubprocessExecutorConfig = {},
): SandboxExecutor {
  const bunPath = config.bunPath ?? "bun";
  const maxOutput = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const runnerPath = resolveRunnerPath();

  return {
    execute: async (code, input, timeoutMs, _context?: ExecutionContext) => {
      const codePath = writeCodeFile(code);
      const inputJson = JSON.stringify(input ?? null);
      const start = Date.now();

      const proc = Bun.spawn([bunPath, "run", runnerPath, codePath, inputJson], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => proc.kill(9), timeoutMs);
      const exitCode = await proc.exited;
      clearTimeout(timer);

      const durationMs = Date.now() - start;
      const stderrText = (await new Response(proc.stderr).text()).slice(0, maxOutput);

      if (exitCode === 137 || exitCode === -9) {
        const error: SandboxError = {
          code: durationMs >= timeoutMs ? "TIMEOUT" : "OOM",
          message:
            durationMs >= timeoutMs
              ? `Execution exceeded ${timeoutMs}ms`
              : "Subprocess killed (likely OOM)",
          durationMs,
        };
        return { ok: false, error };
      }

      const framed = parseFramedResult(stderrText);
      if (framed === undefined) {
        const error: SandboxError = {
          code: "CRASH",
          message: `Subprocess exited ${exitCode} with no framed result`,
          durationMs,
          stack: stderrText.slice(-2_000),
        };
        return { ok: false, error };
      }

      if (!framed.ok) {
        const error: SandboxError = {
          code: "CRASH",
          message: framed.error,
          durationMs,
        };
        return { ok: false, error };
      }

      const value: SandboxResult = { output: framed.output, durationMs };
      return { ok: true, value };
    },
  };
}
```

- [ ] **Step 4: Run — PASS**

```bash
bun test packages/sandbox/sandbox-executor
```

Expected: 3 pass.

- [ ] **Step 5: Update `src/index.ts`**

```typescript
export { createSubprocessExecutor } from "./subprocess-executor.js";
export type { SubprocessExecutorConfig } from "./subprocess-executor.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/sandbox-executor/src/{subprocess-executor,index}.{ts,test.ts}
git commit -m "feat(sandbox-executor): subprocess-based SandboxExecutor (#1375)"
```

---

## Task 15: tsup must ship `subprocess-runner.ts` as a runtime asset

**Files:**
- Modify: `packages/sandbox/sandbox-executor/tsup.config.ts`

The runner is loaded at runtime via Bun. tsup must NOT bundle it into `subprocess-executor.js`; it must be copied to `dist/` so the resolver fallback (`dist/../src/subprocess-runner.ts`) finds it.

- [ ] **Step 1: Patch tsup config**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/subprocess-runner.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  external: ["@koi/core"],
});
```

- [ ] **Step 2: Build + verify dist contains both files**

```bash
bun run --cwd packages/sandbox/sandbox-executor build
ls packages/sandbox/sandbox-executor/dist/
```

Expected: `index.js`, `index.d.ts`, `subprocess-runner.js`, `subprocess-runner.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/sandbox/sandbox-executor/tsup.config.ts
git commit -m "build(sandbox-executor): emit subprocess-runner as separate entry (#1375)"
```

---

## Task 16: Wire both packages into `@koi/runtime` + golden queries

**Files:**
- Modify: `packages/meta/runtime/package.json` — add deps
- Modify: `packages/meta/runtime/tsconfig.json` — add references
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts` — add 2 standalone golden queries per package (4 total)

Per project rule: every new L2 must be wired with golden coverage.

- [ ] **Step 1: Add deps to runtime `package.json`**

```json
"@koi/sandbox-docker": "workspace:*",
"@koi/sandbox-executor": "workspace:*",
```

- [ ] **Step 2: Add to runtime `tsconfig.json` references**

(Match existing `@koi/sandbox-os` reference pattern.)

- [ ] **Step 3: Add standalone golden queries** (no LLM, no real Docker — both use stubs)

In `golden-replay.test.ts`:

```typescript
import { createDockerAdapter } from "@koi/sandbox-docker";
import { createSubprocessExecutor } from "@koi/sandbox-executor";

describe("Golden: @koi/sandbox-docker", () => {
  test("createDockerAdapter with stub client yields working exec", async () => {
    const stub = {
      createContainer: async () => ({
        id: "g1",
        exec: async () => ({ exitCode: 0, stdout: "golden", stderr: "" }),
        readFile: async () => new Uint8Array(),
        writeFile: async () => {},
        stop: async () => {},
        remove: async () => {},
      }),
    };
    const r = createDockerAdapter({ client: stub });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = await r.value.create({
      filesystem: { defaultReadAccess: "open" },
      network: { allow: false },
      resources: {},
    });
    const out = await inst.exec("true", []);
    expect(out.stdout).toBe("golden");
  });

  test("missing client returns SANDBOX_UNAVAILABLE", () => {
    const r = createDockerAdapter({});
    expect(r.ok).toBe(false);
  });
});

describe("Golden: @koi/sandbox-executor", () => {
  test("returns identity for input passthrough", async () => {
    const exec = createSubprocessExecutor();
    const code = `export default async (x) => x;`;
    const r = await exec.execute(code, { hello: "world" }, 5_000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.output).toEqual({ hello: "world" });
  });

  test("timeout returns SandboxError TIMEOUT", async () => {
    const exec = createSubprocessExecutor();
    const code = `export default async () => { while (true) {} };`;
    const r = await exec.execute(code, null, 250);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TIMEOUT");
  });
});
```

- [ ] **Step 4: Run runtime tests + check:orphans + check:golden-queries**

```bash
bun install
bun run check:orphans
bun run check:golden-queries
bun run test --filter=@koi/runtime
```

All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/runtime/package.json packages/meta/runtime/tsconfig.json packages/meta/runtime/src/__tests__/golden-replay.test.ts bun.lock
git commit -m "test(runtime): wire sandbox-docker + sandbox-executor with golden coverage (#1375)"
```

---

## Task 17: CI gate — run the full check suite

**Files:** none (verification only).

- [ ] **Step 1: Run full gate**

```bash
bun run typecheck
bun run lint
bun run check:layers
bun run check:unused
bun run check:duplicates
bun run test
```

All PASS. If any fail, STOP, root-cause, fix, re-run. Do not weaken tests or skip checks.

- [ ] **Step 2: Verify file/function size budgets**

```bash
find packages/sandbox/sandbox-docker/src packages/sandbox/sandbox-executor/src -name "*.ts" -not -name "*.test.ts" | xargs wc -l | sort -rn
```

Expected: every file ≤ 400 lines; `subprocess-executor.ts` ≤ 200; total source LOC ≤ ~500.

- [ ] **Step 3: Final commit (only if anything changed)**

If lint/typecheck required tweaks, commit them with a `chore` message; otherwise skip.

---

## Task 18: Open the PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/sandbox-docker-1375
```

- [ ] **Step 2: Open PR**

Title: `feat(sandbox): @koi/sandbox-docker + @koi/sandbox-executor (#1375)`

Body: Summary + test plan + reference to v1 archive + note that `findOrCreate` persistence is deferred.

---

## Self-Review

- **Spec coverage:** Issue lists Docker create/exec/cleanup, sandbox-executor command building / output capture / timeout, Docker image management, and 6 test scenarios. All covered: Tasks 9–11 (create/exec/cleanup, image config), Task 14 (executor capture+timeout), Tasks 5/11 (config + missing-Docker error), Task 8 (timeout classification).
- **Placeholder scan:** No TBDs. Each step shows code or exact commands.
- **Type consistency:** `SandboxAdapter`, `SandboxInstance`, `SandboxAdapterResult`, `SandboxExecutor`, `SandboxResult`, `SandboxError`, `KoiError`, `Result` all match `@koi/core` definitions read from `packages/kernel/core/src/sandbox-adapter.ts` and `sandbox-executor.ts`. Internal `DockerCreateOpts.memoryMb` chosen consistently (v1 used `memory`; switched to MB-typed name to match `SandboxProfile.resources.maxMemoryMb`).
- **Layer compliance:** Both packages depend only on `@koi/core`. No L0u utilities introduced (kept ≤ project minimalism rule). No vendor types in L0/L1.
- **Doc gate:** Tasks 1–2 land docs *before* tests/code per CLAUDE.md workflow.
- **Golden coverage:** Task 16 satisfies the L2-into-runtime + 2-per-package rule.
