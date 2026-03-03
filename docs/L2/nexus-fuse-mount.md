# Nexus FUSE Mount — Virtual Filesystem for Cloud Sandboxes

Nexus FUSE mount enables agents running inside cloud sandboxes (E2B, Cloudflare, Daytona)
to access the Nexus server's virtual filesystem as a local POSIX directory. Files appear
at a configurable mount path via FUSE — the agent reads and writes them with normal
filesystem calls, but the data lives on the Nexus server.

---

## Why it exists

Cloud sandboxes are ephemeral and isolated by design. Without FUSE mounts, agents in
sandboxes have no persistent storage and no access to shared data. The typical workaround
is copying files in/out via `writeFile`/`readFile`, which:

- Requires knowing which files are needed upfront
- Breaks for large datasets that don't fit in sandbox memory
- Cannot stream — must load entire files before processing
- Requires explicit sync logic for writes

Nexus FUSE solves all of these by making the remote filesystem transparent:

```
┌─────────────────────────────────────────────────────────┐
│  Cloud Sandbox (E2B / Cloudflare / Daytona)             │
│                                                         │
│  Agent code:                                            │
│    cat /mnt/nexus/project/README.md      ← lazy read    │
│    echo "result" > /mnt/nexus/output.txt ← write-back   │
│    ls /mnt/nexus/datasets/               ← directory     │
│                                                         │
│  ┌───────────────────────────────────────┐              │
│  │  nexus-fuse daemon (FUSE userspace)   │              │
│  │  Translates VFS ops → Nexus HTTP API  │              │
│  └──────────────────┬────────────────────┘              │
└─────────────────────┼───────────────────────────────────┘
                      │ HTTPS
                      ▼
              ┌──────────────┐
              │ Nexus Server │
              │ (persistent) │
              └──────────────┘
```

---

## What it enables

### 1. Persistent agent workspace across sessions

An agent's workspace files survive sandbox destruction. Next session, same mount,
same files — no checkpoint/restore logic needed.

### 2. Shared data between agents

Multiple agents mount the same Nexus path → shared filesystem. One agent writes
analysis results, another reads them. No message passing or IPC required.

### 3. Large dataset access without copying

Agents process multi-GB datasets by reading files on demand through the mount.
Only accessed pages are fetched — no need to copy the entire dataset into the sandbox.

### 4. Nexus namespace integration

Connects directly to the [unified Nexus namespace](../../docs/L2/nexus-fuse-mount.md):

```
/mnt/nexus/agents/{agentId}/workspace/   ← agent-private files
/mnt/nexus/groups/{groupId}/scratch/     ← group-shared scratchpad
/mnt/nexus/global/bricks/               ← promoted brick artifacts
```

### 5. Zero-code filesystem tools

Forged tools that operate on files (grep, sed, jq, compilers) work unchanged —
they see a regular directory, not an API.

---

## Architecture

### Layer position

```
L0  @koi/core                 ─ NexusFuseMount type + SandboxProfile.nexusMounts
L0u @koi/sandbox-cloud-base   ─ mountNexusFuse() helper (exec-based)
L2  @koi/sandbox-{e2b,cloudflare,daytona} ─ wired into create()
```

No new packages. The mount helper lives in `@koi/sandbox-cloud-base` (L0u),
shared by all three cloud adapters.

### Mount sequence

For each `NexusFuseMount` entry in the profile:

```
  adapter.create(profile)
       │
       ▼
  SDK createSandbox() → live sandbox instance
       │
       ▼
  mountNexusFuse(instance, profile.nexusMounts)
       │
       ├── 1. exec("mkdir", ["-p", mountPath])      5s timeout
       │      Create mount point directory
       │
       ├── 2. exec("nexus-fuse", [                  30s timeout
       │        "mount", mountPath,
       │        "--url", nexusUrl,
       │        "--api-key", apiKey,
       │        "--agent-id", agentId?              optional
       │      ])
       │      Daemonizes and returns immediately
       │
       └── 3. exec("ls", [mountPath])                5s timeout
              Verify mount is accessible
              Throws on failure
```

All three steps must succeed. Failure at any step throws with a clear error
message identifying which mount and which step failed.

---

## Prerequisites

The `nexus-fuse` binary must be **pre-installed in the sandbox image**. It is not
installed at mount time.

| Provider | Template/Image | Binary path |
|----------|---------------|-------------|
| E2B | `nexus-fuse-rust` (`x950nusgelxxn16c5xxj`) | `/usr/local/bin/nexus-fuse` |
| Cloudflare | Custom image (TBD) | `/usr/local/bin/nexus-fuse` |
| Daytona | Custom image (TBD) | `/usr/local/bin/nexus-fuse` |

