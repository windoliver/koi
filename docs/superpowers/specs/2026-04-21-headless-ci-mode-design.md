# Headless CI Mode — Design Spec

**Issue:** #1648  
**Date:** 2026-04-21  
**Status:** Approved for implementation  
**Branch:** `feat/headless-ci-mode`

---

## Context

Koi's headless mode (`koi start --headless`) is already substantially implemented:

- `--headless` flag disables TUI, routes all output to NDJSON on stdout
- NDJSON event stream: `session_start` → `assistant_text` / `tool_call` / `tool_result` → `result`
- All 6 exit codes (0–5) implemented and tested in `headless/exit-codes.ts`
- `--allow-tool` whitelist for permission auto-deny/allow
- `--max-duration-ms`, `--max-turns`, `--max-spend` budget enforcement
- Bootstrap + post-run deadline timers, SIGINT handling, tool payload redaction

**Remaining for #1648 closure (3 items):**
1. `--result-schema <file>` — JSON Schema validation of assistant output
2. `docs/guides/headless-mode.md` — user-facing guide
3. GitHub Actions workflow example (embedded in guide)

---

## 1. `--result-schema <file>`

### Flag definition

Added to `args/start.ts` alongside `--headless`:

```
--result-schema <path>    Path to a JSON Schema file. Validates the agent's
                          text output is valid JSON matching the schema.
                          Headless-only. Exit 1 on validation failure.
```

**Parse-time constraint:** `--result-schema` without `--headless` is a `ParseError`. Consistent with `--allow-tool` and `--max-duration-ms`.

**Type in `StartFlags`:**
```typescript
readonly resultSchema: string | undefined;
```

### Boot-time validation (commands/start.ts)

During setup phase (same phase as `--policy-file` loading):

1. Read file at `flags.resultSchema` path
2. `JSON.parse()` the contents
3. Validate it is a JSON object using only supported keywords (`validateLoadedSchema` — accepts any root object using `type`, `required`, `properties`, `enum`; rejects unsupported keywords and malformed values)
4. On any failure → `bail("result-schema rejected: <reason>", 5)` — exit 5 (INTERNAL) because this is operator misconfiguration, not agent failure

The parsed schema object is stored in a local variable and passed into the post-run validation step.

### Post-run validation (commands/start.ts, headless branch)

After `runHeadless()` returns and `shutdownRuntime()` completes:

1. If `shutdownFailed` → emit INTERNAL, skip schema validation (teardown failure takes precedence)
2. If `headlessCode !== SUCCESS` → emit original exit code, skip schema validation (agent already failed)
3. If `resultSchemaObj !== undefined && headlessCode === SUCCESS` → check `rawAssistantOverflow` first:
   - If `rawAssistantOverflow === true` → `emitResult({ exitCode: 1, error: "schema validation failed: assistant output exceeded 1 MB limit" })`
   - Otherwise → call `validateResultSchema(rawAssistantParts.join(""), resultSchemaObj)`
   - (where `rawAssistantParts` was populated via the `onRawAssistantText` callback before redaction; accumulation is capped at **1 MB UTF-8 bytes** — any chunk that would cross the cap is rejected in full and `rawAssistantOverflow` is set to `true`)
   - **Contract:** `--result-schema` validates the **final assistant message** (the last chunk of text after all tool calls complete) as a single JSON document. The prompt must instruct the model to output ONLY JSON in its final response, with no preamble or prose. Intermediate assistant text (e.g. tool-call narration) is discarded when a `tool_result` event fires. This is intentional — `--result-schema` is for structured-only output modes, not for extracting JSON embedded in prose.
   - On failure → `emitResult({ exitCode: 1, error: schemaResult.error })`
   - On success → normal `emitResult()`
4. Otherwise → normal `emitResult()`

### Minimal JSON Schema validator — `headless/validate-schema.ts`

New file, zero new dependencies. Exports three functions:

- `validateSchemaStructure(schema, path)` — internal; walks the schema tree, rejects unsupported keywords and malformed keyword values. Called at boot by `validateLoadedSchema`.
- `validateLoadedSchema(raw)` — parse-time check: rejects non-objects, unsupported keywords, and malformed keyword values. Fail-closed — any schema oddity surfaces as exit 5 before the agent runs.
- `validateSchema(value, schema, path?)` — runtime check: validates a value against a schema. Fail-closed — malformed keyword values (e.g. `type: "integer"`, `enum: {}`) return an error rather than silently passing.
- `validateResultSchema(assembled, schema)` — top-level helper used by `commands/start.ts`; parses `assembled` as JSON and calls `validateSchema`. Returns `{ ok: true }` or `{ ok: false; error: string }` with the final error string ready to pass to `emitResult`.

