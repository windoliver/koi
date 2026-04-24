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
    "defaultMode": "default",
    "allow": ["fs_read(*)", "Glob(*)"],
    "ask":   ["Bash(git push*)"],
    "deny":  ["Bash(rm -rf*)", "web_fetch(*)"]
  }
}
```

### `permissions.defaultMode`

| Value | Behavior |
|-------|---------|
| `"default"` | Rules evaluated; unmatched tool calls prompt for approval |

### Permission pattern format

`"toolId(actionGlob)"` — matches the tool with runtime ID `toolId` when the action matches `actionGlob`.

**Tool IDs must match the runtime tool identifier**, not a friendly display name. Common tool IDs:

| Tool ID | Description |
|---------|-------------|
| `fs_read` | Read files |
| `fs_write` | Write/create files |
| `fs_edit` | Edit existing files |
| `Bash` | Run shell commands |
| `Glob` | Glob file patterns |
| `Grep` | Search file contents |
| `web_fetch` | Fetch URLs |

| Pattern | Matches |
|---------|---------|
| `"fs_read(*)"` | `fs_read` tool, any path |
| `"Bash(git *)"` | `Bash` tool, any command starting with `git ` |
| `"Bash(rm -rf*)"` | `Bash` tool, command starting with `rm -rf` |
| `"web_fetch"` | `web_fetch` tool, any URL (bare name = `*`) |
| `"*"` | Any tool, any action |

Tool IDs must be plain identifiers (letters, digits, underscores starting with a letter). Bare glob metacharacters like `fs_read**` or `Bash:**` are rejected by the validator.

#### TUI mode limitation: command-scoped `allow` rules

In TUI mode (`koi tui`), the backend receives only plain tool IDs — not enriched `"Bash:git push"` resource keys. As a result:

- Command-scoped `deny`/`ask` rules (e.g. `"Bash(rm -rf*)"`) are **widened to tool-level** (the whole tool is blocked/gated) — fail-closed.
- Command-scoped `allow` rules (e.g. `"Bash(git log*)"`) are **stripped entirely** — widening a specific allow to the whole tool would over-permit.

A warning is logged at startup when any command-scoped rules are encountered in TUI mode. Use `koi start` (marker-aware backend) for precise command-scoped enforcement.

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
