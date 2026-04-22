# Headless Mode

Headless mode (`koi start --headless`) runs an agent as a non-interactive one-shot process. It is designed for CI/CD pipelines, GitHub Actions, cron jobs, and any automation where a human is not watching the terminal.

All agent output is emitted as newline-delimited JSON (NDJSON) on **stdout**. Diagnostics go to **stderr**. The process exits with a structured exit code in the range 0–6 (exit 6 is used only when `--result-schema` is supplied and validation fails).

## Quick Start

```bash
koi start --headless \
  --prompt "List the 3 most recent open GitHub issues as JSON" \
  --allow-tool web_fetch \
  --max-turns 10 \
  --max-duration-ms 60000
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--headless` | boolean | false | Enable headless mode. Requires `--prompt`. |
| `--prompt` / `-p` | string | — | The prompt to send to the agent. Required in headless mode. |
| `--allow-tool` | string (repeatable) | [] | Exact tool ID to auto-allow. All other tool requests are denied. |
| `--max-duration-ms` | integer | none | Hard wall-clock timeout in milliseconds. Covers bootstrap + run + teardown. |
| `--max-turns` | integer | 25 | Maximum number of agent turns before stopping with exit 3. |
| `--max-spend` | number | none | Maximum spend in USD before stopping with exit 3. |
| `--result-schema` | string | none | Path to a Koi schema file (subset of JSON Schema). Checks required fields and type constraints in agent output. Does NOT enforce exact shape — extra fields are not rejected. Exit 6 on failure. |
| `--manifest` | string | none | Path to an agent manifest YAML file. |
| `--verbose` / `-v` | boolean | false | Emit additional diagnostic lines to stderr. |

### `--allow-tool` whitelist

In headless mode, **all tool requests are denied by default**. Pass `--allow-tool <toolId>` (repeatable) to selectively allow tools. Tool IDs are exact names: `fs_read`, `web_fetch`, `Bash`, `Glob`, `Grep`, etc.

```bash
# Allow filesystem reads and web fetches, deny everything else
koi start --headless --prompt "..." \
  --allow-tool fs_read \
  --allow-tool web_fetch
```

Wildcards are not supported — each `--allow-tool` value must be an exact tool ID.

### Security defaults

The following are **off by default** in headless mode and require environment variable opt-in:

| Feature | Env var to enable |
|---------|------------------|
| MCP server connections | `KOI_HEADLESS_ALLOW_MCP=1` |
| Manifest-declared plugins (user-installed plugin autoload remains disabled) | `KOI_HEADLESS_ALLOW_PLUGINS=1` |
| Manifest-declared middleware | `KOI_HEADLESS_ALLOW_MIDDLEWARE=1` |
| User hook scripts | `KOI_HEADLESS_ALLOW_HOOKS=1` |
| Session transcript persistence | `KOI_HEADLESS_PERSIST_TRANSCRIPT=1` |

These are fail-closed by default because they represent bootstrap-time execution surfaces that run before `--allow-tool` can mediate anything.

## Exit Codes

| Code | Name | Meaning | Retry? |
|------|------|---------|--------|
| 0 | SUCCESS | Agent completed the task | — |
| 1 | AGENT_FAILURE | Agent could not complete the task. | Retry only if all allowed tools are idempotent. |
| 2 | PERMISSION_DENIED | A required tool was denied by the permission policy | No — add `--allow-tool` |
| 3 | BUDGET_EXCEEDED | `--max-turns` or `--max-spend` was hit | Maybe — raise limits |
| 4 | TIMEOUT | `--max-duration-ms` was exceeded | Only when all allowed tools are read-only and idempotent. A timeout does not guarantee no side effects occurred before the cut-off. Do NOT auto-retry if `Bash`, file-write, external API, or any MCP tool is allowed — retrying can duplicate deploys, mutations, or external actions. |
| 5 | INTERNAL | Runtime assembly failed, schema file was invalid, or teardown failed | Check stderr |
| 6 | SCHEMA_VALIDATION | Agent output did not match `--result-schema`, or schema validation was skipped because `--max-duration-ms` was exhausted during teardown or validation. Agent completed all tool calls before this check. | Do NOT retry — the agent finished its work and side effects already ran. If `validationFailed: true` — fix the prompt or schema. If `validationSkipped: true` — raise `--max-duration-ms` to allow teardown + validation. |

## NDJSON Event Reference

Each line on stdout is a JSON object with a `sessionId` field and a `kind` field.

### `session_start`

Emitted once at the start of the run.

```json
{"kind":"session_start","sessionId":"ses_abc123","startedAt":"2026-04-21T10:00:00.000Z"}
```

### `assistant_text`

Emitted for each chunk of text the agent produces.

```json
{"kind":"assistant_text","sessionId":"ses_abc123","text":"Here is the summary: ..."}
```

### `tool_call`

Emitted when the agent calls a tool. Args are summarized (type + size) — raw values are not logged to protect CI secrets.

```json
{"kind":"tool_call","sessionId":"ses_abc123","toolName":"web_fetch","args":{"type":"object","size":1}}
```

