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
supports: { exec, copy-files, network, filesystem-rw, persistence }
priority: 10
```

`spawn` is intentionally NOT declared — the instance has no `spawn()` (use
`exec()`). `persistence` IS declared whenever the underlying `DockerClient`
provides the `findContainers` / `inspectContainer` / `startContainer` triple.
The default CLI client supports all three; injected test clients may opt out
and the capability is dropped accordingly (capability honesty enforced by
`@koi/sandbox-conformance`).

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
  (`@sha256:...`) in production. Image refs are normalized with `trim()` and
  rejected when they begin with `-`, so manifest/programmatic config cannot
  smuggle Docker CLI flags through the image operand.
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
- The default Docker CLI client inserts `--` before the image ref in
  `docker create`; image refs that still look flag-shaped after trimming are
  rejected during config validation before any daemon probe.
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
  readonly scopeRegistry?: ScopeRegistry;  // default: per-scope file under XDG_STATE_HOME
}

export function createDockerAdapter(
  config: DockerAdapterConfig,
): Promise<Result<DockerSandboxAdapter, KoiError>>;
```

Custom `image` values are trimmed before use. Empty image strings and values
whose first non-whitespace character is `-` fail validation with a typed
`VALIDATION` error, including on the default-client path before Docker
availability detection runs.

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

## Cross-session persistence (`findOrCreate` / `destroyScope`)

When the underlying client supports `findContainers` + `inspectContainer` +
`startContainer`, the adapter exposes:

```typescript
findOrCreate(scope: string, profile: SandboxProfile): Promise<SandboxInstance>
destroyScope(scope: string): Promise<boolean>
```

`findOrCreate` reuses a previously created container for the same `scope`
across processes and sessions. `instance.detach()` (only present on persistent
instances) stops the container without removing it so a later
`findOrCreate(scope)` reattaches.

### Trust model

The Docker daemon is a shared trust boundary: any actor with daemon access can
create a container with `koi.sandbox.scope=<scope>` and matching
`koi.sandbox.profile-hash` labels — both deterministic from observable inputs.
To prevent label-driven hijacking, ownership is recorded in a private
`ScopeRegistry` (default: per-scope JSON files under
`${KOI_SANDBOX_DOCKER_STATE_DIR}` or
`${XDG_STATE_HOME}/koi-sandbox-docker/scopes/`). Reuse requires the daemon-side
container's id to match an id we ourselves recorded.

### Behavior matrix

| Pre-existing daemon-side container | Action |
|---|---|
| owned + running | reuse (no create/start) |
| owned + exited/stopped | `docker start <id>` and reuse |
| owned + dead/unknown | auto-remove, create fresh, free the deterministic `--name` |
| owned + drifted profile/image | fail closed; recovery via `destroyScope` |
| label match but NOT owned | fail closed pre-create — refuse to make a duplicate |
| missing | create fresh with deterministic `--name` + scope/profile-hash labels |

### Race & failure invariants

- Per-scope async serializer prevents in-process double-create.
- Deterministic container `--name` (`koi-sb-<slug>-<sha256-12>`) + name-conflict
  retry prevent cross-process double-create.
- `forgetIfMatches(scope, expectedId)` is an atomic CAS-by-id (per-(scope,id)
  filename) — a peer's freshly-recorded replacement is never erased by a
  stale cleanup.
- Transient `docker ps` / `inspect` / `image inspect` failures throw rather
  than silently returning empty/undefined — never silently lose ownership.
- Registry I/O errors propagate (only `ENOENT` is treated as absence).
- `destroyScope` is ownership-gated: only the recorded id is removed; foreign
  siblings surface as a typed VALIDATION error and trigger no mutations.
- Profile fingerprint covers `(image, resolveImageId(image), profile)` so a
  mutable tag (`my-image:latest`) repointed at new content invalidates reuse.

### `ScopeRegistry`

```typescript
export interface ScopeRegistry {
  readonly record: (scope: string, containerId: string) => Promise<void>;
  readonly lookup: (scope: string) => Promise<string | undefined>;
  readonly forget: (scope: string) => Promise<void>;
  readonly forgetIfMatches: (scope: string, expectedId: string) => Promise<boolean>;
}

export function createInMemoryScopeRegistry(): ScopeRegistry;  // tests
export function createFileScopeRegistry(opts?: { dir?: string }): ScopeRegistry;
export function defaultScopeRegistryDir(): string;
```

The file-backed registry uses a per-`(scope, containerId)` filename layout
(`<scopeHash>.<idHash>.scope`), so `forgetIfMatches` is an atomic unlink:
two different ids live at two different paths and a stale cleanup cannot
delete a peer's freshly-recorded entry.

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
`findOrCreate` / scope persistence is now implemented (#1375 follow-up to #2082)
with a private-registry trust model that v1 lacked.
