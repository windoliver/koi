# @koi/sandbox-os — OS-level sandbox executor contract

Profile types, platform detection, profile validation, and the executor contract that
maps abstract `SandboxProfile` inputs to platform-specific backend config (macOS
seatbelt / Linux bubblewrap). Error normalization included.

---

## Why it exists

Tools run by agents can be destructive: they can read credentials, exfiltrate data, or
modify the host filesystem. OS-level sandboxing enforces isolation at the kernel boundary
before a tool process is allowed to run. This package is the **contract layer** — it
defines what isolation looks like, how to request it, and how to translate the abstract
request into a platform command. The platform backends (seatbelt, bwrap) are implemented
here; cloud backends (Docker, E2B, Vercel) are separate L2 packages that implement the
same `SandboxAdapter` interface from `@koi/core`.

---

## Layer

```
L2  @koi/sandbox-os
    depends on: @koi/core (L0), @koi/errors (L0u), @koi/validation (L0u)
    does NOT import: @koi/engine (L1), any peer L2
```

---

## Architecture

### Internal module map

```
src/
  index.ts                    public re-exports
  detect.ts                   detectPlatform(), checkAvailability() — 3-stage detection
  profiles.ts                 preset constructors + SENSITIVE_CREDENTIAL_PATHS
  validate.ts                 validateProfile() — absolute paths, model compatibility
  normalize.ts                normalizeResult() — AdapterResult → SandboxError
  platform/
    seatbelt.ts               generateSeatbeltProfile(), buildSeatbeltPrefix()
    bwrap.ts                  buildBwrapPrefix(), buildBwrapSuffix()
  adapter.ts                  createOsAdapter() — factory; exports SandboxOsAdapter
```

All platform-specific code is pure (no side effects). Only `adapter.ts` and `detect.ts`
perform I/O. Tests inject `PlatformInfo` via `createOsAdapterForTest()` to avoid
requiring real binaries.

---

## Public API

### Types

```typescript
/** The two supported OS sandbox backends. */
export type SandboxPlatform = "seatbelt" | "bwrap";

/** Result of checking whether the sandbox backend is available. */
export interface PlatformInfo {
  readonly platform: SandboxPlatform;
  readonly available: boolean;
  /** Why the backend is unavailable, if applicable. */
  readonly reason?: string;
}

/**
 * SandboxAdapter extension with an exposed platform field.
 * Returned by createOsAdapter(); the platform is computed once at factory time.
 */
export interface SandboxOsAdapter extends SandboxAdapter {
  readonly platform: PlatformInfo;
}
```

### `createOsAdapter(): Result<SandboxOsAdapter, KoiError>`

Main entry point. Calls `checkAvailability()` once at construction, stores `PlatformInfo`
on the returned adapter. Returns a typed error if the platform is unsupported or the
binary is missing.

```typescript
const result = createOsAdapter();
if (!result.ok) {
  // result.error.code === "VALIDATION" — unsupported platform, missing binary, etc.
  return result;
}
const adapter = result.value;
// adapter.platform.platform === "seatbelt" | "bwrap"
// adapter.platform.available === true (guaranteed — factory fails fast if not)
```

### `detectPlatform(): Result<SandboxPlatform, KoiError>`

Pure OS detection (no filesystem I/O). Three-stage:

1. **OS check** — `process.platform`:
   - `"darwin"` → `"seatbelt"`
   - `"linux"` → proceed to WSL check
   - other → `{ ok: false, error: { code: "VALIDATION", message: "Unsupported platform: ..." } }`

2. **WSL check** (Linux only) — reads `/proc/version`:
   - WSL1 (contains `"Microsoft"`) → typed error: "WSL1 not supported — bwrap requires kernel namespaces. Use WSL2."
   - WSL2 → `"bwrap"`
   - native Linux → `"bwrap"`

3. **Architecture check** (Linux only):
   - `ia32` / `x86` 32-bit → typed error: "32-bit x86 not supported — seccomp socketcall bypass risk."
   - `x64`, `arm64` → proceed

### `checkAvailability(): Result<PlatformInfo, KoiError>`

Calls `detectPlatform()`, then `Bun.which(binary)` to confirm the binary is in PATH.
Returns `{ ok: true, value: { platform, available: false, reason } }` when the binary
is missing (not an error — callers can decide to fail-open or fail-closed). Returns
`{ ok: false }` only for unsupported-platform / architecture errors.

### Profile presets

```typescript
/** Preset constructors. All paths are absolute; '~/' prefix is expanded at call time. */
export function restrictiveProfile(
  overrides?: Partial<SandboxProfile> & { readonly extraDenyRead?: readonly string[] }
): SandboxProfile;

export function permissiveProfile(
  overrides?: Partial<SandboxProfile>
): SandboxProfile;

/**
 * Exported for auditing and extension. This list is the security boundary for
 * restrictiveProfile() — PRs that remove entries require security review.
 */
export const SENSITIVE_CREDENTIAL_PATHS: readonly string[];
```

