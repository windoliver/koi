# Design: `koi gateway-up` First-Class CLI Command

## Summary

Promote the existing gateway-stack launcher from a repo-local script into a supported CLI command: `koi gateway-up`.

Today the restored gateway stack already exists and can be started through [`packages/net/gateway-stack/scripts/gateway-up.ts`](/Users/sophiawj/.codex/worktrees/8268/koi/packages/net/gateway-stack/scripts/gateway-up.ts), but that entrypoint is intentionally script-oriented and not part of the normal CLI surface. This leaves the restored stack technically present but not ergonomically reachable through the main `koi` command.

This design adds a first-class command that reuses the existing gateway-stack assembly and shutdown behavior, keeps the launcher loopback-first, and exposes the stack through the same CLI registry/help/arg-parsing system used by the rest of the repository.

## Goals

- Make the restored gateway stack reachable through `koi gateway-up`.
- Reuse the existing `@koi/gateway-stack` boot path rather than reimplementing gateway assembly in the CLI.
- Preserve current dev/test behavior: permissive local authenticator, loopback bind, sibling health endpoint, structured startup/stopping lines.
- Add the minimum CLI surface needed by open follow-up work, especially the `#2122` requirement for a first-class gateway launcher.
- Keep `koi serve` semantics unchanged.

## Non-Goals

- Do not redesign the gateway protocol for TUI or remote-runtime traffic.
- Do not fold this behavior into `koi serve`.
- Do not add production auth, multi-tenant routing, or cross-host exposure in this change.
- Do not reopen intentionally deferred gateway-core work such as node registry, scheduler dispatch, or heartbeat re-validation.

## Current State

The existing script:

- creates a `GatewayStack` with optional Nexus backing
- uses a loopback-only Bun transport (`127.0.0.1`)
- exposes a sibling `/health` HTTP server on `PORT + 1`
- prints machine-readable JSON on start and shutdown
- blocks forever until `SIGINT`/`SIGTERM`

The CLI architecture already has a consistent pattern:

- `KnownCommand` in [`packages/meta/cli/src/args/index.ts`](/Users/sophiawj/.codex/worktrees/8268/koi/packages/meta/cli/src/args/index.ts)
- lazy command registration in [`packages/meta/cli/src/registry.ts`](/Users/sophiawj/.codex/worktrees/8268/koi/packages/meta/cli/src/registry.ts)
- per-command help text in [`packages/meta/cli/src/help.ts`](/Users/sophiawj/.codex/worktrees/8268/koi/packages/meta/cli/src/help.ts)
- one command module per subcommand under [`packages/meta/cli/src/commands/`](/Users/sophiawj/.codex/worktrees/8268/koi/packages/meta/cli/src/commands)

That means `gateway-up` should be added as a real command in the same system, not hidden behind `serve` or implemented as a one-off script runner.

## Proposed Approach

### 1. Extract reusable launcher logic

Move the boot/shutdown logic out of the standalone script into a reusable gateway-stack helper with a small API surface.

The reusable layer should own:

- parsing validated launcher config values
- building the permissive local authenticator
- optional Nexus transport creation
- gateway-stack construction
- starting the gateway socket and sibling health server
- graceful shutdown on signal
- machine-readable lifecycle event payloads

The standalone script should become a thin wrapper around that helper so existing script-based workflows keep working.

### 2. Add a real CLI command

Introduce a new `gateway-up` command to the CLI registry.

The command should be wired into all normal CLI surfaces:

- command-name recognition
- per-command arg parsing
- help text
- lazy loader registration
- command module implementation

This is important because the repo has explicit tests and conventions around parser/help/registry consistency. Treating `gateway-up` as a first-class command keeps it compatible with those guardrails.

### 3. Keep behavior intentionally loopback-first

The first-class command should preserve the launcher’s current trust boundary:

- bind WebSocket listener to `127.0.0.1`
- bind health server to `127.0.0.1`
- keep the permissive dev authenticator
- document clearly that this is a local HA/test/runtime entrypoint, not a hardened public service

This matches the current script, avoids accidental internet exposure, and keeps the change tightly scoped to “reachable CLI entrypoint” rather than “production gateway mode.”

### 4. Support the minimal required flags

The command should support the options already called out by issue `#2122`:

- `--port <n>`
- `--nexus-url <url>`
- `--nexus-api-key <key>`
- `--instance-id <id>`
- `--log-format <text|json>` if needed to match existing CLI output norms
- `--help`

Defaults:

- port defaults to the script’s current default (`19500`)
- health port remains derived as `port + 1`
- instance id defaults to `gw-<pid>`
- Nexus is optional; absence means in-memory mode

Validation rules:

- `--nexus-url` requires `--nexus-api-key`
- port must be a valid integer in range
- invalid combinations should fail before binding sockets

## User-Facing Behavior

Example:

```bash
koi gateway-up --port 19500
```

Expected startup behavior:

- starts the gateway stack on loopback WS
- starts the health endpoint on loopback HTTP
- writes the same machine-readable “started” event shape the script uses today
- blocks until interrupted

Expected shutdown behavior:

- on `SIGINT` or `SIGTERM`, emit stopping event
- stop health server first
- stop gateway stack second
- emit stopped event
- exit `0` on clean shutdown

## Architecture

### CLI layer

The CLI command should remain thin.

Responsibilities:

- parse flags
- validate top-level CLI inputs
- call the reusable launcher
- map failures to human-readable CLI errors and exit codes

The CLI should not assemble raw gateway internals itself.

### Gateway-stack launcher layer

The reusable launcher helper should sit near `@koi/gateway-stack` because it is specific to that stack’s startup contract.

Responsibilities:

- build runtime dependencies for the local launcher
- manage health-server lifecycle
- expose one start/stop abstraction that both the CLI and the legacy script can call

This separation keeps the CLI from becoming the owner of gateway-stack boot semantics.

## Error Handling

Failures should be explicit and front-loaded.

Cases:

- invalid flags: fail before any server starts
- `nexus-url` without API key: fail with a clear message
- stack start failure: return non-zero and do not leave the health server running
- health-server bind failure after gateway bind: shut down the stack and return non-zero
- shutdown failure: emit an error and return non-zero

If partial startup occurs, teardown should be best-effort and deterministic.

## Testing Strategy

### Unit tests

- new args parser tests for `gateway-up`
- command-registry/help wiring tests
- launcher config validation tests
- launcher lifecycle tests using injected dependencies where possible

### Integration / smoke tests

- command starts successfully with default local config
- `/health` responds once the command is up
- `SIGTERM` or equivalent shutdown path stops cleanly
- Nexus mode validates `url + apiKey` combination and surfaces errors clearly

### Regression coverage

- existing `gateway-stack` health tests remain green
- existing script-based workflows still function via the thin wrapper
- no change to `koi serve` behavior

## Tradeoffs

### Why not fold this into `koi serve`

That would blur two distinct surfaces:

- `serve`: runtime-backed HTTP ingress for an agent service
- `gateway-up`: loopback gateway-stack launcher for WS/HA/client work

Keeping them separate avoids accidental scope expansion and matches the follow-up work described in `#2122`.

### Why not implement this only in the CLI

Copying script logic into the CLI would create a second source of truth for gateway-stack startup and shutdown. Extracting a reusable launcher keeps the script and CLI aligned.

## Acceptance Criteria

- `koi gateway-up` is recognized as a first-class CLI command.
- The command supports `--port`, `--nexus-url`, `--nexus-api-key`, and `--instance-id`.
- Startup reuses the current gateway-stack local-launcher behavior and remains loopback-only.
- The health endpoint is exposed through the same sibling HTTP server model as today.
- The existing standalone script delegates to the shared launcher instead of owning a forked implementation.
- CLI/help/registry/parser wiring tests are added or updated.
- Existing gateway-stack health tests continue to pass.

## Open Questions Resolved

### Should this be a `serve` mode?

No. Keep `gateway-up` separate from `serve` so we do not conflate webhook-oriented service hosting with the loopback gateway-stack client surface.

### Should this be production-hardened now?

No. This change intentionally preserves the current local/dev posture. Production gateway hardening belongs to the separate production-gateway work, not this follow-up.

## Implementation Notes For The Follow-On Plan

The implementation plan should specifically account for the repo’s CLI wiring invariants:

- parser
- `KnownCommand`
- lazy loader registry
- help text
- command module
- tests that ensure those stay in sync

That is the easiest place for a seemingly small CLI addition to break repo conventions, so the plan should treat it as first-class work rather than cleanup.
