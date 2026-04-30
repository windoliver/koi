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