### `validateProfile(profile: SandboxProfile, platform: SandboxPlatform): Result<SandboxProfile, KoiError>`

Validates the profile before any platform-specific code runs. Returns typed errors for:

- **Relative paths**: any entry in `allowRead`, `denyRead`, `allowWrite`, `denyWrite`
  that does not start with `/` or `~/`. Reject with `code: "VALIDATION"`.
- **Model compatibility**: `defaultReadAccess: "closed"` on `"seatbelt"` is rejected —
  macOS dyld requires broad read access (deny-default for reads breaks system frameworks).
- **Empty required fields**: `defaultReadAccess` is required (no default).

### `normalizeResult(result: SandboxAdapterResult): Result<SandboxAdapterResult, SandboxError>`

Maps a completed `SandboxAdapterResult` to a semantic `SandboxError` using this priority
order (first match wins):

| Condition | Code | Notes |
|-----------|------|-------|
| `result.timedOut === true` | `TIMEOUT` | Takes priority over non-zero exit code |
| `result.oomKilled === true` | `OOM` | Takes priority over non-zero exit code |
| `result.exitCode === 126` | `PERMISSION` | Shell: permission denied |
| `result.exitCode === 127` | `PERMISSION` | Shell: command not found |
| `result.exitCode !== 0` | `CRASH` | All other non-zero exits |
| `result.exitCode === 0` | _(success)_ | Returns `{ ok: true, value: result }` |

`durationMs` is always preserved from the input in the returned `SandboxError`.

---

## `FilesystemPolicy` design

```typescript
interface FilesystemPolicy {
  /**
   * Whether filesystem reads are open (allow-all + denylist) or closed
   * (deny-all + allowlist) by default.
   *
   * 'open' — reads permitted everywhere; denyRead blocks specific subtrees.
   *           Required on macOS (seatbelt) because dyld and system frameworks
   *           need broad read access that cannot be enumerated at profile time.
   * 'closed' — reads denied everywhere; allowRead explicitly permits subtrees.
   *            Supported on Linux (bwrap) only. Attempting 'closed' on macOS
   *            returns a VALIDATION error from validateProfile().
   */
  readonly defaultReadAccess: "open" | "closed";
  readonly allowRead?: readonly string[];    // paths to mount read-only (bwrap)
  readonly denyRead?: readonly string[];     // paths to mask / block (seatbelt + bwrap)
  readonly allowWrite?: readonly string[];   // paths to mount read-write (both)
  readonly denyWrite?: readonly string[];    // paths to mask / demote to read-only
}
```

**All paths must be absolute** (`/absolute/path` or `~/expanded/path`). Relative paths
are rejected by `validateProfile()`. The `~/` prefix is expanded to `$HOME` at
profile-construction time by the preset constructors; callers who build profiles manually
must expand `~` themselves.

### `NetworkPolicy` design

```typescript
interface NetworkPolicy {
  /** Binary on/off — the only guarantee OS backends can make. */
  readonly allow: boolean;
  // allowedHosts is intentionally absent from the OS contract.
  // Host filtering requires a proxy layer (cloud backends only).
  // See @koi/sandbox-docker for per-host network policy.
}
```

---

## Profile presets (defaults)

### `restrictiveProfile()` defaults

```
filesystem:
  defaultReadAccess: "open"
  denyRead: SENSITIVE_CREDENTIAL_PATHS (see below)
  allowWrite: ["/tmp/koi-sandbox-*"]
network:
  allow: false
resources:
  maxMemoryMb: 512
  timeoutMs: 30_000
  maxPids: 64
  maxOpenFiles: 256
```

### `permissiveProfile()` defaults

```
filesystem:
  defaultReadAccess: "open"
  denyRead: ~/.ssh, ~/.gnupg  (identity keys only)
  allowWrite: ["/tmp", "/var/tmp"]
network:
  allow: true
resources:
  maxMemoryMb: 2048
  timeoutMs: 120_000
  maxPids: 256
  maxOpenFiles: 1024
```

### `SENSITIVE_CREDENTIAL_PATHS`

```typescript
export const SENSITIVE_CREDENTIAL_PATHS: readonly string[] = [
  // Identity & signing keys
  "~/.ssh",
  "~/.gnupg",
  // Cloud providers
  "~/.aws",
  "~/.config/gcloud",
  "~/.azure",
  "~/.kube/config",
  // Package registries
  "~/.npmrc",
  "~/.pypirc",
  "~/.netrc",
  // Containers & secret managers
  "~/.docker/config.json",
  "~/.config/op",           // 1Password CLI
  "~/.config/1password",
  "~/.local/share/keyrings",  // GNOME Keyring
] as const;
```

