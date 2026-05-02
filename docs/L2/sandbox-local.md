# @koi/sandbox-os — OS-level Subprocess SandboxAdapter

OS-level isolation via macOS `sandbox-exec` (Seatbelt) or Linux `bwrap`
(Bubblewrap). Each call to `instance.exec(cmd, args)` spawns a child process
with profile-derived isolation flags applied; long-lived state lives on the
host filesystem (no container).

## Why it exists

For local-host workflows where Docker is overkill (no daemon, no image pull,
no per-call cold-start). Pairs with `@koi/sandbox-docker` (containerized) and
the future `@koi/sandbox-ssh` (remote).

## Layer

```
L2  @koi/sandbox-os
    depends on: @koi/core (L0)
    does NOT import: @koi/engine (L1), peer L2
```

`@koi/sandbox-os` is `optional: true` — `createOsAdapter()` returns a typed
`UNAVAILABLE` error when neither `sandbox-exec` (macOS) nor `bwrap` (Linux) is
on `PATH`.

## Capabilities

Declared on the returned adapter (read by `@koi/sandbox-router`):

```
supports: { exec, network, filesystem-rw }
priority: 0
```

`spawn`, `copy-files`, and `persistence` are intentionally NOT declared:

- `spawn` — `instance.spawn` is not implemented in this adapter (callers should
  use `instance.exec` and read the buffered result).
- `copy-files` — `instance.readFile`/`writeFile` throw "use `@koi/nexus-fuse-mount`
  for virtual FS." Direct host-FS reads/writes within profile-allowed paths are
  the responsibility of the caller's code, not the adapter.
- `persistence` — there is no per-instance state to detach/reattach; each `exec`
  is run-to-completion against the host filesystem.

## Public API

```typescript
import { createOsAdapter, type SandboxOsAdapter } from "@koi/sandbox-os";

const result = createOsAdapter();
if (!result.ok) {
  // result.error.code === "UNAVAILABLE" or platform-specific error
  return;
}
const adapter: SandboxOsAdapter = result.value;
// adapter.platform.platform === "seatbelt" | "bwrap"
// adapter.capabilities, adapter.version available for the router
```

`adapter.create(profile)` validates the profile against the detected platform
(seatbelt has different rules than bwrap) and returns a `SandboxInstance`.
`instance.exec(cmd, args, opts)` spawns a child with the seatbelt/bwrap prefix
applied; output is buffered up to `opts.maxOutputBytes` (default 1 MB).

## Threat model

### Trust boundary

- Inside: code executed via `instance.exec(cmd, args)` — runs as the calling
  user, inside a Seatbelt or bwrap profile that restricts filesystem and
  network access per `SandboxProfile`.
- Outside: anything not allowed by the profile — host PATH binaries not
  explicitly permitted, network destinations not allowed, filesystem paths
  outside `allowRead`/`allowWrite`.

### Privileged surfaces

- **Parent process.** The sandboxed child is a descendant of the calling Bun
  process; signals propagate up the process tree. A misuse of `process.kill`
  in the parent could affect siblings.
- **Profile policy authoring.** A profile that mistakenly grants `network.allow=true`
  or wide `allowWrite` paths weakens isolation. Profile validation runs at
  `create(profile)` time.
- **Environment variables.** `profile.env` overlays caller-supplied env onto the
  child process. Secrets in env are visible to the child.

### Escape vectors

- **Seatbelt allow-rule loopholes:** Seatbelt profiles can be fooled by
  symlink races or escaped path patterns. Mitigated by: profile generator
  uses canonical paths, no glob expansion at runtime.
- **bwrap setuid issues:** unprivileged bubblewrap on certain kernels (AppArmor
  user-namespace restriction) cannot create the namespace. Mitigated by:
  `isAppArmorUserNsRestricted()` detects the condition; `createOsAdapter()`
  returns `UNAVAILABLE` rather than silently falling back to no isolation.
- **Resource limits not enforced when systemd-run unavailable:** cgroup v2
  memory/pids enforcement requires `systemd-run --user`. When absent on Linux,
  resource limits are best-effort. Mitigated by: detection probe
  (`probeSystemdRunUser`) — when absent, callers must accept reduced enforcement.
- **Path-traversal in deny lists:** `denyRead`/`denyWrite` are checked by the
  underlying sandbox, not the adapter — mistakes in profile authorship leak.

### Mitigations

- Profile validation rejects malformed paths and conflicting allow/deny rules.
- Network defaults to `allow: false` and is enforced by the kernel-level
  sandbox.
- Output is bounded (`maxOutputBytes`) to prevent host memory exhaustion.
- `AbortSignal` integration kills the child process group (and the systemd
  scope, if used) on cancel.

### Residual risk

- A kernel-level vulnerability in Seatbelt/bwrap defeats this layer entirely.
- A caller that mounts the host FS via `allowWrite: ["/"]` has effectively
  disabled isolation. Adapter does not refuse such profiles — that is policy.
- `readFile`/`writeFile` not implemented: callers needing virtual FS must
  compose with `@koi/nexus-fuse-mount` or another L2 package.

### Out-of-scope

- Hardware side-channel attacks.
- Mitigations against parent-process compromise (the parent is trusted).
- Multi-user host isolation (single-user assumption — Seatbelt and unprivileged
  bwrap are user-scoped).
