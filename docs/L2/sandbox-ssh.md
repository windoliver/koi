# @koi/sandbox-ssh — Remote-host SandboxAdapter via SSH

Implements `SandboxAdapter` against a remote host over SSH. Each `create(profile)`
call opens an SSH connection (or reuses one from the pool when called via
`findOrCreate(scope, profile)`); `instance.exec` runs the command remotely with
POSIX shell quoting; `readFile`/`writeFile` go over SFTP.

## Why it exists

Some workflows need to run tools on a remote machine — a CI runner, a GPU
workstation, a customer's bastion host. SSH is the universal transport for
exactly this case. Pairs with the local subprocess adapter (`@koi/sandbox-os`)
and the containerized adapter (`@koi/sandbox-docker`).

## Layer

```
L2  @koi/sandbox-ssh
    depends on: @koi/core (L0), ssh2 (npm)
    does NOT import: @koi/engine (L1), peer L2
```

`@koi/sandbox-ssh` is `optional: true` — callers who never configure
`profile.ssh` won't load it.

## Capabilities

```
supports: { exec, copy-files, persistence, network }
priority: 20
```

`spawn` and `filesystem-rw` are intentionally NOT declared:

- `spawn` — `instance.spawn` is not implemented (no interactive PTY in this PR;
  callers who need it should use `instance.exec` with a remote multiplexer).
- `filesystem-rw` — write authority depends on the SSH user's permissions on
  the remote host, not on the adapter. Declaring would lie about a guarantee
  that lives outside the adapter.

`persistence` IS declared because `findOrCreate(scope, profile)` reuses a
single SSH connection per scope key across calls.

## Public API

```typescript
import { createSshAdapter, defaultSshClientFactory } from "@koi/sandbox-ssh";

const adapter = createSshAdapter({ clientFactory: defaultSshClientFactory });

const profile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: true },
  resources: {},
  ssh: { host: "remote.example", user: "ci", keyPath: "/etc/koi/ci_id_ed25519" },
};

const instance = await adapter.create(profile);
const out = await instance.exec("ls", ["-la", "/tmp"]);
// out.stdout / out.stderr / out.exitCode / out.durationMs
await instance.destroy();
```

`profile.ssh` is REQUIRED for every `create()` call — profiles without it are
rejected with a typed `VALIDATION` error. The `clientFactory` is dependency-injected
so tests can supply a stub. The default factory wraps `ssh2.Client.connect`.

## Threat model

### Trust boundary

- Inside: code executed via `instance.exec(cmd, args)` — runs on the remote
  host as the SSH user, with whatever permissions that user has there.
- Outside: the SSH transport (network), the remote host's other processes and
  files, the local key file used for authentication.

### Privileged surfaces

- **Private key file.** `profile.ssh.keyPath` points to a private key the
  calling process must be able to read. Treat as a credential — protect file
  permissions (0600), rotate, audit access.
- **Remote user account.** Whatever the SSH user can do, sandboxed code can
  do. Use a least-privileged role (no sudo, no root login). Pair with a
  remote-side wrapper if you need finer-grained policy than the user account
  provides.
- **Network path.** SSH transport is encrypted but not censored — anything the
  remote host can reach, this adapter can reach.

### Escape vectors

- **Shell injection at the quoting boundary.** `composeCommandLine` quotes args
  via POSIX single-quoting; literal single quotes inside an arg are escaped via
  close-escape-reopen. Unit tests exercise injection vectors (`$(...)`, backticks,
  `;|&`). Mitigated as long as callers use `(cmd, args)` and never pre-format
  shell strings.
- **Host-key acceptance.** The default factory does not configure
  `hostHash`/`hostVerifier` — `ssh2` falls back to its built-in defaults. For
  production, callers should provide a custom factory with strict
  `~/.ssh/known_hosts` verification. Mitigated by: documenting this; future
  PRs may add explicit host-key pinning to the `SshTarget` shape.
- **Connection hijacking via key compromise.** A leaked key gives full SSH
  access. Mitigated by: per-environment keys, hardware-backed keys (yubikey),
  short-lived certificates. The adapter is agnostic.
- **Pool entry stale connection.** `findOrCreate` returns the same client
  across calls; if the underlying TCP connection drops, subsequent calls
  fail. Mitigated by: `instance.destroy` removes the pool entry on close;
  callers must catch and retry on transport-level errors.

### Mitigations

- Mandatory `profile.ssh` validation at `create()` — no implicit defaults.
- POSIX-correct argument quoting (single source of truth in `quote.ts`).
- Idempotent `destroy()` — calling twice is a no-op.
- Per-scope connection pool prevents fork-bombing the remote host with new
  connections per call.

### Residual risk

- Host-key trust is delegated to `ssh2`'s defaults; the adapter doesn't
  enforce strict pinning by default. Callers building security-sensitive
  flows should supply a custom `clientFactory`.
- The remote host is, by definition, outside the trust boundary of the adapter.
- Key rotation is a caller concern — adapter does not detect stale keys.

### Out-of-scope

- SSH agent forwarding (intentionally not configured; risk of agent hijack
  outweighs convenience).
- Password / keyboard-interactive auth (key auth only by design — no password
  field exists on `SandboxSshTarget`).
- Multiplexing (`ControlMaster`-style) — `findOrCreate` provides
  per-scope reuse, which is sufficient for current use cases.
