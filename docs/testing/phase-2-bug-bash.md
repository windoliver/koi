# Phase 2 Bug Bash — E2E Test Plan

> Scenario-based end-to-end test plan covering every shipped Phase 1 and Phase 2 subsystem.
> All scenarios run through the TUI via tmux (not raw CLI) so TUI-side bugs are also surfaced.

**Scope**: shipped Phase 1 + Phase 2 features — including nexus-fs connectors (gdrive, gmail) and inline OAuth flows via the Python bridge (closed #1438). New issues (#1622–#1654) are out of scope.
**Format**: each scenario is `user query → expected turn → follow-up → expected behavior → pass criteria`.
**Execution**: scenarios are independent — you can run them in any order. Reset state between scenarios.

---

## 1. Setup

### 1.1 Prerequisites

```bash
# Toolchain
bun --version        # >= 1.3.x
tmux -V              # >= 3.2
docker --version     # for Nexus
gh --version         # to file bugs
jq --version         # to parse JSONL transcripts

# One-time: install deps
bun install --frozen-lockfile

# One-time: sanity
bun run typecheck
bun run lint
bun run check:layers
```

### 1.2 Environment

```bash
# .env at repo root (Bun auto-loads)
OPENROUTER_API_KEY=<your key from ~/koi/.env>
```

### 1.3 Per-tester isolation (mandatory for parallel runs)

Every stateful resource (HOME, fixture path, tmux session, Nexus port, capture files, session transcripts) MUST be namespaced per tester. Parallel testers on one workstation share nothing — no shared `~/.koi`, no shared `~/.config/nexus-fs`, no shared ports, no shared fixture, no shared `/tmp/koi-capture.txt`.

```bash
# Required envs — set once per shell at the start of the bug bash.
# Run these from the repo root BEFORE any scenario.
export REPO_ROOT="$PWD"                     # stable absolute path to the repo/worktree root — used by §1.7 reset
export WORKTREE=$(basename "$REPO_ROOT")    # e.g. "polished-painting-hummingbird"
export TESTER_ID=t1                         # pick a distinct id per tester: t1..t9
export NAMESPACE="${WORKTREE}-${TESTER_ID}"

# Tmux sessions — prefixed so parallel agents cannot rename/kill each other.
export KOI_SESSION="${NAMESPACE}-koi"
export NEXUS_SESSION="${NAMESPACE}-nexus"
export BASH_SESSION="${NAMESPACE}-bash"     # for out-of-band verification commands

# Fixture project — per-tester (never use a shared /tmp path).
export FIXTURE="/tmp/koi-bugbash-${NAMESPACE}"

# Capture and log paths — per-tester.
export CAPTURE_FILE="/tmp/koi-capture-${NAMESPACE}.txt"
export HOOK_LOG="/tmp/koi-hook-log-${NAMESPACE}.txt"

# Isolated HOME so ~/.koi, ~/.config/nexus-fs, and all state files are private.
# The TUI uses node:os homedir() which respects $HOME, so setting HOME per tester
# isolates transcripts (~/.koi/sessions), memory, hooks config, and OAuth tokens.
export KOI_HOME="/tmp/koi-home-${NAMESPACE}"
mkdir -p "$KOI_HOME/.koi" "$KOI_HOME/.config/nexus-fs"

# Nexus port offset — last digit of the tester id so each tester gets a unique admin API.
export NEXUS_PORT=$((3100 + ${TESTER_ID#t}))  # t1 → 3101, t2 → 3102, ...
```

> **Never use the unnamespaced `$WORKTREE-koi` tmux name or `/tmp/koi-bugbash-fixture` fixture path**. Those were shown in an earlier draft and are not parallel-safe.

### 1.4 Start Nexus (for backend-dependent scenarios)

```bash
# Start Nexus in a per-tester tmux session on a per-tester port.
# Use whatever image/tag your Nexus deployment exposes — map it to $NEXUS_PORT on the host.
tmux new-session -d -s "$NEXUS_SESSION" "docker run --rm -p ${NEXUS_PORT}:3100 <nexus-image>:<tag>"
tmux capture-pane -t "$NEXUS_SESSION" -p | tail -20
# Verify admin API is reachable (each tester uses their own port):
curl -s "http://localhost:${NEXUS_PORT}/admin/api/health"
```

### 1.5 Test fixture project

Every scenario runs against a per-tester fixture project created in §1.3 as `$FIXTURE`. Create it **before** launching the TUI (§1.6) so the TUI's initial cwd is the fixture, not the repo root:

```bash
# $FIXTURE was exported in §1.3 and is already namespaced per tester.
rm -rf "$FIXTURE" && mkdir -p "$FIXTURE"
cd "$FIXTURE"
git init -q
cat > README.md <<'EOF'
# Fixture Project
A small TypeScript project used by the Phase 2 bug bash.
EOF
mkdir -p src test
cat > src/math.ts <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
export function multiply(a: number, b: number): number {
  return a * b;
}
EOF
cat > test/math.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { add, multiply } from "../src/math.js";
test("add", () => expect(add(2, 3)).toBe(5));
test("multiply", () => expect(multiply(2, 3)).toBe(6));
EOF
git add -A && git commit -q -m "init"
cd - >/dev/null
```

### 1.6 Launch Koi TUI

Koi's full-screen console lives under the `tui` subcommand. (Confirm with `bun run packages/meta/cli/src/bin.ts --help`: the top-level commands are `init`, `start`, `serve`, `tui`, `sessions`, `logs`, `status`, `doctor`, `stop`, `deploy`, `plugin`.)

The TUI is launched with `cd '$FIXTURE' &&` so the initial cwd is the per-tester fixture (not the repo root — that would make every scenario's reads/globs resolve against the wrong tree), and with `HOME=$KOI_HOME` so transcripts, memory, hook config, and OAuth tokens live under the isolated per-tester root. This matches the §1.7 reset-path launch exactly.

```bash
tmux new-session -d -s "$KOI_SESSION" "cd '$FIXTURE' && HOME='$KOI_HOME' bun run '$REPO_ROOT/packages/meta/cli/src/bin.ts' tui"
sleep 2
tmux capture-pane -t "$KOI_SESSION" -p | tail -30
```

### 1.7 Reset between scenarios

```bash
# Kill and relaunch the TUI (cleanest reset). Uses $REPO_ROOT (stable, set in §1.3)
# instead of $OLDPWD — zsh updates $OLDPWD on every cd, so relying on it after a
# subshell cd breaks the relaunch on every scenario after the first.
tmux kill-session -t "$KOI_SESSION" 2>/dev/null

# Reset the fixture in a subshell so the tester's cwd is unchanged.
( cd "$FIXTURE" && git reset --hard -q && git clean -fdq )

# Clear per-tester transcript + memory state for a fully fresh session.
rm -rf "$KOI_HOME/.koi/sessions" "$KOI_HOME/.koi/memory"
mkdir -p "$KOI_HOME/.koi/sessions"

tmux new-session -d -s "$KOI_SESSION" "cd '$FIXTURE' && HOME='$KOI_HOME' bun run '$REPO_ROOT/packages/meta/cli/src/bin.ts' tui"
sleep 2
```

> Smoke check: after the first launch in a clean worktree, run every documented invocation (`bun run .../bin.ts --help`, `tui`, `start --prompt "hi"`, `sessions list`) manually to confirm this plan's CLI examples match the current parser. File a `bug-bash` issue if any drift.

---

## 2. Execution Protocol

### 2.1 How to run a scenario

1. Reset state (§1.7)
2. Note the session ID Koi prints at startup (grep for it in the TUI capture)
3. Send the **user query** via `tmux send-keys`
4. Wait for the agent to finish the turn (TUI shows "ready" or equivalent)
5. Capture TUI output with `tmux capture-pane -t "$KOI_SESSION" -p`
6. Run the **verification commands** listed in the scenario
7. If defined, send the **follow-up query** and re-verify
8. Mark pass/fail in your run log

### 2.2 Sending text via tmux

```bash
tmux send-keys -t "$KOI_SESSION" 'your prompt here' Enter
```

Notes: for multi-line input, send each line followed by `Enter`; embedded quotes should be escaped or the text written to a file and pasted via `tmux load-buffer`.

### 2.3 Capturing full scrollback (for bug reports)

```bash
# $CAPTURE_FILE is per-tester — defined in §1.3.
tmux capture-pane -t "$KOI_SESSION" -pS -3000 > "$CAPTURE_FILE"
```

### 2.4 Finding the session transcript

Session transcripts are flat JSONL files stored at `$KOI_HOME/.koi/sessions/<encoded-sessionId>.jsonl`. Two runtime details matter:

1. **Engine session id format**: `createKoi()` generates ids as `agent:<pid>:<uuid>` (`packages/kernel/engine/src/koi.ts:199`). The `tuiSessionId` the CLI prints (if any) is NOT the same as the id `createSessionTranscriptMiddleware` routes writes by — the middleware routes by the *live engine session id* (`packages/lib/session/src/middleware/session-transcript.ts`).
2. **Filename encoding**: `createJsonlTranscript()` writes to `{baseDir}/${encodeURIComponent(sid)}.jsonl` (`packages/lib/session/src/transcript/jsonl-store.ts:164-168`). So the id `agent:1234:abc-def` lands on disk as `agent%3A1234%3Aabc-def.jsonl`. Do not try to build the filename by hand.

Each line is a `TranscriptEntry` with shape `{ id, role, content, timestamp }`, where `role` is one of `user`, `assistant`, `tool_call`, `tool_result`, `system`, `compaction`.

Because `$KOI_HOME` is fully isolated per tester (§1.3 + §1.6 launch with `HOME=$KOI_HOME`), the newest file in *your own* sessions directory is unambiguous — there is no cross-tester race inside an isolated HOME. Always reset between scenarios (§1.7) so "newest" means "this scenario".

```bash
# Reset (§1.7) before each scenario, then after the scenario finishes:
SESSION_FILE=$(ls -t "$KOI_HOME/.koi/sessions"/*.jsonl 2>/dev/null | head -1)
if [ -z "$SESSION_FILE" ]; then
  echo "no transcript in $KOI_HOME/.koi/sessions — did the TUI actually write a turn?" >&2
  return 1 2>/dev/null || exit 1
fi

# If you need the raw session id (for e.g. koi start --resume <id>), decode the filename:
SESSION_ID=$(basename "$SESSION_FILE" .jsonl | python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))')

ls -lh "$SESSION_FILE"
jq -c . "$SESSION_FILE" | tail -20

# Count by role
jq -r '.role' "$SESSION_FILE" | sort | uniq -c
```

> Safety note: only rely on "newest file in `$KOI_HOME/.koi/sessions`" AFTER the §1.7 reset has cleared the directory for this scenario. Do not use this pattern against the shared real `~/.koi/sessions` — that races across testers. The isolation comes from `HOME=$KOI_HOME`, not from the `ls -t` trick.

### 2.5 ATIF trajectory (in-memory only)

Event-trace captures the ATIF trajectory **in memory during the session** — the TUI runtime does NOT write `trajectory.json` to disk. To inspect trajectories you have two options:

1. **Interactive session**: inspect via the event-trace middleware's in-memory API (requires attaching a test harness), OR print at shutdown via a `KOI_DUMP_TRAJECTORY=/tmp/koi-trajectory.json` override if your build supports it (confirm with `bun run packages/meta/cli/src/bin.ts tui --help`).
2. **Golden query replay** (reliable): the runtime package records and replays full ATIF trajectories as fixtures via `bun test --filter=@koi/runtime`. Use this path whenever a scenario's pass criterion depends on ATIF shape — it's deterministic and does not require a live LLM.

For bug reports: if you cannot dump a trajectory directly, capture the full transcript JSONL, the TUI scrollback, and the exact user query. Those are enough for a reviewer to reproduce.

### 2.6 Bug report template

File each bug against `windoliver/koi` using:

```
Title: [bug bash] <scenario id>: <one-line symptom>
Body:
**Scenario**: <id + title>
**Expected**: <from scenario>
**Actual**: <what happened>
**Repro**:
1. git rev-parse HEAD → <commit>
2. Reset state (§1.7)
3. tmux send-keys … '<exact query>'
**TUI capture**: <paste or attach $CAPTURE_FILE (per-tester path from §1.3)>
**Session transcript**: <attach $SESSION_FILE — the flat .jsonl file from $KOI_HOME/.koi/sessions/, per §2.4>
**Trajectory**: in-memory only; omit unless you can dump via a test harness or golden replay
**Severity**: blocker / major / minor / nit
Labels: bug, phase-2, bug-bash
```

---

## 3. Scenarios

Each scenario is self-contained: prerequisites, exact user query, expected turn, follow-up, verification, pass criteria, watch-for bugs. Subsystem tags indicate coverage.

### Group A — First-run & onboarding

#### A1. Simple greeting (no tools)
**Tags**: cli, tui, harness, channel-cli, query-engine, config, event-trace
**Prereqs**: reset state
**User query**: `Hello, what can you do?`
**Expected turn**: model streams a short text response, no tools called
**Follow-up**: `What runtime are you running on?`
**Expected follow-up**: second turn references Bun / TypeScript (from system prompt) without tool calls
**Verify** (against the flat `$SESSION_FILE` from §2.4):
- At least one entry with `role == "assistant"`: `jq -c 'select(.role=="assistant")' "$SESSION_FILE" | wc -l` > 0
- No tool_call entries: `jq -c 'select(.role=="tool_call")' "$SESSION_FILE" | wc -l` == 0
- Exactly 2 user messages: `jq -c 'select(.role=="user")' "$SESSION_FILE" | wc -l` == 2
**Pass**: both turns complete without tool calls; TUI renders incremental tokens
**Watch**: duplicated tokens in TUI; missing final newline; ANSI color bleeding; cursor artifacts on reflow

#### A2. Session resume via `koi start --resume <id>` (shipped CLI path)
**Tags**: session, cli start command, `resumeForSession`, transcript append-on-resume
**Note**: `koi start --resume <id>` is implemented — `packages/meta/cli/commands/start.ts` calls `resumeForSession()` and repopulates the transcript before continuing. This is the primary shipped resume path and must be covered by the bash.
**Prereqs**: complete A1 first. Derive the raw session id from the JSONL filename per §2.4 (URL-decoded).
**Action**: kill the TUI tmux session, then re-run without relaunching the TUI:
```bash
SESSION_FILE=$(ls -t "$KOI_HOME/.koi/sessions"/*.jsonl | head -1)
SESSION_ID=$(basename "$SESSION_FILE" .jsonl | python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))')
HOME="$KOI_HOME" bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" start --resume "$SESSION_ID" --prompt "What did we just talk about?"
```
**Expected**: the prompt runs against the resumed session; answer references the previous turn's content (Bun / TypeScript); the SAME JSONL file gains new entries appended after the original turns
**Verify**:
- `$SESSION_FILE` still points at the same file; `wc -l "$SESSION_FILE"` has grown
- `jq -c 'select(.role=="user")' "$SESSION_FILE" | wc -l` has increased by exactly 1 (the resume prompt)
- The assistant's response mentions the prior Bun / TypeScript context
**Pass**: resumed context is coherent; no duplicated system prompt; the original JSONL file is appended, not rewritten, and not replaced
**Watch**: start failing with `NOT_READY` (if it does, the stub was re-introduced — file a regression); lost history on resume; duplicated system prompt; transcript rewritten from scratch; new session file created with a different id instead of appending

#### A2b. Session resume via TUI session selector (UI path)
**Tags**: tui session selector, `resumeForSession`
**Prereqs**: complete A1 first
**Action**: kill the TUI, relaunch with `HOME=$KOI_HOME bun run ... tui`, and use the in-TUI session selector UI to pick the earlier session
**User query** (after resume): `What did we just talk about?`
**Expected**: agent references Bun / TypeScript from A1
**Verify**: same JSONL file as A1 grew (matching A2's verify steps above)
**Pass**: TUI selector loads the right session; append semantics match A2
**Watch**: selector not showing the session; picking the wrong one; creating a new session instead of resuming

---

### Group B — Core file I/O

#### B1. Read a file
**Tags**: tools-builtin/read, tool-execution, event-trace
**Prereqs**: fixture project at cwd
**User query**: `Show me the contents of src/math.ts`
**Expected turn**: agent calls `read` tool → returns file content → summarizes
**Follow-up**: `What functions does it export?`
**Expected**: agent answers `add` and `multiply` (from previous tool result in context)
**Verify**: `jq -c 'select(.role=="tool_call")' "$SESSION_FILE"` shows exactly 1 `read`-tool entry in the first turn
**Pass**: file content displayed in TUI; follow-up does NOT re-read the file
**Watch**: stale file content; path normalization bugs; permission false-denies; TUI scrolling glitches on long content

#### B2. Glob + grep + edit workflow
**Tags**: glob-tool, grep-tool, edit tool, tool-execution, multi-step planning
**Prereqs**: fixture project
**User query**: `Find all TypeScript files in src/ that export functions, then add a JSDoc comment above each exported function explaining what it does.`
**Expected turn sequence**: glob `src/**/*.ts` → grep for `export function` → read matching files → edit each with JSDoc
**Follow-up**: `Run the tests to make sure nothing broke.`
**Expected**: bash tool runs `bun test`; all tests still pass
**Verify**:
- `git diff` in the fixture shows JSDoc comments added
- `cd $FIXTURE && bun test` still passes
**Pass**: edits are surgical (no unrelated changes); JSDoc syntax valid
**Watch**: edit tool wrecking file formatting; over-editing (rewrote whole file); missed files; comment syntax errors

#### B3. Write new file
**Tags**: write tool, permissions (allow write path), session
**User query**: `Create a new file src/string-utils.ts that exports a camelCase function.`
**Expected turn**: write tool creates the file with correct content
**Follow-up**: `Import it into src/math.ts and use it somewhere.`
**Expected**: edit on math.ts that adds the import
**Verify**: `cat $FIXTURE/src/string-utils.ts` exists with valid code; import in math.ts
**Pass**: new file syntactically correct; no conflicts with existing files
**Watch**: overwriting existing files without confirmation; wrong module paths; missing `.js` extensions in imports per project convention

#### B4. Notebook cell operations
**Tags**: `@koi/tool-notebook`, notebook_read, notebook_add_cell, notebook_replace_cell, notebook_delete_cell
**Setup**: seed a minimal `.ipynb` in the fixture:
```bash
cat > "$FIXTURE/notebook.ipynb" <<'EOF'
{
  "cells": [
    { "cell_type": "markdown", "metadata": {}, "source": ["# Bug bash notebook"] },
    { "cell_type": "code", "metadata": {}, "source": ["print('hello')"], "outputs": [], "execution_count": null }
  ],
  "metadata": { "kernelspec": { "display_name": "Python 3", "language": "python", "name": "python3" } },
  "nbformat": 4,
  "nbformat_minor": 5
}
EOF
```
**User query**: `Read notebook.ipynb, then add a code cell that prints "world", then replace the first markdown heading with "# Bug bash v2".`
**Expected turn sequence**: `notebook_read` → `notebook_add_cell` → `notebook_replace_cell`
**Follow-up**: `Delete the original hello print cell.`
**Expected follow-up**: `notebook_delete_cell` tool_call
**Verify**:
- `jq -c 'select(.role=="tool_call" and (.content | test("notebook_")))' "$SESSION_FILE"` returns at least 4 entries
- `jq '.cells | length' "$FIXTURE/notebook.ipynb"` matches the expected count after ops
- Reading the notebook back shows the new markdown heading and the world cell
**Pass**: all four notebook tools exercised; notebook remains valid JSON and a valid .ipynb document
**Watch**: notebook rewritten with lost metadata; cell ids not preserved; `nbformat`/`nbformat_minor` stripped; JSON corruption; binary output fields mangled

---

### Group C — Bash & security

#### C1. Bash with allowed command
**Tags**: tools-bash, bash-security, bash-tool streaming, tool-execution
**User query**: `Run 'bun test' in the fixture project and tell me the result.`
**Expected turn**: bash tool runs; agent reports pass/fail
**Verify**: `jq -c 'select(.role=="tool_call")' "$SESSION_FILE"` shows the bash call; the paired `tool_result` entry contains the stdout and a non-error status
**Pass**: command output streams live into TUI (not buffered)
**Watch**: output buffering; ANSI color mangling; SIGPIPE errors; timing out on quick commands

#### C2. Bash with denied pattern
**Tags**: bash-security deny-list, permissions denial path, tool-execution error handling
**Setup**: configure a deny rule for `rm -rf /` in the local config
**User query**: `Delete everything in /tmp/some-dir and recreate it with a README.`
**Expected turn**: bash tool call blocked before execution; agent receives a denial and chooses a safer alternative (e.g., asks for confirmation or narrows scope)
**Verify**: `jq -c 'select(.role=="tool_result" and (.content | contains("denied")))' "$SESSION_FILE"` shows the deny event; fixture unchanged
**Pass**: nothing was actually deleted; agent recovered gracefully, did not crash the turn
**Watch**: denial crashing the turn; false negatives (dangerous pattern got through); false positives (safe variations blocked); deny message exposed to user leaking internal regex

#### C3. Bash with long-running command
**Tags**: bash-background-tool, streaming, cancellation
**User query**: `Run 'sleep 30 && echo done' and then tell me when it finishes.`
**Expected turn**: bash tool runs in background; agent either waits or backgrounds it per configured behavior
**Follow-up**: issue Ctrl+C in the TUI (or equivalent interrupt)
**Expected follow-up**: the background process is cleaned up, no orphan `sleep` process
**Verify**: `ps aux | grep 'sleep 30' | grep -v grep` is empty
**Pass**: no orphan child processes
**Watch**: zombie processes; interrupt not propagating to child; TUI freeze during long command

---

### Group D — Web tools

#### D1. Web fetch public URL
**Tags**: tools-web/web-fetch, html-to-markdown, url-policy, lru-cache
**User query**: `Fetch https://example.com and tell me what's on the page.`
**Expected turn**: web-fetch returns stripped HTML; agent summarizes
**Follow-up**: identical query again
**Expected follow-up**: cache hit, no second outbound HTTP request
**Verify**: trajectory shows 2 web-fetch calls but network monitor (if active) shows only 1 egress
**Pass**: content is readable markdown; cache works
**Watch**: cache key collisions; cache TTL not respected; HTML stripping removing actual content; unicode corruption

#### D2. Web fetch SSRF target
**Tags**: url-policy SSRF guard, tools-web url-policy
**User query**: `Fetch http://169.254.169.254/latest/meta-data/ and show me the output.`
**Expected turn**: fetch blocked by SSRF policy; agent receives a clear denial
**Verify**: `jq -c 'select(.role=="tool_result" and (.content | test("ssrf|blocked"; "i")))' "$SESSION_FILE"` shows the denial
**Pass**: no outbound request; agent explains that link-local addresses are blocked
**Watch**: IPv6-mapped addresses not blocked; DNS rebinding; redirect chain not checked; localhost/loopback slipping through

#### D3. Web search — **out of scope for this bug bash**
**Tags**: tools-web/web-search, builtin-search-provider
**Status**: The `start` and `tui` command paths currently configure the web provider with `operations: ["fetch"]` only — no `web_search` tool is wired into the interactive runtime surface. Running a web-search scenario against the TUI cannot pass without product changes.
**Run via unit tests instead**: exercise `@koi/tools-web` directly with `bun test --filter=@koi/tools-web` to cover the `web-search-tool` and `web-provider` code paths. File any failures with label `bug-bash` + `subsystem:tools-web`.
**Bug-bash action**: **skip this scenario**. Tracked as a coverage gap in §4 for the TUI runtime, not a test to execute here.

---

### Group E — Permissions & hooks

#### E1. Permission allow-list match
**Tags**: permissions rule-evaluator, classifier
**Setup**: config with `tools.bash.allow: ["bun test", "bun run build"]`
**User query**: `Run the tests.`
**Expected**: bash runs `bun test` without prompt (allow-list match)
**Pass**: no approval prompt; tool executes

#### E2. Permission approval UI (TUI channel-level, not via `AskUserQuestion` tool)
**Tags**: permissions, channel-level approval UI, tui-runtime permission handler
**Note**: the `AskUserQuestion` tool is NOT registered in `createTuiRuntime()`. Permission prompts in the TUI come from the channel/runtime approval handler, not from the tool surface. This scenario exercises that runtime path.
**Setup**: permission rule with a verdict that triggers an interactive prompt on the `fs_edit` tool
**User query**: `Fix the typo in README.md (change 'Fixture' to 'Fixtures').`
**Expected**: TUI displays an approval prompt; after the user approves, the edit applies
**Verify**: transcript shows a tool_call for `fs_edit` followed by a tool_result indicating the approved edit; no `AskUserQuestion` tool_call appears
**Pass**: approval prompt renders in TUI; user input accepted; edit completes
**Watch**: prompt hanging the agent loop; double-prompting; approval not persisted within session; accidental dependency on the tool-surface `AskUserQuestion` (which is not wired)

#### E3. Pre-tool-use command hook
**Tags**: hooks (command executor), hooks lifecycle, hook-prompt
**Setup**: hook config written to `$KOI_HOME/.koi/hooks.json` that runs `echo "pre-tool-use: $TOOL_NAME" >> "$HOOK_LOG"` before every tool call (`$HOOK_LOG` is the per-tester path from §1.3).
**User query**: `Read src/math.ts and then write a summary to $FIXTURE/summary.txt.`
**Expected**: both tool calls fire; hook log captures both
**Verify**: `cat "$HOOK_LOG"` shows at least 2 entries with tool names
**Pass**: hook fires in correct order; agent loop not blocked by hook
**Watch**: hook output leaking into agent context; hook failures crashing the turn; env var not set

#### E4. HTTP hook receives event
**Tags**: hooks HTTP executor, event serialization
**Setup**: start a POST-capable stub server on a per-tester port. `python3 -m http.server` only handles `GET`/`HEAD` (its `SimpleHTTPRequestHandler` returns 501 on POST), so it will NOT capture the hook body — do not use it.

Use a tiny Bun script instead (works out of the box in this repo):

```bash
export HOOK_PORT=$((9900 + ${TESTER_ID#t}))  # per-tester port
export HOOK_LOG="/tmp/koi-hook-log-${NAMESPACE}.txt"
: > "$HOOK_LOG"
tmux new-session -d -s "${NAMESPACE}-hook-stub" "bun -e 'const port = Number(process.env.HOOK_PORT); const logPath = process.env.HOOK_LOG; Bun.serve({ port, async fetch(req){ const body = await req.text(); await Bun.write(logPath, (await Bun.file(logPath).text().catch(() => \"\")) + req.method + \" \" + new URL(req.url).pathname + \" \" + body + \"\n\"); return new Response(\"ok\"); } }); console.log(\"hook stub on \" + port);'"
```

Configure the hook in `$KOI_HOME/.koi/hooks.json` to POST to `http://127.0.0.1:${HOOK_PORT}/hook` on a pre-tool-use event.

**User query**: `Read README.md`
**Expected**: the hook stub's log (`$HOOK_LOG`) receives a POST with the tool event payload (method is POST per `packages/lib/hooks/src/executor.ts`)
**Verify**: `cat "$HOOK_LOG"` shows `POST /hook {...json...}` with the expected event shape
**Pass**: request received, body parses as JSON, event shape stable and backward-compatible
**Watch**: listener replying 501 (wrong stub — revert to the Bun.serve above); sensitive data leaking in the body; blocking the agent on a slow hook; port collision between testers (use the `$HOOK_PORT` pattern above)

---

### Group F — Context window tail-slicing

> **The TUI runtime does NOT wire `@koi/context-manager` or any compactor middleware.** `createTuiRuntime()` builds its adapter via `packages/meta/cli/src/engine-adapter.ts:85`, which simply passes `transcript.slice(-maxTranscriptMessages)` into each turn. There is no summarization, no pressure-driven compaction, no tool-output pruning, and no `compaction` transcript entries emitted by the TUI code path. Group F therefore tests the **tail-window behavior the TUI actually implements** — not real compaction. True compaction coverage is run via `bun test --filter=@koi/context-manager` (and related middleware) as a separate step.

#### F1. Tail-window: older turns fall out of the model context
**Tags**: engine-adapter `maxTranscriptMessages`, tail slice behavior
**Setup**: the TUI defaults to `MAX_TRANSCRIPT_MESSAGES` (check `packages/meta/cli/src/tui-runtime.ts:846` for the current value). No config override needed.
**User queries**: in the SAME session, alternate user/assistant turns more than `maxTranscriptMessages + 5` times. Include a distinctive fact in the very first user turn (e.g. `My magic word is mongoose-alpha-seven`).
**Follow-up** (after enough turns have elapsed): `What was my magic word?`
**Expected**: the agent has NO reliable way to recall `mongoose-alpha-seven` because the earliest turns have fallen out of the tail window. It may hallucinate or admit it doesn't know. Both are valid — what matters is that the transcript file still contains the early turn (append-only on disk) while the model does NOT see it in the latest request.
**Verify**:
- `$SESSION_FILE` (per §2.4) still contains the early `mongoose-alpha-seven` message
- Count user messages: `jq -c 'select(.role=="user")' "$SESSION_FILE" | wc -l` is greater than `maxTranscriptMessages/2` (so some turns have been pushed out of the tail window)
**Pass**: the transcript append-only store keeps full history on disk; the model receives only the tail slice; agent behavior is consistent with that (no silent corruption of the transcript file)
**Watch**: transcript file losing early turns (it shouldn't — the store is append-only); tail slice breaking tool_call / tool_result pairing at the boundary; system prompt dropping out of the window (it shouldn't be part of the tail slice at all)

#### F2. Large tool output rendering in the tail window
**Tags**: engine-adapter tail slice, tool_result sizing
**User query**: `Run 'find / -type f 2>/dev/null | head -5000' and tell me how many files.`
**Expected**: bash returns a large tool_result; the agent answers correctly for the recent turn
**Verify**:
- `jq -c 'select(.role=="tool_result")' "$SESSION_FILE" | tail -1 | wc -c` — the file-stored tool_result is not truncated (append-only)
- The agent's answer in the current turn is accurate
**Pass**: recent tool output is usable; file stays intact
**Watch**: agent truncating stdout mid-line and reporting the wrong count; huge tool_result blowing past the model's context limit (the TUI does NOT prune it — if that's a problem today, file a `missing-coverage` issue for compaction wiring in the TUI)

#### F3. Real compaction semantics — covered via test suite, not TUI
**Tags**: `@koi/context-manager`, middleware-compactor, token budget, protected-region tests
**Action**:
```bash
bun test --filter=@koi/context-manager
bun test --filter=@koi/lib/context-manager   # in case the filter pattern differs
```
**TUI coverage**: N/A — no compactor is wired. Any TUI session that exceeds `maxTranscriptMessages` loses old turns from the model's view but never produces a `compaction` transcript entry.
**Pass**: context-manager tests cover: soft/hard triggers, tool-output pruning, protected regions (system prompt and recent turns), and overflow recovery.
**Watch**: tests that only exercise in-memory shapes without verifying the token budget accounting; tests that don't assert system prompt preservation under pressure; test coverage gaps for the protected-region boundary.

---

### Group G — MCP

#### G1. MCP stdio server lifecycle
**Tags**: mcp stdio transport, mcp-server, resolver
**Setup**: configure an MCP server (e.g., a simple echo server) in config
**User query**: `List the MCP tools you have available.`
**Expected turn**: agent uses MCP resolver to list tools; reports them accurately
**Verify**: trajectory shows MCP lifecycle events (connect → list_tools → response)
**Pass**: server connects on startup; list matches server declaration
**Watch**: stale tool list after MCP server restart; connection not cleanly closed on exit; spawn leak

#### G2. MCP tool invocation
**Tags**: mcp tool dispatch, tool-execution wrapping, error boundary
**User query**: `Use the echo MCP tool to say "hello from mcp".`
**Expected turn**: MCP tool called; response returned and surfaced to user
**Verify**: session JSONL shows the MCP tool call + response
**Pass**: response text matches input
**Watch**: MCP error not propagated; tool args serialization bug; type mismatch between declared schema and runtime

#### G3. MCP HTTP transport
**Tags**: mcp HTTP transport, mcp-server connection
**Setup**: configure an HTTP MCP server
**User query**: `List your MCP tools.`
**Expected**: tools listed including the HTTP-transport server's tools
**Pass**: both stdio and HTTP transports work in the same session
**Watch**: transport confusion; auth headers not sent; TLS errors not surfaced clearly

---

### Group H — Agent runtime & subagents

> **Subagent spawning is intentionally stubbed in the TUI runtime.** `packages/meta/cli/src/tui-runtime.ts` wires `agent_spawn` to a hard error (`"agent_spawn is not available in koi tui. Cannot delegate to ..."`) because the TUI does not ship the agent-runtime + harness wiring that real delegation needs. Covering real subagent behavior from the TUI is not possible with the shipped code — H1/H2 are run via the test suite, not through the TUI.

#### H1. Spawn general-purpose subagent — covered via test suite, not TUI
**Tags**: agent-runtime, subagent spawn, inheritance, spawn-tools
**Action** (not in the TUI):
```bash
bun test --filter=@koi/agent-runtime
bun test --filter=@koi/spawn-tools
```
**Expected**: all tests pass; parent→child spawn paths, permission inheritance, and error propagation all covered.
**TUI smoke check**: inside the TUI, ask the agent to delegate. The stub should surface `"agent_spawn is not available in koi tui"` as a recoverable tool error; the agent should fall back to inline work without crashing the turn.
**Pass**: test suites green; TUI surfaces the stub error cleanly without killing the session
**Watch**: TUI crashing instead of recovering from the stub error; tests hiding regressions (run with `-v`); stub error code no longer `EXTERNAL`

#### H2. Parallel subagent fan-out — covered via test suite, not TUI
**Tags**: agent-runtime concurrent spawn, result aggregation
**Action** (not in the TUI): locate and run the parallel-spawn / fan-out tests within `bun test --filter=@koi/agent-runtime`. If no tests currently cover parallel aggregation, file a `bug-bash` + `missing-coverage` issue against `@koi/agent-runtime` rather than attempting to reproduce it through the TUI (which will always fail via the stub).
**TUI coverage**: N/A — see note above.
**Pass**: parallel spawn code paths have concrete test coverage; any coverage gap is tracked explicitly
**Watch**: tests that fake concurrency with sequential `await` in a loop; race conditions in shared task-board state not covered

#### H3. Plan mode (read-only enforcement) — **not currently in TUI; covered via test suite**
**Tags**: plan-mode tool, permissions scoping
**Status**: `createTuiRuntime()` does NOT register `EnterPlanMode` or `ExitPlanMode`. The TUI cannot enter plan mode at all. `packages/lib/tools-builtin/src/tools/plan-mode.ts` exists but is not wired into the TUI surface.
**Action**:
```bash
bun test --filter=@koi/tools-builtin    # covers plan-mode tool factory + read-only gate
```
**TUI coverage**: N/A until `EnterPlanMode`/`ExitPlanMode` are wired into `createTuiRuntime()` alongside a permission backend that can enforce the gate. Track as a `missing-coverage` issue.
**Pass**: tool factory tests pass; scope semantics are unit-tested.
**Watch**: tests that only cover the tool shape without exercising the permission denial path.

---

### Group I — Skills

> **User skill root is `~/.claude/skills`**, not `~/.koi/skills` (per `tui-runtime.ts:802` and `packages/lib/skills-runtime/src/discover.ts`). Because the TUI is launched with `HOME=$KOI_HOME` (§1.6), the in-process `~` resolves to `$KOI_HOME` — so fixture writes MUST go under `$KOI_HOME/.claude/skills/` from the tester shell, never under the real `~/.claude/skills` of the user. Using a literal `~` in a tester shell command writes to the real user home and will either leak into other sessions or fail silently.

#### I1. Skill discovery from disk
**Tags**: skills-runtime loader, skill-tool, user skill root
**Setup**: create a skill under the per-tester isolated skills root, then reset the TUI so discovery picks it up.
```bash
mkdir -p "$KOI_HOME/.claude/skills/hello"
cat > "$KOI_HOME/.claude/skills/hello/SKILL.md" <<'EOF'
---
name: hello
description: A minimal bug-bash smoke skill.
---

# Hello
Respond with "hello from the bug-bash skill".
EOF
# Trigger §1.7 reset so the TUI rediscovers skills.
```
**User query**: `What skills do you have?`
**Expected**: agent's answer mentions `hello` in the available skills list
**Verify**: `tmux capture-pane -t "$KOI_SESSION" -pS -1000 | grep -i hello`
**Pass**: the new skill is discoverable after restart
**Watch**: writing to the real user home (literal `~` in the tester shell resolves to the real HOME, not `$KOI_HOME`); duplicate skills shadowing each other; malformed frontmatter crashing discovery; skill-tool descriptor baked at startup and stale after reset (known limitation — flag if it surprises testers)

#### I2. Skill invocation via the Skill tool
**Tags**: skill-tool, skills-runtime execution
**Prereq**: I1 complete — `hello` is loaded
**User query**: `Use the hello skill.`
**Expected**: agent calls the `Skill` tool with `name=hello`; tool output is the skill body
**Verify**: `jq -c 'select(.role=="tool_call" and (.content | contains("hello")))' "$SESSION_FILE"`
**Pass**: skill output returned
**Watch**: skill parameter binding; skill tool schema not matching declared inputs; agent answering from context instead of calling the tool

#### I3. Skill scanner rejects suspicious skill
**Tags**: skill-scanner (security)
**Setup**: add a skill under `$KOI_HOME/.claude/skills/bad-skill/SKILL.md` that references a suspicious pattern (e.g., `rm -rf`, exfiltrating env vars). Never place this under the real user home.
**User query**: `List skills.`
**Expected**: the suspicious skill is either flagged or excluded from the registry with a clear warning
**Verify**: `tmux capture-pane -t "$KOI_SESSION" -pS -2000 | grep -Ei 'scanner|rejected|bad-skill'`
**Pass**: malicious skill does not appear in the runtime registry
**Watch**: scanner false-positives on legitimate skills; scanner bypass via encoding/obfuscation

---

### Group J — Tasks

> **The TUI uses `createMemoryTaskBoardStore()` (`tui-runtime.ts:653,997`)** — there is NO `~/.koi/tasks.json` or any on-disk task store. Verification for J1/J2/J3 MUST happen via the session transcript (tool_call / tool_result for `task_*` tools) and the TUI task panel UI, not via filesystem inspection.

#### J1. Create task via `task_create`
**Tags**: `@koi/task-tools`, task_create, in-memory task board
**User query**: `Create a task to refactor the multiply function in src/math.ts.`
**Expected**: agent calls `task_create` with a descriptive subject; TUI task panel updates to show the new task in its initial state
**Verify**: `jq -c 'select(.role=="tool_call" and (.content | contains("task_create") and contains("multiply")))' "$SESSION_FILE"` returns one match; `tmux capture-pane -t "$KOI_SESSION" -pS -1000 | grep -i multiply` shows the task in the panel
**Pass**: task visible in TUI task panel
**Watch**: task_create tool_call missing from transcript; panel not refreshing; task id reused across sessions

#### J2. Task state transitions via `task_update`
**Tags**: `@koi/task-tools`, task_update, managed task board state machine
**User queries** (sequential):
1. `Create a task called "Run the tests" and leave it pending.`
2. `Mark the "Run the tests" task as in_progress.`
3. `Mark the "Run the tests" task as completed.`
**Expected**: each turn produces a `task_update` (or `task_create` for the first) tool_call; transitions respect the state machine (pending → in_progress → completed)
**Verify**: sequence check via transcript:
```bash
jq -r 'select(.role=="tool_call") | .content' "$SESSION_FILE" | grep -oE 'task_(create|update)[^"]*(pending|in_progress|completed)' | head
```
**Pass**: transitions happen in declared order; invalid transitions (e.g., pending → completed without in_progress) are rejected by the task board
**Watch**: allowing invalid transitions; completed tasks reverting to pending silently; duplicate task updates racing

#### J3. Task list in TUI
**Tags**: task-board, TUI rendering
**User query**: `Show me all my current tasks.`
**Expected**: TUI renders a task list with status, owner, blocked-by relationships
**Pass**: long lists scroll; filtering by status works
**Watch**: stale display after async updates; sort order unstable

---

### Group K — Memory

> **Important: the TUI uses an in-memory memory backend**, not an on-disk store. `packages/meta/cli/src/tui-runtime.ts` wires `createInMemoryMemoryBackend()` and the reset path explicitly calls `memoryBackend.clear()` on each new session (`tui-runtime.ts:977-979`). There is no `~/.koi/memory` directory to grep against. Scenarios below verify within-session storage/recall through the `memory_store`, `memory_recall`, `memory_search` tools, NOT through the filesystem.

#### K1. Within-session memory store + recall (in-memory backend)
**Tags**: `memory-tools`, `memory_store`, `memory_recall`, in-memory backend
**User query** (turn 1): `Remember that this project uses Bun 1.3 and Biome for linting, and that we prefer explicit return types on exported functions.`
**Expected turn 1**: agent calls `memory_store` with the three facts as separate entries (or one structured entry)
**Follow-up** (turn 2, same session): `What do you remember about the toolchain?`
**Expected turn 2**: agent calls `memory_recall` or `memory_search` and reports the three facts
**Verify** (within the same session, against `$SESSION_FILE`):
- At least one `memory_store` tool_call entry in turn 1
- At least one `memory_recall` or `memory_search` tool_call entry in turn 2
- The assistant's final message in turn 2 mentions Bun, Biome, and return types
**Pass**: recall inside the same session works via the tools, not via the transcript
**Watch**: `memory_store` not called (agent answered from context); `memory_recall` returning stale entries from a prior session (should be empty after reset — the backend is cleared); memory contents leaking verbatim user text vs structured facts

#### K2. Memory is cleared on new-session reset
**Tags**: memory backend clear on reset, cross-session isolation
**Setup**: K1 must be complete. Trigger a new-session reset from within the TUI (the command that resets bash cwd + memory + backgrounds — check the TUI help or use `/new` if exposed).
**User query** (after reset): `What do you remember about the toolchain?`
**Expected**: memory_recall returns nothing; agent says it has no stored memory for this session
**Pass**: reset cleared the in-memory backend (confirms `memoryBackend.clear()` is wired to the reset path); prior facts are NOT recalled
**Watch**: prior facts leaking across sessions (backend not actually cleared); reset not wired to memory-clear at all; agent hallucinating recall from its own context instead of calling the tool

#### K3. Memory redaction for sensitive inputs
**Tags**: `memory-team-sync` filter, redaction, scrubbing path
**User query**: `Remember my OpenAI API key is sk-test-fake-key-12345 and my contact email is test@example.com.`
**Expected**: either (a) the agent refuses to store secrets via its own judgement, OR (b) the memory store path redacts/scrubs the values before persisting. Both are acceptable outcomes — a tester should flag if NEITHER happens.
**Verify** (within the same session):
- Any `memory_store` tool_call in `$SESSION_FILE` must NOT contain `sk-test-fake-key-12345` verbatim as the stored value (the argument body is fair game if the model echoes it, but the stored entry should be redacted)
- A `memory_recall` in a follow-up turn should NOT return the raw key
**Pass**: the key and email are never returned by `memory_recall`
**Watch**: partial redaction (`sk-test-*` leaking); recall returning the raw secret even though store appeared to redact it; false negatives on less common secret formats (Stripe keys, AWS keys, JWTs)
**Out of scope**: on-disk persistence tests — the TUI has no on-disk memory backend. The persistence path is covered via `bun test --filter=@koi/memory`.

---

### Group L — Plugins

#### L1. Plugin manifest loads
**Tags**: plugins loader, manifest parsing
**Setup**: the plugin loader reads `plugin.json` (NOT `plugin.yaml` — schema lives in `packages/lib/plugins/src/schema.ts`, read by `packages/lib/plugins/src/loader.ts`). Create a minimal JSON manifest in the per-tester HOME:
```bash
mkdir -p "$KOI_HOME/.koi/plugins/hello-plugin"
cat > "$KOI_HOME/.koi/plugins/hello-plugin/plugin.json" <<'EOF'
{
  "name": "hello-plugin",
  "version": "0.0.1",
  "description": "Bug bash smoke plugin"
}
EOF
```
<!-- Maintainers: if packages/lib/plugins/src/schema.ts changes, update the required/optional field lists below. -->
The three fields above (`name`, `version`, `description`) are the **entire** required set per the Zod schema at `packages/lib/plugins/src/schema.ts:20-32`. The loader accepts this exact manifest without error — no other fields are required. Constraints: `name` must match `^[a-z][a-z0-9-]*$` (kebab-case, starts with lowercase letter); `version` and `description` must each be non-empty.

Optional fields available for tests that want to exercise more surface area: `author` (string), `keywords` (string[]), `skills` (string[]), `hooks` (string path, e.g. `./hooks/hooks.json`), `mcpServers` (string path, e.g. `./.mcp.json`), `middleware` (string[]).
**Action**: restart TUI with the isolated HOME (§1.7 reset).
**Expected**: plugin discovered at startup (no ENOENT on the manifest) and enumerated by the loader
**Verify**: `tmux capture-pane -t "$KOI_SESSION" -p | grep hello-plugin`
**Pass**: plugin listed as loaded; no errors
**Watch**: `plugin.yaml` silently skipped (loader only reads `plugin.json` — if you see that, the test harness is misconfigured); malformed manifest crashing startup instead of being reported as an error; version mismatch silently ignored

#### L2. Plugin hook fires
**Tags**: plugin + hooks integration
**Setup**: plugin declares a pre-tool-use hook
**User query**: any tool-invoking prompt
**Expected**: plugin hook fires before the tool call
**Verify**: plugin-side log (wherever the plugin wrote it) contains the event
**Pass**: hook firing order matches declared lifecycle

---

### Group M — Filesystem backends

#### M1. fs-local backend basic operations
**Tags**: fs-local, file-resolution
**User query**: `Create a new file /tmp/koi-test.txt with the content "hello".`
**Expected**: write tool succeeds via fs-local
**Verify**: `cat /tmp/koi-test.txt` == "hello"
**Pass**: file exists with correct content

> **Important: the TUI runtime hardcodes `createLocalFileSystem(cwd)`** for `fs_read/fs_write/fs_edit` (`packages/meta/cli/src/tui-runtime.ts:576`). It never instantiates `@koi/fs-nexus`, never spawns the Python bridge, and cannot serve multi-mount configurations. The async filesystem resolver also rejects multi-mount local-bridge configs. As a result, M2/M3 and all of Group R below are NOT executable through the TUI — they are covered by the test suite, not by interactive turns.

#### M2. fs-nexus local transport — **covered via test suite, not TUI**
**Tags**: fs-nexus local transport, Python bridge, nexus-filesystem-backend
**Action**:
```bash
bun test --filter=@koi/fs-nexus
```
Focus on `local-transport.test.ts` (bridge spawn, stdin JSON-RPC, mount discovery) and `nexus-filesystem-backend.test.ts` (the FileSystemBackend contract).
**TUI coverage**: N/A — the TUI wires `@koi/fs-local` directly and cannot spawn the bridge.
**Pass**: tests green.
**Watch**: tests skipping the bridge path because `python3` isn't installed; flaky subprocess teardown; stdin pipe buffering.

#### M3. Dual-backend manifest — **covered via test suite / runtime package**
**Tags**: dual-backend filesystem, manifest-driven backend selection, file-resolution
**Action**:
```bash
bun test --filter=@koi/runtime    # covers resolveFileSystemAsync and manifest-driven selection
bun test --filter=@koi/file-resolution
```
**TUI coverage**: N/A — the TUI does not read a dual-backend manifest; `createTuiRuntime()` uses the hardcoded local backend.
**Pass**: resolver picks the right backend for every test case; no cross-backend bleed.
**Watch**: resolver falling through to default on misconfigured manifests; tests missing real Nexus side of the dual-backend (they use a fake).

---

### Group R — Nexus-fs connectors & inline OAuth — **covered via test suite, not TUI**

> This group exercises the bridge auth notification protocol (closed #1438) and multi-mount nexus-fs connectors.
> **None of Group R is executable through the shipped TUI** — see the Group M note. The TUI does not instantiate the Python bridge or the fs-nexus transport. Every scenario below targets `bun test --filter=@koi/fs-nexus` (or the scripted Python bridge fakes in `packages/lib/fs-nexus/src/local-transport.test.ts`) instead of a TUI turn.
> The scenario text is retained as a **contract specification**: it documents the behavior the tests should cover. File `bug-bash` + `missing-coverage` issues against `@koi/fs-nexus` for any scenario that lacks a corresponding test.
> **Setup caveat for real-provider paths**: Gmail / Google Drive OAuth flows need real credentials; use the scripted Python bridge fakes from `local-transport.test.ts` to exercise the bridge auth protocol without hitting real providers.

#### R1. Multi-mount: local + gdrive
**Tags**: fs-nexus local transport, multi-mount, `mountUri` array
**Setup**: real gdrive credentials OR scripted fake bridge; `createLocalTransport({ mountUri: ["local://$FIXTURE", "gdrive://my-drive"] })`
**User query**: `List the mounts you have access to.`
**Expected turn**: agent lists both `/local/...` and `/gdrive` from `transport.mounts`
**Follow-up**: `Read README.md from the local mount and list the top-level folders on my gdrive mount.`
**Expected follow-up**: local read succeeds immediately; gdrive list either succeeds (if pre-authed) or triggers R2 OAuth flow
**Verify**: startup capture shows both mounts in the ready payload; trajectory shows distinct RPC calls tagged by mount
**Pass**: both mounts discoverable and independently operable
**Watch**: second mount silently dropped on bridge startup error; mount order affecting routing; mount prefix resolver confusing `/gdrive/foo` vs `/gdrive-foo/`

#### R2. Inline OAuth — local mode (browser callback)
**Tags**: bridge auth notifications, `auth_required`, `auth_complete`, fs-nexus/auth-notifications
**Setup**: gdrive mount with NO existing token — **use the per-tester isolated config root**, never the shared user config.
```bash
# The TUI was launched with HOME=$KOI_HOME (§1.6), so nexus-fs will look for
# tokens at $KOI_HOME/.config/nexus-fs/tokens.db (isolated per tester).
rm -f "$KOI_HOME/.config/nexus-fs/tokens.db"
mkdir -p "$KOI_HOME/.config/nexus-fs"
```
> **Never run `rm -f ~/.config/nexus-fs/tokens.db`** against the real user HOME — that wipes shared OAuth credentials used by other sessions or testers on the same account. The isolated `$KOI_HOME` root from §1.3 is the only safe target.
> Localhost callback server must be reachable (default `mode: "local"` in the bridge).
**User query**: `Show me the first 10 files in my gdrive root.`
**Expected turn sequence**:
  1. Bridge catches `AuthenticationError` on the first I/O call
  2. Bridge sends `auth_required` notification (`mode: "local"`) on stdout
  3. Koi channel shows: **"Authorize google-drive to continue"** with the OAuth URL
  4. User clicks link → completes OAuth in browser → callback fires → token stored
  5. Bridge retries the original operation → succeeds
  6. Bridge sends `auth_complete` notification → channel shows "google-drive authorization complete. Continuing..."
  7. Agent receives the file list and reports it
**Verify**:
- TUI capture contains the `auth_required` message followed by `auth_complete`
- `ls "$KOI_HOME/.config/nexus-fs/tokens.db"` exists after completion (isolated per tester)
- The retry succeeded, not the initial attempt (confirm via session transcript tool_result entries, since trajectories are in-memory only — see §2.5)
**Pass**: user sees the link, completes OAuth, the original turn resumes without restart
**Watch**:
- OAuth URL leaking query params in the channel message (should be delivered fully, but logs must redact — see R9)
- `auth_required` message not reaching the channel (channel.send() swallowed the error, see R8)
- Bridge polling the token database at >1s intervals causing long latency
- Original call not retried after auth completes (waits forever)
- Multiple `auth_required` notifications sent for one call

#### R3. Inline OAuth — remote mode (paste redirect URL)
**Tags**: bridge auth remote mode, `submitAuthCode`, `correlation_id`
**Setup**: gdrive mount, no token, simulate SSH/headless by disabling localhost callback; `mode: "remote"` flow
**User query**: `List gdrive root.`
**Expected turn**:
  1. Bridge sends `auth_required` with `mode: "remote"`, `instructions`, and a `correlation_id`
  2. Channel shows the auth URL PLUS the instructions (stripped of query params in logs but full URL in the channel message)
  3. User completes OAuth in a browser on another machine → gets the final redirect URL
  4. User pastes the redirect URL into the TUI
  5. Channel adapter forwards via `transport.submitAuthCode(redirectUrl, correlationId)` — correlation_id must match the one from the notification
  6. Bridge validates, stores the token, retries, succeeds, sends `auth_complete`
**Verify**: TUI shows the full flow; `$KOI_HOME/.config/nexus-fs/tokens.db` populated after pasting
**Pass**: remote OAuth works without localhost callback access
**Watch**:
- `correlation_id` not propagated → stale paste accepted
- Paste handler echoing the URL into the conversation visibly after submission (should be consumed silently)
- Validation regex rejecting valid redirect URLs
- Timeout between `auth_required` and paste not surfaced to user (they think it froze)

#### R4. Stale correlation_id rejection
**Tags**: bridge auth remote mode security, replay protection
**Setup**: trigger an R3 flow, then abort it (close the TUI before pasting). Reopen TUI, trigger a new OAuth flow, and attempt to paste the FIRST redirect URL with the FIRST correlation_id
**Expected**: bridge rejects the stale paste; new flow's `correlation_id` is the only valid one; user sees an error and is prompted to use the new URL
**Verify**: bridge log / capture shows the rejection
**Pass**: stale URLs cannot be reused to poison a subsequent auth attempt
**Watch**: bridge accepting the stale URL (CSRF-class bug); rejection producing a crash instead of an error; error message leaking the expected correlation_id

#### R5. Auth failure on one mount does not block other mounts
**Tags**: serial call queue, per-mount auth isolation, fs-nexus multi-mount
**Reference**: behavior verified in `packages/lib/fs-nexus/src/local-transport.test.ts:444` ("local mount call succeeds after gdrive auth failure resolves (serial ordering)")
**Setup**: two mounts — `local:///ws` and `gdrive://my-drive`; gdrive auth will time out (no token + no user interaction)
**User query**: `Read /gdrive/secret.txt and then read /ws/README.md.`
**Expected turn sequence** (serial, per the test):
  1. Agent issues the gdrive read → bridge sends `auth_required` → user ignores it → auth times out with `AUTH_REQUIRED`/`-32007` error
  2. Agent receives the gdrive error → continues to the next tool call
  3. Agent issues the local read → succeeds
**Verify**: trajectory shows gdrive call failed with `AUTH_REQUIRED`, then local call succeeded in the same session
**Pass**: the local call completes even though the gdrive call is still "in-flight waiting for auth" OR already errored; no deadlock
**Watch**: bridge call queue deadlocking; local call failing because the transport is in an errored state; partial recovery where only the first post-error call works

#### R6. Token persistence across sessions
**Tags**: nexus-fs token store, session restart
**Setup**: complete R2 successfully so a real token exists in `$KOI_HOME/.config/nexus-fs/tokens.db` (per-tester isolated root)
**Action**: kill the TUI and Nexus tmux sessions; relaunch both
**User query**: `Read my gdrive root again.`
**Expected**: NO `auth_required` notification; operation succeeds immediately
**Verify**: trajectory shows a single successful read with no auth events
**Pass**: token is reused across runtime restarts
**Watch**: token DB being cleared on TUI shutdown; token re-generation request even with a valid token; token expiry check racing with in-flight calls

#### R7. `auth_progress` heartbeat delivery
**Tags**: `auth_progress` notification, channel heartbeat
**Setup**: scripted fake bridge that delays `auth_complete` by 30+ seconds and emits `auth_progress` every 5s
**User query**: any read against the gdrive mount
**Expected**: channel receives 5-6 `auth_progress` messages with elapsed seconds before `auth_complete`
**Verify**: TUI capture shows the progress messages in order with increasing elapsed times
**Pass**: progress messages arrive without blocking the agent loop
**Watch**: progress flood overwhelming the channel; out-of-order elapsed values; TUI not rendering subsequent updates (stale buffer)

#### R8. Channel delivery failure for `auth_required`
**Tags**: error recovery, OAuth URL redaction in logs, `createAuthNotificationHandler` error handler
**Setup**: wrap the channel adapter to force `channel.send()` to reject for the first call; bridge sends `auth_required`
**Expected**:
  - Handler swallows the rejection (per `auth-notifications.ts` lines 55-64)
  - Error logged to stderr in the form `Failed to deliver auth_required for <provider>: <err>. User will not see the authorization link (redacted: <origin/path>)`
  - The logged URL must be **redacted** — origin + path only, no query params
**Verify**: stderr capture contains the exact error template; grep the stderr for `?` inside the redacted URL (should find none in the redacted portion)
**Pass**: bridge reader loop does not crash; user sees nothing but stderr has an actionable diagnostic
**Watch**: unredacted URL in stderr leaking anti-CSRF state or account identifiers; reader loop exiting on the swallowed rejection; second `auth_required` in the same session never delivered

#### R9. OAuth URL redaction on logging paths
**Tags**: URL redaction (`redactUrl`), log hygiene
**Setup**: any path that logs an OAuth URL (R8 + internal debug logging)
**Verify**: every logged OAuth URL shows only `${origin}${pathname}` — no `?` and no `#`
**Pass**: no query params or fragments ever appear in logs
**Watch**: stack traces printing the raw URL; middleware extracting the URL to separate log fields without redaction; telemetry sinks receiving the unredacted URL

#### R10. Bridge process crash recovery
**Tags**: Python bridge lifecycle, transport resilience
**Setup**: any active mount; running session
**Action** (out of band): kill only your own tester's bridge subprocess — do NOT use an unscoped `pkill -f bridge.py` because other testers on the same machine share the pattern.
```bash
# Find bridge children parented to your TUI tmux session's bun process.
KOI_PID=$(tmux list-panes -t "$KOI_SESSION" -F '#{pane_pid}')
BRIDGE_PIDS=$(pgrep -P "$(pgrep -P "$KOI_PID" 2>/dev/null | head -1)" -f 'bridge.py' 2>/dev/null || true)
if [ -n "$BRIDGE_PIDS" ]; then kill $BRIDGE_PIDS; fi
```
If `pgrep -P` does not reliably find the bridge child on your platform, scope manually with `ps -o pid,ppid,command` starting from `$KOI_PID`. Never run `pkill -f 'fs-nexus.*bridge.py'` unscoped — it will kill every tester's bridge.
**User query**: `Read README.md from the local mount.`
**Expected**: the transport detects the dead subprocess, surfaces a clean error, and either re-spawns the bridge OR reports a terminal failure with a clear message (confirm which behavior is current)
**Verify**: no zombie Python processes; no half-open file descriptors
**Pass**: deterministic behavior (either clean recovery or clean failure) — never a hang
**Watch**: hanging the turn waiting for the dead bridge; respawn loop that burns CPU; stdin buffer bleeding between old and new bridge

#### R11. Gmail connector (OAuth-based, read-only path)
**Tags**: gmail:// connector, nexus-fs OAuth parity
**Setup**: `mountUri: "gmail://my-inbox"` with no token
**User query**: `List the 5 most recent emails in my inbox.`
**Expected**: inline OAuth flow fires (R2 path); on completion, the agent reads gmail data and reports subjects/senders
**Verify**: trajectory shows the same `auth_required` → `auth_complete` pattern as gdrive
**Pass**: the OAuth flow is connector-agnostic — gmail works identically to gdrive
**Watch**: gmail-specific error codes not mapped to `AUTH_REQUIRED`; scope mismatch (requesting drive scope for gmail, or vice versa); rate limits on the gmail API not surfaced as retryable errors

#### R12. Concurrent operations across mounts serialize correctly
**Tags**: fs-nexus serial call queue, multi-mount concurrency
**Setup**: local + gdrive mounts, both pre-authed
**User query**: `In parallel, read 5 files from the local mount and list 5 files from gdrive.`
**Expected**: agent issues multiple tool calls; the transport serializes them (per the queue comment in local-transport.test.ts) but ordering is stable
**Verify**: trajectory shows the calls interleaved in time but each call completes before the next starts on the transport layer
**Pass**: no cross-contamination of responses; no hang; error in one call does not poison others
**Watch**: response correlation by `id` not working under load; queue holding a slot after a call errors; backpressure not applied when the queue grows

#### R13. Config validation for mount URIs
**Tags**: `validate-config`, config error surfacing
**Setup**: config with a malformed mount URI (e.g., `"not-a-uri"`, `"gdrive://"` with empty account, `"file:///"` with traversal like `../..`)
**Action**: start the TUI
**Expected**: startup fails fast with a clear error message pointing at the bad URI; no bridge process started
**Verify**: `validate-config.test.ts` patterns apply; no orphan Python process after failed startup
**Pass**: invalid configs never reach the bridge
**Watch**: path traversal reaching the bridge; empty mount silently ignored; error message leaking filesystem layout

---

### Group N — Sandbox (macOS Seatbelt)

*Skip this group on Linux until the Linux backend ships.*

#### N1. Sandbox blocks forbidden write
**Tags**: sandbox-os Seatbelt, exec-sandbox
**Setup**: Seatbelt profile denies writes outside project root
**User query**: `Write a file at /etc/koi-test that says "bad".`
**Expected**: sandbox denies the write; agent reports the denial
**Verify**: `/etc/koi-test` does NOT exist
**Pass**: operation blocked at the sandbox layer, not just the permissions layer
**Watch**: sandbox not enforcing on subshells; symlink escape; sandbox layer crashing the whole process

#### N2. Sandbox allows permitted writes
**Tags**: sandbox-os allowed paths
**User query**: `Write "ok" to $FIXTURE/output.txt.`
**Expected**: write succeeds (within allowed scope)
**Pass**: permitted ops work normally; no false denials
**Watch**: tilde expansion breaking scope rules; symlinks through allowed paths not resolved

#### N3. Sandbox applies to subagents
**Tags**: sandbox inheritance for subagents
**User query**: `Spawn a subagent and have it write to /etc/koi-test.`
**Expected**: subagent's write is also blocked
**Pass**: sandbox is inherited, not process-scoped
**Watch**: subagents escaping parent sandbox via fresh spawn

---

### Group O — CLI modes

#### O1. Single-prompt mode via `start --prompt`
**Tags**: cli, start command, harness, channel-cli, single-prompt StartMode
**Action** (NOT in TUI — run directly in a normal shell):
```bash
bun run packages/meta/cli/src/bin.ts start --prompt "What is 2 + 2?"
```
**Expected**: one turn runs, the answer is printed on stdout, process exits with code 0
**Pass**: works without the TUI; stdout is the plain answer; no ANSI escape codes in stdout
**Watch**: hanging waiting for TTY; partial output; wrong exit code; `--prompt ""` silently falling back to interactive mode (should be rejected by the parser with a clear error)

#### O2. Manifest override via `--manifest`
**Tags**: cli flags, manifest loading, config precedence
**Action**:
```bash
bun run packages/meta/cli/src/bin.ts start --manifest /tmp/override.koi.yaml --prompt "hello"
```
**Expected**: `start` loads the override manifest (not the default discovery chain) and runs the prompt against it
**Pass**: override takes effect; startup output mentions the path when verbose
**Watch**: silent fallback to default manifest on load failure; relative paths not resolved from cwd; `--config` accepted as an alias (it should NOT exist — the real flag is `--manifest`)

#### O3. CLI subcommand dispatch
**Tags**: cli command registry, help text
**Action**: run `bun run packages/meta/cli/src/bin.ts --help` and execute each documented subcommand from the help output with `--help`: `init`, `start`, `serve`, `tui`, `sessions`, `logs`, `status`, `doctor`, `stop`, `deploy`, `plugin`.
**Expected**: each command prints its own help and exits 0; no unknown-command errors
**Pass**: no crashes on `--help`; help text matches actual parser flags
**Watch**: subcommand argument parsing off-by-one; help text stale vs actual flags; any command name in the help that the parser rejects as unknown

---

### Group P — Observability

#### P1. ATIF trajectory completeness via golden recording
**Tags**: event-trace ATIF v1.6, runtime golden recorder
**Note**: interactive sessions do NOT persist ATIF trajectories to disk — they are kept in memory by `event-trace` and discarded on TUI exit. The only reliable way to inspect a full ATIF document today is to run the runtime golden-query recorder.
**Action**:
```bash
# Produce or refresh a golden trajectory file (real LLM + real tools).
OPENROUTER_API_KEY=... bun run packages/meta/runtime/scripts/record-cassettes.ts --query simple-text
# Then inspect:
jq . packages/meta/runtime/fixtures/simple-text.trajectory.json | less
```
**Verify** (against the produced `<query>.trajectory.json`):
- `jq '.steps | length'` > 5
- trajectory contains MCP lifecycle steps (if MCP is wired into the query config), middleware spans, model steps, tool steps, hook steps
- document is valid ATIF v1.6 per the schema in `@koi/event-trace`
**Pass**: trajectory is a valid ATIF v1.6 document with all expected step categories
**Watch**: missing span parents; overlapping timestamps; tool result missing; event ordering violated; non-monotonic timestamps (see closed #1558 for a prior regression in this area)

#### P2. Golden query replay determinism
**Tags**: event-trace + runtime golden query replay
**Action**: run the existing runtime golden query replay tests:
```bash
bun test --filter=@koi/runtime
```
**Expected**: all golden queries pass; trajectories match fixtures
**Pass**: replay tests pass without network or LLM access
**Watch**: non-determinism creeping in; fixture drift; cassette version mismatch

---

### Group Q — Resilience & edge cases

#### Q1. Interrupt mid-tool
**Tags**: agent-runtime cancellation, TUI interrupt handling
**User query**: `Run 'sleep 60 && echo done' in bash.`
**Action**: while the tool is running, send Ctrl+C in the TUI
**Expected**: current tool call aborts cleanly; agent turn returns with interrupted status
**Verify**: `ps aux | grep 'sleep 60'` is empty
**Pass**: clean interrupt; no zombie processes
**Watch**: interrupt killing the whole TUI; agent reporting completion of an interrupted tool

#### Q2. Malformed tool input
**Tags**: tools-core validate-tool-args, query-engine ensureToolResultPairing
**Setup**: this requires provoking the model to produce malformed args (e.g., via an ambiguous query)
**User query**: `Edit src/math.ts to rename 'add' to 'sum' everywhere.`
**Expected** (sometimes model produces invalid edit args): validator rejects → agent retries with corrected args
**Pass**: agent self-corrects; invalid tool call does not crash the turn
**Watch**: validation error not surfaced to the model for correction; tool-result pairing breaking

#### Q3. Model stream disconnect mid-turn
**Tags**: query-engine stream error handling
**Setup**: use a mock adapter (or briefly disconnect the network) to simulate stream failure
**User query**: any multi-sentence question
**Expected**: partial output rendered; agent reports the stream error and offers to retry
**Verify**: trajectory shows a stream-error event
**Pass**: clean error state; resume works
**Watch**: half-buffered output left on screen; session state inconsistent; TUI hang

#### Q4. Config hot-reload (if shipped)
**Tags**: config hot-reload
**Action**: while the TUI is running, edit the config file (e.g., change the system prompt)
**Expected**: next turn uses the new prompt
**Pass**: hot-reload works for non-stateful fields; stateful changes warn clearly
**Watch**: stale config persisting; validation errors crashing the running session

#### Q5. Very large file operations
**Tags**: read/edit tool size limits, tail-window behavior under large tool_result
**Setup**: create a 10MB file in `$FIXTURE/bigfile.txt`
**User query**: `Read $FIXTURE/bigfile.txt and tell me how many lines it has.`
**Expected**: the `fs_read` tool enforces a max size (or paginates) and returns a bounded payload; the agent answers based on what it can see. The TUI does NOT prune the tool_result via a compactor — the only guard is whatever the `fs_read` tool itself applies.
**Pass**: no OOM; no TUI hang; transcript append succeeds; answer is at least roughly directional
**Watch**: silent truncation without warning; memory blow-up; streaming blocked; transcript JSONL write failing on oversized entry; tool_result that exceeds the model's own context limit (there is no compactor to save you — file a `missing-coverage` issue for TUI-side tool-output pruning if this bites you)

---

## 4. Coverage Matrix

| Subsystem (Phase) | Scenarios that exercise it |
|---|---|
| query-engine turn loop | A1, A2, B1, F1, Q3 |
| tool-execution orchestration | B1, B2, C1, Q2 |
| tools-core validate-tool-args | Q2 |
| tools-builtin read | B1, B2 |
| tools-builtin write | B3, M1, M2, N2 |
| tools-builtin edit | B2, E2 |
| tools-builtin glob | B2 |
| tools-builtin grep | B2 |
| tools-builtin plan-mode (`EnterPlanMode`/`ExitPlanMode`) | **not wired in TUI** — covered only via `bun test --filter=@koi/tools-builtin` (see H3 note) |
| tools-builtin `AskUserQuestion` tool | **not wired in TUI** — covered only via `bun test --filter=@koi/tools-builtin`. Permission prompts in TUI use the runtime approval UI (E2), not this tool. |
| tools-builtin `TodoWrite` tool | **not wired in TUI** — the TUI registers `task_*` tools from `@koi/task-tools` instead. Cover via `bun test --filter=@koi/tools-builtin`. |
| `@koi/task-tools` (`task_create`, `task_get`, `task_update`, `task_list`, `task_stop`, `task_output`) | J1, J2 |
| tools-bash | C1, C2, C3, E3, Q1 |
| bash-security | C2 |
| tools-web web-fetch | D1, D2 |
| tools-web url-policy | D2 |
| tools-web web-search | **not wired in TUI runtime** — covered only via `bun test --filter=@koi/tools-web` (see D3 note) |
| lsp tool | **not wired in TUI today** — cover via `bun test --filter=@koi/lsp` if that package is in scope for the bash |
| `@koi/tool-notebook` (notebook_read/add_cell/replace_cell/delete_cell) | B4 |
| permissions rule-evaluator | E1, E2, C2 |
| hooks command executor | E3 |
| hooks HTTP executor | E4 |
| hooks prompt executor | (via plugin L2) |
| engine-adapter tail-window slicing (`maxTranscriptMessages`) | F1, F2 |
| `@koi/context-manager` real compaction, token budget, tool-output pruning, protected regions | **not wired in TUI** — covered via `bun test --filter=@koi/context-manager` (see F3) |
| middleware-extraction | K1 |
| mcp stdio transport | G1, G2 |
| mcp HTTP transport | G3 |
| mcp resolver / registry | G1 |
| config loading | A1 |
| config hot-reload | Q4 |
| channel-cli | A1, O1 |
| event-trace ATIF | A1, B2, P1 |
| harness composition | A1, O1 |
| fs-local | M1 |
| fs-nexus local transport | M2, R1, R5, R10, R12 |
| fs-nexus Python bridge | M2, R2, R3, R7, R8, R10 |
| fs-nexus multi-mount (mountUri array) | R1, R5, R12 |
| fs-nexus bridge auth notifications (auth_required) | R2, R3, R7, R8 |
| fs-nexus bridge auth notifications (auth_complete) | R2, R3, R7 |
| fs-nexus bridge auth notifications (auth_progress) | R7 |
| fs-nexus remote OAuth mode (submitAuthCode + correlation_id) | R3, R4 |
| fs-nexus OAuth URL redaction (redactUrl) | R8, R9 |
| fs-nexus token persistence (tokens.db) | R6, R11 |
| fs-nexus connectors: gdrive | R1, R2, R5, R6 |
| fs-nexus connectors: gmail | R11 |
| fs-nexus serial call queue | R5, R12 |
| fs-nexus config validation | R13 |
| dual-backend filesystem (manifest-driven routing) | M3 |
| file-resolution | M1, M2, M3 |
| agent-runtime subagent spawn | H1, H2 |
| agent-runtime inheritance | H1, H3 |
| session JSONL transcript | A1, A2, K2 |
| session resume | A2 |
| memory storage | K1 |
| memory retrieval | K2 |
| memory-team-sync filter | K3 |
| dream (if invoked) | (add scenario if shipped) |
| tasks CRUD | J1 |
| tasks state machine | J2 |
| task-board TUI | J3 |
| skills-runtime loader | I1 |
| skills-runtime execution | I2 |
| skill-scanner | I3 |
| skill-tool | I2 |
| plugins loader | L1 |
| plugins lifecycle | L1, L2 |
| plugins + hooks integration | L2 |
| sandbox-os Seatbelt | N1, N2 |
| sandbox inheritance | N3 |
| cli command registry | O3 |
| cli single-prompt mode (`start --prompt`) | O1 |
| cli manifest override (`start --manifest`) | O2 |
| tui rendering | A1, B2, J3 |
| tui interrupt (Ctrl+C) | Q1, C3 |
| tui streaming | C1, Q3 |

> Rows with `(add scenario if shipped)` indicate subsystems that are in the plan but where the current scenario set doesn't have dedicated coverage. Add scenarios during the bash if those subsystems are in scope for your run.

---

## 5. Exit Criteria

The bug bash is done when:

1. **All Group A–Q and R scenarios have been run at least once by one tester.** Groups H, M, and R are primarily `bun test` suites because the TUI does not expose subagent spawning, fs-nexus, or the bridge auth flow. Groups K–Q (context, MCP, skills, tasks, memory, plugins, filesystem, sandbox, CLI modes, observability, resilience) are REQUIRED — they cannot be skipped. Any group the tester chooses to mark out-of-scope must be justified in the post-bash summary with a `missing-coverage` issue link.
2. **All P0/blocker bugs filed have been either fixed or triaged** with an owner and a target release.
3. **Coverage matrix shows every shipped subsystem has at least one green scenario**.
4. **No subsystem is in "unknown state"** — every row either passed, is a known bug, or is explicitly out of scope for this bash.
5. **Replay tests (`bun test --filter=@koi/runtime`)** all pass on the candidate commit.
6. **A written summary** is posted as a comment on the bug bash tracking issue with:
   - Count of scenarios run
   - Count of bugs filed by severity
   - List of unexercised subsystems and why
   - Go / no-go recommendation for the release candidate

---

## 6. Tester Assignment Template

When multiple testers run in parallel, divide by group to avoid stepping on each other's state:

| Tester | Groups | `TESTER_ID` | Tmux session prefix |
|---|---|---|---|
| T1 | A, B, C | `t1` | `<worktree>-t1-…` |
| T2 | D, E, F | `t2` | `<worktree>-t2-…` |
| T3 | G, H (test suite), I | `t3` | `<worktree>-t3-…` |
| T4 | J, K, L | `t4` | `<worktree>-t4-…` |
| T5 | M (test suite), N, O | `t5` | `<worktree>-t5-…` |
| T6 | P, Q | `t6` | `<worktree>-t6-…` |
| T7 | R (test suite for fs-nexus connectors + OAuth) | `t7` | `<worktree>-t7-…` |

> Each tester sets `TESTER_ID` per §1.3 so `$NAMESPACE` is unique. Groups H, M, R are primarily `bun test` suites in this plan — the TUI does not expose subagent spawning, fs-nexus, or the bridge auth flow. The tester assigned to those groups runs tests and files coverage gaps instead of interactive turns.

Each tester uses their own worktree copy (via `git worktree add`) to avoid filesystem and tmux contention.

---

## 7. Appendix — Quick verification cheatsheet

```bash
# All commands below assume §1.3 envs are exported: KOI_HOME, WORKTREE, TESTER_ID, etc.
# DO NOT use `ls -t ~/.koi/sessions/*.jsonl | head -1` — that resolves to the REAL
# user HOME (not the isolated $KOI_HOME) and races against other testers.
# Using `ls -t` inside $KOI_HOME is safe because each tester has a private HOME
# per §1.6 (HOME=$KOI_HOME).

# Newest transcript in this tester's isolated sessions dir (post §1.7 reset)
SESSION_FILE=$(ls -t "$KOI_HOME/.koi/sessions"/*.jsonl 2>/dev/null | head -1)

# Tail the current tester's transcript (flat file, per-tester HOME)
tail -f "$SESSION_FILE"

# Role histogram (user / assistant / tool_call / tool_result / system / compaction)
jq -r '.role' "$SESSION_FILE" | sort | uniq -c

# Count tool calls
jq -c 'select(.role=="tool_call")' "$SESSION_FILE" | wc -l

# Extract all tool_result entries that look like errors
jq -c 'select(.role=="tool_result" and (.content | test("error|denied|failed"; "i")))' "$SESSION_FILE"

# ATIF trajectory is in-memory during interactive sessions (no on-disk file).
# To inspect a trajectory, use the runtime golden recorder:
#   bun run packages/meta/runtime/scripts/record-cassettes.ts --query <name>
#   jq . packages/meta/runtime/fixtures/<name>.trajectory.json
# Or run the replay tests (deterministic, no network):
bun test --filter=@koi/runtime

# Verify no orphan processes
pgrep -fa koi
pgrep -fa bun

# Clean TUI session hard
tmux kill-session -t "$KOI_SESSION" 2>/dev/null
```

---

**Last updated**: Phase 2 bug bash plan, prepared alongside issues #1622–#1654.
**Feedback**: file issues labeled `bug-bash` so they're easy to group for the post-bash summary.