**Supported keywords:** `type` (`"object"`, `"array"`, `"string"`, `"number"`, `"boolean"`, `"null"`), `required` (array of strings), `properties` (recursive), `enum` (array of scalars), `items` (recursive, validates array elements).

**Annotation keywords:** `$schema`, `title`, `description`, `$comment` — accepted at any level but not used for validation. This allows operators to use standard schema files generated by tooling without manual stripping.

**Explicit non-goals:** `$ref`, `anyOf`/`oneOf`/`allOf`, `pattern`, `format`, `if/then/else`. A clear error message is emitted rather than silently ignoring unsupported keywords.

### Assistant text accumulation

`runHeadless()` applies `redactEngineBanners()` to assistant text before NDJSON emission. Schema validation must see the model's **raw** output before redaction, so re-parsing the emitted NDJSON stream is not viable — it would validate the sanitized text, not the agent's actual output.

Instead, `RunHeadlessOptions` gains an optional callback:

```typescript
readonly onRawAssistantText?: ((text: string) => void) | undefined;
```

There are two emission paths in `run.ts`, both fire the callback before redaction:

- **Path A (`text_delta`)**: `opts.onRawAssistantText?.(event.delta)` then `emit({ kind: "assistant_text", text: redactEngineBanners(event.delta) })`
- **Path B (`done.output.content` fallback)**: `opts.onRawAssistantText?.(fallback)` then `emit({ kind: "assistant_text", text: redactEngineBanners(fallback) })`

A second optional callback `onToolResultSeen?: (() => void) | undefined` is called by `translateEvent` when a `tool_result` event fires. `commands/start.ts` uses this to **reset** `rawAssistantParts` so only the final assistant message (after all tool calls) is validated, not the entire session text stream.

`commands/start.ts` wires both callbacks only when `resultSchemaObj !== undefined`. After the run, `rawAssistantParts.join("")` is the assembled **final assistant message** passed to `validateResultSchema`.

---

## 2. `docs/guides/headless-mode.md`

Single Markdown file. Sections:

1. **Overview** — what headless mode is, when to use it
2. **Quick start** — minimal working invocation
3. **Flags reference** — all headless-relevant flags with types, defaults, constraints
4. **Exit codes** — table of 0–5 with meaning and retry guidance
5. **NDJSON event reference** — all event kinds with field descriptions
6. **Security defaults** — what's off by default (MCP, plugins, middleware, hooks, transcript) and the env-var opt-ins
7. **Result schema validation** — `--result-schema` usage with example schema
8. **CI recipes** — GitHub Actions workflow (see §3)

---

## 3. GitHub Actions workflow (embedded in guide)

YAML code block inside `docs/guides/headless-mode.md`. Shows:

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

Companion schema file `.koi/pr-summary-schema.json` shown in the guide:

```json
{
  "type": "object",
  "required": ["count", "titles"],
  "properties": {
    "count": { "type": "number" },
    "titles": { "type": "array" }
  }
}
```

---

## Files changed

| File | Change |
|------|--------|
| `packages/meta/cli/src/args/start.ts` | Add `resultSchema: string \| undefined` to `StartFlags`, add `--result-schema` flag, parse-time guard |
| `packages/meta/cli/src/args/start.test.ts` | Tests for `--result-schema` parse rules |
| `packages/meta/cli/src/headless/validate-schema.ts` | New: fail-closed JSON Schema validator + `validateResultSchema` helper |
| `packages/meta/cli/src/headless/validate-schema.test.ts` | New: validator unit tests + `validateResultSchema` integration tests |
| `packages/meta/cli/src/headless/run.ts` | Add `onRawAssistantText` callback to `RunHeadlessOptions` + `translateEvent` |
| `packages/meta/cli/src/commands/start.ts` | Boot-time schema load, `rawAssistantParts` accumulator via callback, post-run validation |
| `docs/guides/headless-mode.md` | New: user guide + safe GitHub Actions recipe |

---

## Testing plan

| Scenario | Expected |
|----------|----------|
| `--result-schema` without `--headless` | `ParseError` at parse time |
| Schema file not found | exit 5, `result-schema rejected: ENOENT` |
| Schema file is invalid JSON | exit 5, `result-schema rejected: invalid JSON` |
| Agent output is not JSON | exit 1, `schema validation failed: assistant output is not valid JSON` |
| Agent output is JSON but fails schema | exit 1, `schema validation failed: .titles is required` |
| Agent output matches schema | exit 0, normal result |
| `shutdownFailed` + valid schema | exit 5 (teardown takes precedence) |

All tests use `bun:test` mocks — no live LLM or filesystem required.
