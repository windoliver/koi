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

## Capabilities

Declared on the returned adapter (see `@koi/sandbox-router` for selection semantics):

```
supports: { exec, copy-files, network, filesystem-rw }
priority: 10
```

`spawn` and `persistence` are intentionally NOT declared — the instance has no
`spawn()` (use `exec()`) and the adapter has no `findOrCreate` (no cross-session
container reuse).

## Threat model

### Trust boundary

- Inside: code executed via `instance.exec(cmd, args)` — runs as the image's
  default user inside an isolated container with the configured network and
  filesystem policy applied.
- Outside: the host kernel, the Docker daemon socket (`/var/run/docker.sock` or
  configured path), all other host processes and files not bind-mounted in.

### Privileged surfaces

- **Docker daemon socket.** The default client connects to `dockerd` over a
  Unix socket. Anyone who can talk to that socket can run arbitrary containers
  on the host; treat it as root-equivalent. Limit access via Unix permissions.
- **Image trust.** The `image` field controls which container starts. Untrusted
  images can include backdoors or supply-chain implants. Pin to digests
  (`@sha256:...`) in production.
- **Bind mounts.** When the profile's `filesystem.allowRead`/`allowWrite` lists
  host paths, those become readable/writable from inside the container.

### Escape vectors

- **Daemon-socket abuse:** code that gains the daemon socket inside a container
  can spawn a privileged sibling container with the host filesystem mounted.
  Mitigated by: never bind-mount the daemon socket into a sandboxed container.
- **Kernel exploits:** containers share the host kernel; a kernel CVE can break
  isolation. Mitigated by: keep the host kernel patched; configure
  `--security-opt` profiles where available.
- **Resource exhaustion:** without `--memory`/`--pids-limit`, a busy container
  can starve the host. Mitigated by: `profile.resources` translates to
  container limits; defaults are conservative.
- **Filesystem leak:** bind-mounted paths grant read/write outside the
  container. Mitigated by: profile `denyRead`/`denyWrite` are honored when
  computing mount options; callers should declare the smallest path set needed.

### Mitigations

- Network defaults to `--network none` unless `profile.network.allow=true`.
- Resources are clamped to the profile's `maxMemoryMb` / `maxPids` when set.
- `instance.destroy()` removes the container; failures surface as typed errors.

### Residual risk

- Docker daemon socket compromise — out-of-scope for adapter; treat the daemon
  as a trust-boundary above the adapter.
- Kernel-level isolation gaps — adapter cannot defend against them.

### Out-of-scope

- Hardware side-channels (Spectre/Meltdown class).
- Image supply-chain integrity (use Sigstore/cosign at a higher layer).
- Multi-tenant host isolation (use a hypervisor-based sandbox for that tier).

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

## SandboxExecOptions support

| Option          | Status            | Notes                                                              |
|-----------------|-------------------|--------------------------------------------------------------------|
| `cwd`           | Supported         | Passed as `--workdir` to `docker exec`                            |
| `env`           | Supported         | Passed as `--env K=V` to `docker exec`                            |
| `stdin`         | Supported         | Piped to the spawned docker process                               |
| `timeoutMs`     | Supported         | Arms a kill timer; exitCode 124 sentinel maps to TIMEOUT          |
| `maxOutputBytes`| Supported         | Both stdout and stderr capped; `truncated` flag set on result     |
| `signal`        | Supported         | Pre-abort → immediate exitCode 130; mid-flight → race + return 130|
| `onStdout`      | Rejected (throws) | Docker backend buffers; use `result.stdout` instead               |
| `onStderr`      | Rejected (throws) | Docker backend buffers; use `result.stderr` instead               |

## v1 references

`archive/v1/packages/virt/sandbox-docker` — ported `types.ts`, `profile-to-opts.ts`,
`network.ts`, `instance.ts`, `validate.ts`, `classify.ts`, `default-client.ts`.
Dropped: `findOrCreate` / scope persistence (deferred).
