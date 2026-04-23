# @koi/settings — Hierarchical Settings Cascade

Loads and merges up to 5 settings layers at agent startup. Separates operator/user preferences (permissions, hooks, env, theme) from the agent manifest (`koi.yaml`).

---

## Why It Exists

`koi.yaml` is the agent definition — checked into the project repo. Settings files are the operator/user preferences — per-machine or per-org, not checked in. Mixing them conflates "who the agent is" with "how my machine runs agents."

---

## Layer Precedence

| Priority | Layer | Default path | Notes |
|---------|-------|-------------|-------|
| 1 (lowest) | `user` | `~/.koi/settings.json` | Personal defaults |
| 2 | `project` | `<cwd>/.koi/settings.json` | Shared team defaults, checked in |
| 3 | `local` | `<cwd>/.koi/settings.local.json` | User overrides inside project, gitignored |
| 4 | `flag` | `--settings <path>` CLI flag | Ephemeral, per-invocation |
| 5 (highest) | `policy` | `/etc/koi/policy.json` (Linux) `/Library/Application Support/koi/policy.json` (macOS) | Admin-controlled, wins unconditionally |

Later layers override earlier ones. Policy also runs a post-merge enforcement pass.

---

## Merge Semantics

| Field type | Rule |
|-----------|------|
| Scalars (`theme`, `apiBaseUrl`, `defaultMode`, `enableAllProjectMcpServers`) | Last layer wins |
| Arrays (`allow`, `ask`, `deny`, `disabledMcpServers`, `additionalDirectories`) | Concatenate all layers, deduplicate |
| Objects (`env`, `hooks`) | Deep merge by key; last layer's value for a key wins |
| Policy | Post-merge pass: policy `deny` removes matching patterns from merged `allow`/`ask`; policy scalars override unconditionally |

Policy can only **tighten** (never loosen): a policy `deny` always wins, a policy `allow` does not override a lower layer's `deny`.

---

## Schema

```jsonc
{
  "$schema": "https://koi.dev/schemas/settings-v1.json",
  "permissions": {
    "defaultMode": "default",
    "allow": ["Read(*)", "Glob(*)"],
    "ask":   ["Bash(git push*)"],
    "deny":  ["Bash(rm -rf*)", "WebFetch(*)"],
    "additionalDirectories": ["/tmp/workspace"]
  },
  "env": {
    "KOI_LOG_LEVEL": "info"
  },
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "./.koi/hooks/audit.sh", "timeoutMs": 5000 }
    ]
  },
  "apiBaseUrl": "https://openrouter.ai/api/v1",
  "theme": "dark",
  "enableAllProjectMcpServers": false,
  "disabledMcpServers": ["risky-server"]
}
```

### Permission pattern format

`"ToolName(actionGlob)"` — matches the tool named `ToolName` when the action matches `actionGlob`.

| Pattern | Matches |
|---------|---------|
| `"Read(*)"` | `Read` tool, any action |
| `"Bash(git *)"` | `Bash` tool, any action starting with `git ` |
| `"Bash(rm -rf*)"` | `Bash` tool, action starting with `rm -rf` |
| `"WebFetch"` | `WebFetch` tool, any action (bare name = `*`) |
| `"*"` | Any tool, any action |

---

## Error Handling

| Layer | Parse failure |
|-------|--------------|
| user, project, local, flag | Layer skipped; error collected in `SettingsLoadResult.errors`; loading continues |
| policy | **Throws** — caller must catch and exit with code 2 |

Missing files are silently skipped (not an error).

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
