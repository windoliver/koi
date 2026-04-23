# @koi/settings — Hierarchical Settings Cascade

Loads and merges up to 5 settings layers at agent startup. Separates operator/user preferences (permissions) from the agent manifest (`koi.yaml`).

---

## Why It Exists

`koi.yaml` is the agent definition — checked into the project repo. Settings files are the operator/user preferences — per-machine or per-org, not checked in. Mixing them conflates "who the agent is" with "how my machine runs agents."

---

## Layer Precedence

| Priority | Layer | Default path | Notes |
|---------|-------|-------------|-------|
| 1 (lowest) | `user` | `~/.koi/settings.json` | Personal defaults |
| 2 | `project` | `<project-root>/.koi/settings.json` | Shared team defaults, checked in |
| 3 | `local` | `<project-root>/.koi/settings.local.json` | User overrides inside project, gitignored |
| 4 | `flag` | `--settings <path>` CLI flag | Ephemeral, per-invocation |
| 5 (highest) | `policy` | `/etc/koi/policy.json` (Linux) `/Library/Application Support/koi/policy.json` (macOS) | Admin-controlled, wins unconditionally |

Later layers override earlier ones. Policy also runs a post-merge enforcement pass.

Project root is resolved by walking up from `cwd` to the nearest git root or `.koi/settings.json` file — so `koi` launched from a subdirectory still finds the repo-level settings.

---

## Merge Semantics

| Field type | Rule |
|-----------|------|
| Scalars (`defaultMode`) | Last layer wins |
| Arrays (`allow`, `ask`, `deny`) | Concatenate all layers, deduplicate |
| Policy | Post-merge pass: policy `deny` removes matching patterns from merged `allow`/`ask`; policy scalars override unconditionally |

Policy can only **tighten** (never loosen): a policy `deny` always wins, a policy `allow` does not override a lower layer's `deny`.

---

## Schema

Only the `permissions` field is currently enforced by the runtime. Other fields may be added in future releases when their enforcement paths are wired in.

```jsonc
{
  "$schema": "https://koi.dev/schemas/settings-v1.json",
  "permissions": {
    "defaultMode": "default",  // "default" | "auto"
    "allow": ["Read(*)", "Glob(*)"],
    "ask":   ["Bash(git push*)"],
    "deny":  ["Bash(rm -rf*)", "WebFetch(*)"]
  }
}
```

### `permissions.defaultMode`

| Value | Behavior |
|-------|---------|
| `"default"` | Rules evaluated; unmatched tool calls prompt for approval |
| `"auto"` | Rules evaluated; unmatched tool calls auto-approved |

### Permission pattern format

`"ToolName(actionGlob)"` — matches the tool named `ToolName` when the action matches `actionGlob`.

| Pattern | Matches |
|---------|---------|
| `"Read(*)"` | `Read` tool, any action |
| `"Bash(git *)"` | `Bash` tool, any action starting with `git ` |
| `"Bash(rm -rf*)"` | `Bash` tool, action starting with `rm -rf` |
| `"WebFetch"` | `WebFetch` tool, any action (bare name = `*`) |
| `"*"` | Any tool, any action |

Tool names must be plain identifiers (letters, digits, underscores starting with a letter). Bare glob metacharacters like `Read**` or `Bash:**` are rejected by the validator.

### Policy-layer strictness

Policy and explicit `--settings` files use strict validation: unknown keys (including unsupported permission sub-fields) produce a fatal error rather than being silently stripped. This prevents admins from believing a setting is active when it is ignored.

---

## Error Handling

| Layer | Parse/schema failure |
|-------|----------------------|
| `user`, `project`, `local` | Layer skipped; error collected in `SettingsLoadResult.errors`; loading continues |
| `flag` (explicit `--settings`) | **Throws** — operator specified a file that must load correctly |
| `policy` | **Throws** — caller must catch and exit with code 2 |

Empty files are treated as errors for `flag` and `policy` layers (fail-closed).
Missing files are silently skipped for all layers except `flag` (where ENOENT is fatal).

---

## API

```typescript
import { loadSettings } from "@koi/settings";

const { settings, errors, sources } = await loadSettings({
  cwd: process.cwd(),
  homeDir: os.homedir(),
  flagPath: argv.settings,    // --settings <path> (optional)
  layers: ["user", "project", "local", "flag", "policy"],  // default: all 5
});

if (errors.length > 0) {
  for (const err of errors) console.warn(`[settings] ${err.file}: ${err.message}`);
}
```

### Wiring with `@koi/permissions`

```typescript
import { loadSettings } from "@koi/settings";
import { mapSettingsToSourcedRules, createPermissionBackend } from "@koi/permissions";

const { settings, sources } = await loadSettings({ cwd, homeDir });
const layers = ["user", "project", "local", "flag", "policy"] as const;
const rules = layers.flatMap((layer) => {
  const layerSettings = sources[layer];
  return layerSettings != null
    ? mapSettingsToSourcedRules(layerSettings, layer)
    : [];
});
const backend = createPermissionBackend({ mode: "default", rules });
```

---

## `.gitignore` note

Always gitignore `settings.local.json` in project-level koi config:

```gitignore
.koi/settings.local.json
```