### `tool_result`

Emitted when a tool returns.

```json
{"kind":"tool_result","sessionId":"ses_abc123","toolName":"web_fetch","ok":true,"result":{"type":"string","size":4821}}
```

### `result`

The final event. Always the last line on stdout.

```json
{"kind":"result","sessionId":"ses_abc123","ok":true,"exitCode":0}
```

On failure:

```json
{"kind":"result","sessionId":"ses_abc123","ok":false,"exitCode":1,"error":"agent could not complete the task"}
```

On schema validation failure (exit 6 — output did not match schema):

```json
{"kind":"result","sessionId":"ses_abc123","ok":false,"exitCode":6,"validationFailed":true,"error":"schema validation failed: count is required"}
```

On schema validation skipped (exit 6 — budget exhausted before validation ran):

```json
{"kind":"result","sessionId":"ses_abc123","ok":false,"exitCode":6,"validationSkipped":true,"error":"schema validation skipped: max-duration-ms exhausted before validation could start"}
```

## Result Schema Validation

`--result-schema` validates the agent's **final text segment** against a JSON Schema subset before reporting success. For tool-using agents, "final text segment" means the text produced after the last tool result — intermediate narration before tool calls is discarded. For agents that use no tools, the entire output is validated. Either way, the agent must produce only JSON in the final segment: no prose, preamble, or trailing narration.

> **Stdout note:** When `--result-schema` is active, streaming `assistant_text` events are suppressed during the run. On successful validation (exit 0), exactly **one** `assistant_text` event is emitted containing the raw validated payload — the exact bytes the schema checked, free of any log-redaction transforms. On any other exit — schema failure (exit 6), agent failure (exit 1), permission denied (exit 2), timeout (exit 4), or internal error (exit 5) — no `assistant_text` events appear on stdout. `tool_call` and `tool_result` events are always emitted in real-time regardless of validation outcome. CI scripts must use the `result` event's `exitCode` and `validationFailed` fields — not concatenate `assistant_text` chunks — to determine success.

> **Scope limitation:** `additionalProperties` is not supported. Extra fields beyond those declared in `properties` are not rejected. If exact-shape enforcement is required, validate the output independently using external tooling.

### Supported keywords

| Keyword | Notes |
|---------|-------|
| `type` | `"object"`, `"array"`, `"string"`, `"number"`, `"integer"` (whole numbers only), `"boolean"`, `"null"` |
| `required` | Array of required property names |
| `properties` | Recursive sub-schemas per property |
| `items` | Recursive sub-schema for array elements |
| `enum` | Array of scalar values (no objects or arrays in enum) |

Annotation keywords (`$schema`, `title`, `description`, `$comment`) are accepted and ignored.

Any other keyword (e.g. `$ref`, `anyOf`, `pattern`, `additionalProperties`) causes exit 5 at startup — the schema is rejected before the agent runs.

### Example

Create `.koi/pr-summary-schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PR Summary",
  "type": "object",
  "required": ["count", "titles"],
  "properties": {
    "count": { "type": "number" },
    "titles": { "type": "array", "items": { "type": "string" } }
  }
}
```

Run:

```bash
koi start --headless \
  --prompt "Summarize open PRs as JSON with fields: count, titles" \
  --result-schema .koi/pr-summary-schema.json \
  --allow-tool web_fetch \
  --max-turns 10
```

Exit code 0 if the output matches. Exit code 6 if it doesn't.

## CI Recipes

### GitHub Actions

```yaml
- name: Run Koi agent
  id: koi
  env:
    # Pass prompt via env var to avoid shell injection from user-supplied input.
    KOI_PROMPT: "Summarize open PRs as JSON with fields: count, titles"
  run: |
    koi start --headless \
      --prompt "$KOI_PROMPT" \
      --allow-tool web_fetch \
      --max-turns 10 \
      --max-duration-ms 120000 \
      --result-schema .koi/pr-summary-schema.json \
      > koi-output.ndjson
  continue-on-error: true

- name: Check exit code
  run: |
    # Use jq structural selection — grep on '"kind":"result"' is unsafe because
    # model output is user-controlled and could contain that substring.
    RESULT=$(jq -rc 'select(.kind=="result")' < koi-output.ndjson | tail -n1)
    EXIT=$(echo "$RESULT" | jq -r '.exitCode')
    echo "koi exit: $EXIT"
    test "$EXIT" = "0"
```

> **Security note:** The prompt is passed via environment variable (`$KOI_PROMPT`) rather than as a shell argument. This prevents shell injection if the prompt text is derived from user-controlled data (issue titles, PR bodies, etc.).

### Parsing NDJSON in scripts

```bash
# Extract all assistant text chunks
jq -r 'select(.kind=="assistant_text") | .text' < koi-output.ndjson

# Get the result event
jq -rc 'select(.kind=="result")' < koi-output.ndjson | tail -n1

# Check if schema validation failed
jq -r 'select(.kind=="result") | .validationFailed // false' < koi-output.ndjson | tail -n1
```