---

## Platform backends

### macOS — Seatbelt (`sandbox-exec`)

**Strategy**: deny-default overall, but `(allow file-read-data)` + `(allow file-read-metadata)`
for the broad-read requirement. Sensitive read paths are blocked with `(deny file-read*)`.
Writes use an explicit allowlist.

**Profile pre-computation**: `generateSeatbeltProfile(profile)` is called once at
`adapter.create(profile)` time and the resulting `.sb` string is stored on the instance.
Every `exec()` call reuses the pre-computed string.

**Network**: binary on/off only via `(allow network*)` / `(deny network*)`. `allowedHosts`
is not expressible in Seatbelt without IP address resolution at profile time (fragile).

**Resource limits**: Seatbelt has no resource enforcement. `maxMemoryMb`, `maxPids`, and
`maxOpenFiles` are accepted in the profile but not enforced on macOS. The middleware layer
(`@koi/middleware-sandbox`) enforces timeouts via `AbortSignal`; memory/pid limits require
a cloud backend.

### Linux — bubblewrap (`bwrap`)

**Strategy**: `--unshare-all` for full namespace isolation. `allowRead` paths are
`--ro-bind` mounts. `denyRead` paths are `--tmpfs` overlays (empty fs masking the real
path).

**Ordering invariant**: deny mounts (`--tmpfs`) MUST appear AFTER their parent allow
mounts (`--ro-bind`). Reversing this order causes bwrap to bind-mount the real directory
over the tmpfs, making the masking ineffective. The internal argument builder enforces
this order; tests assert it explicitly.

**Argument pre-computation**: `buildBwrapPrefix(profile)` computes the profile-constant
portion of the args array once at `create(profile)` time. `buildBwrapSuffix(profile,
command, args)` computes the per-exec command portion at each `exec()` call. The final
args are `[...prefix, ...suffix]`.

**Resource limits**: enforced via `ulimit` wrapper inside the namespace when any of
`maxOpenFiles` or `maxPids` is set. When any resource limit is present, the command is
always wrapped as `sh -c "ulimit ... && exec cmd args"` (the `exec` replaces `sh`,
preserving signal delivery semantics). Memory limits are not enforceable via ulimit on
modern Linux without cgroup v2 access; `maxMemoryMb` is accepted but not enforced.

**Network**: `--unshare-net` for full network namespace isolation. Per-host filtering
requires `iptables` inside the namespace (needs root) — not supported. Use cloud backends.

---

## Error handling

| Error surface | Type | Code |
|---------------|------|------|
| Unsupported platform (Windows, WSL1, ia32) | `KoiError` | `"VALIDATION"` |
| Binary not found in PATH | `PlatformInfo.available = false` | _(not an error — caller decides)_ |
| Invalid profile (relative path, model mismatch) | `KoiError` | `"VALIDATION"` |
| Process timed out | `SandboxError` | `"TIMEOUT"` |
| Process OOM-killed | `SandboxError` | `"OOM"` |
| Permission denied (exit 126/127) | `SandboxError` | `"PERMISSION"` |
| Non-zero exit (other) | `SandboxError` | `"CRASH"` |
| Unexpected adapter failure | thrown `Error` with `cause` | _(infra bug — not expected)_ |

`KoiError` is used for infrastructure-level failures (platform detection, profile
validation). `SandboxError` (from `@koi/core` `sandbox-executor.ts`) is used for
execution-level outcomes from `normalizeResult()`.

---

## Output limits

`SandboxExecOptions.maxOutputBytes` defaults to **1 MB** (`1_048_576`). This aligns with
the `@koi/middleware-sandbox` default. Set higher explicitly if a tool produces larger
output. When exceeded: output is truncated, `SandboxAdapterResult.truncated = true`.

---

## Security invariants

These are non-negotiable; any PR that weakens them must have an explicit security review:

1. **Fail closed**: `createOsAdapter()` returns `{ ok: false }` — never silently falls
   back to no-sandbox. Callers that want no-sandbox must pass an explicit passthrough
   profile to a `noop` adapter.

2. **`ia32` rejected**: 32-bit x86 processes are explicitly rejected at platform detection
   because the `socketcall()` multiplexer syscall cannot be reliably blocked by seccomp.

3. **WSL1 rejected**: WSL1 lacks kernel namespaces; bwrap cannot provide isolation.

4. **Deny mounts after allow mounts** (bwrap): `--tmpfs` overlays must always follow
   their parent `--ro-bind` in the args array. Tests assert this ordering.