The binary source is at `~/nexus/nexus-fuse/` (Rust crate).

---

## Usage

### Profile-driven (declarative)

Add `nexusMounts` to the `SandboxProfile` passed to any cloud adapter:

```typescript
const profile: SandboxProfile = {
  tier: "sandbox",
  filesystem: { allowRead: ["/tmp", "/mnt/nexus"] },
  network: { allow: true, allowedHosts: ["nexus.example.com"] },
  resources: { maxMemoryMb: 512, timeoutMs: 60_000 },
  nexusMounts: [
    {
      nexusUrl: "https://nexus.example.com",
      apiKey: process.env.NEXUS_API_KEY!,
      mountPath: "/mnt/nexus",
      agentId: "agent-42",  // optional — scopes mount to agent namespace
    },
  ],
};

const instance = await adapter.create(profile);
// /mnt/nexus is now live inside the sandbox
```

### Multiple mounts

Mount different Nexus paths for different purposes:

```typescript
nexusMounts: [
  {
    nexusUrl: "https://nexus.example.com",
    apiKey: key,
    mountPath: "/mnt/workspace",
    agentId: "agent-42",
  },
  {
    nexusUrl: "https://nexus.example.com",
    apiKey: key,
    mountPath: "/mnt/shared",
    // no agentId — mounts global/group namespace
  },
],
```

### Helper function (direct use)

If you need to mount after creation (not via profile):

```typescript
import { mountNexusFuse } from "@koi/sandbox-cloud-base";

await mountNexusFuse(instance, [
  { nexusUrl: "https://nexus.example.com", apiKey: key, mountPath: "/mnt/data" },
]);
```

---

## API reference

### Types (L0)

```typescript
/** Nexus FUSE mount — mounts Nexus virtual filesystem inside a sandbox. */
interface NexusFuseMount {
  readonly nexusUrl: string;     // Nexus server URL
  readonly apiKey: string;       // Authentication key
  readonly mountPath: string;    // Absolute path inside sandbox
  readonly agentId?: string;     // Optional — scopes to agent namespace
}
```

Added to `SandboxProfile`:

```typescript
interface SandboxProfile {
  // ... existing fields ...
  readonly nexusMounts?: readonly NexusFuseMount[];
}
```

### Functions (L0u)

```typescript
/** Mount Nexus FUSE filesystems inside a sandbox instance. */
function mountNexusFuse(
  instance: SandboxInstance,
  mounts: readonly NexusFuseMount[],
): Promise<void>;
```

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MOUNT_TIMEOUT_MS` | `30_000` | Timeout for `nexus-fuse mount` command |
| `VERIFY_TIMEOUT_MS` | `5_000` | Timeout for `mkdir` and `ls` verification |

---

## Error handling

All errors throw with actionable messages:

| Error | Cause | Message pattern |
|-------|-------|-----------------|
| mkdir fails | Permission denied, disk full | `Failed to create mount point {path}: {stderr}` |
| nexus-fuse fails | Bad URL, auth failure, binary missing | `nexus-fuse mount failed for {path}: {stderr}` |
| Verification fails | Mount didn't attach, transport error | `Nexus FUSE mount verification failed for {path}: {stderr}` |

If any mount in the array fails, the error propagates immediately — no partial
mount state. The sandbox instance remains valid (destroy still works).

---

## Performance

- **Mount time**: ~1-2s per mount (mkdir + daemonize + verify)
- **Read latency**: First access per file incurs network round-trip to Nexus.
  Subsequent reads served from kernel page cache
- **Write latency**: Writes are buffered and flushed to Nexus asynchronously
  by the FUSE daemon
- **No impact on sandbox creation**: mounts happen post-creation, in parallel
  with agent initialization if needed

---

## Layer compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    NexusFuseMount (pure type), SandboxProfile.nexusMounts  │
    ✓ zero imports from other packages                      │
    ✓ no function bodies, no runtime code                   │
                                                            ▼
L0u @koi/sandbox-cloud-base ◀──────────────────────────────┘
    mountNexusFuse() — exec-based helper
    ✓ imports from @koi/core only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        @koi/sandbox-e2b  @koi/sandbox-cf  @koi/sandbox-daytona
        L2 adapters — import from L0 + L0u only
```

---

## Related

- [Sandbox Executor](./sandbox-executor.md) — trust-tiered code execution
- [Unified Nexus Namespace (#750)](https://github.com/windoliver/koi/issues/750) — per-agent path convention
- [@koi/nexus meta-package (#469)](https://github.com/windoliver/koi/issues/469) — L3 Nexus integrations bundle
- [E2B FUSE Bucket Mounts (#552)](https://github.com/windoliver/koi/issues/552) — S3/GCS/R2 mounts (different mechanism)