5. **No TOCTOU-safe path traversal in pure Bun**: `readFile`/`writeFile` on
   `SandboxInstance` operate on host paths using standard `Bun.file()` which does not
   use `O_NOFOLLOW`. This means symlink attacks (e.g., via `RENAME_EXCHANGE`) can bypass
   host-side path validation. Defense-in-depth: all path access uses the OS sandbox
   policy as the actual enforcement boundary; host-side validation is best-effort only.

6. **`SENSITIVE_CREDENTIAL_PATHS` is the security boundary for `restrictiveProfile()`**:
   entries in this list protect high-value credential stores. Removals require security
   review. Callers may add to the list via `extraDenyRead` but not remove from it.

---

## Testing

### Platform guard pattern

```typescript
describe("platform detection", () => {
  // Runs on every platform — asserts the correct Result variant
  test("returns seatbelt on macOS, bwrap on linux, error on other", ...);
});

describe.skipIf(process.platform !== "darwin")("seatbelt profile generation", () => {
  // macOS-only tests: generateSeatbeltProfile, buildSeatbeltPrefix
});

describe.skipIf(process.platform !== "linux")("bwrap args construction", () => {
  // Linux-only tests: buildBwrapPrefix, buildBwrapSuffix, deny-mask ordering
});
```

Platform-agnostic tests (profile validation, `normalizeResult`, preset constructors,
`mergeProfile`, `SENSITIVE_CREDENTIAL_PATHS`) run on all platforms.

### Required test cases

| Area | Tests |
|------|-------|
| `detectPlatform` | macOS → seatbelt; Linux → bwrap; Windows → error; WSL1 → error; ia32 → error |
| `checkAvailability` | binary found → `available: true`; binary missing → `available: false` with reason |
| `validateProfile` | relative path rejected; `~/` accepted; absolute accepted; `closed` on seatbelt → error; `closed` on bwrap → valid; `open` on bwrap → valid |
| `normalizeResult` | 6 branch tests + 2 priority tests (timedOut+nonzero → TIMEOUT, oomKilled+nonzero → OOM) |
| `restrictiveProfile` | SENSITIVE_CREDENTIAL_PATHS all appear in denyRead; extraDenyRead appended |
| `mergeProfile` | partial filesystem override preserves unset base fields; full override replaces; env merges correctly |
| bwrap deny ordering | `--tmpfs /home/.ssh` index > `--ro-bind /home /home` index in generated args |
| bwrap resource limits | maxPids set without maxOpenFiles still applies ulimit via sh wrapper |
| platform × model compat | 4 combinations (open/closed × seatbelt/bwrap) tested via injected PlatformInfo |

### Test injection pattern

`createOsAdapterForTest(platformInfo: PlatformInfo): SandboxOsAdapter` skips
`checkAvailability()` and builds the adapter with the supplied `PlatformInfo`. Used
by all compatibility and validation tests — no real binaries required.

---

## `mergeProfile` behavior

`mergeProfile(base, overrides?)` deep-merges nested policy objects:

```typescript
{
  filesystem: { ...base.filesystem, ...overrides.filesystem },
  network:    { ...base.network,    ...overrides.network },
  resources:  { ...base.resources,  ...overrides.resources },
  env: overrides.env ?? base.env,   // whole-object replacement (env is flat)
}
```

This allows partial nested overrides: passing `{ filesystem: { allowWrite: ["/workspace"] } }`
adds the write path while preserving all other base filesystem fields.

---

## Layer compliance

```
L2 @koi/sandbox-os
    imports: @koi/core (L0), @koi/errors (L0u), @koi/validation (L0u)
    does NOT import: @koi/engine (L1), any peer L2 package
```

No cloud platform types, no LangGraph, no engine-specific concepts.

---

## v1 reference

- `archive/v1/packages/virt/sandbox/src/detect.ts` — platform detection (ported, extended with WSL + arch checks)
- `archive/v1/packages/virt/sandbox/src/profiles.ts` — preset constructors (ported, `mergeProfile` fixed to deep-merge)
- `archive/v1/packages/virt/sandbox/src/platform/seatbelt.ts` — seatbelt profile generation (ported, pre-computed at `create()`)
- `archive/v1/packages/virt/sandbox/src/platform/bwrap.ts` — bwrap arg construction (ported, split into prefix/suffix)
- `archive/v1/packages/middleware/middleware-sandbox/src/config.ts` — output limit default (aligned to 1 MB)

---

## Tracking

- Issue: #1336 (v2 Phase 2f-1)
- Platform backends follow in the next sub-issue (#1337 or similar)
- Cloud backends: `@koi/sandbox-docker`, `@koi/sandbox-e2b`, etc. (separate issues)
