# Phase 2 Bug Bash — E2E Test Plan

> Scenario-based end-to-end test plan covering every shipped Phase 1 and Phase 2 subsystem.
> All scenarios run through the TUI via tmux (not raw CLI) so TUI-side bugs are also surfaced.

**Scope**: shipped Phase 1 + Phase 2 features. New issues (#1622–#1654) are out of scope.
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

### 1.3 Worktree-prefixed tmux sessions (mandatory)

All tmux session names must be prefixed with the worktree slug. This is mandatory when running in parallel with other agents.

```bash
export WORKTREE=$(basename "$PWD")   # e.g. "polished-painting-hummingbird"
export KOI_SESSION="${WORKTREE}-koi"
export NEXUS_SESSION="${WORKTREE}-nexus"
export BASH_SESSION="${WORKTREE}-bash"  # for out-of-band verification commands
```

### 1.4 Start Nexus (for backend-dependent scenarios)

```bash
# Start Nexus in a tmux session so logs are capturable
tmux new-session -d -s "$NEXUS_SESSION" 'docker run --rm -p 8000:8000 <nexus-image>:<tag>'
tmux capture-pane -t "$NEXUS_SESSION" -p | tail -20
# Verify: curl -s http://localhost:3100/admin/api/health
```

### 1.5 Launch Koi TUI

```bash
tmux new-session -d -s "$KOI_SESSION" 'bun run packages/meta/cli/src/bin.ts up'
sleep 2
tmux capture-pane -t "$KOI_SESSION" -p | tail -30
```

### 1.6 Test fixture project

Every scenario runs against a fixture project. Create it fresh at the start of the bug bash:

```bash
export FIXTURE=/tmp/koi-bugbash-fixture
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

### 1.7 Reset between scenarios

```bash
# Kill and relaunch the TUI (cleanest reset)
tmux kill-session -t "$KOI_SESSION" 2>/dev/null
cd "$FIXTURE" && git reset --hard -q && git clean -fdq && cd - >/dev/null
tmux new-session -d -s "$KOI_SESSION" "cd $FIXTURE && bun run $OLDPWD/packages/meta/cli/src/bin.ts up"
sleep 2
```

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
tmux capture-pane -t "$KOI_SESSION" -pS -3000 > /tmp/koi-capture.txt
```

### 2.4 Finding the session transcript

Session JSONL files live under `~/.koi/sessions/<session-id>/` (confirm the exact path from the TUI startup banner). Use:

```bash
SESSION_ID=$(ls -t ~/.koi/sessions | head -1)
SESSION_DIR=~/.koi/sessions/$SESSION_ID
ls "$SESSION_DIR"
jq -c . "$SESSION_DIR"/*.jsonl | tail -20
```

### 2.5 Finding the ATIF trajectory

Event-trace emits an ATIF trajectory for each session. Inspect with:

```bash
jq . "$SESSION_DIR/trajectory.json" 2>/dev/null | less
```

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
**TUI capture**: <paste or attach /tmp/koi-capture.txt>
**Session transcript**: <attach $SESSION_DIR/*.jsonl>
**Trajectory**: <attach trajectory.json>
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
**Verify**:
- `grep -c '"kind":"model_chunk"' "$SESSION_DIR"/*.jsonl` > 0
- `grep -c '"kind":"tool_call"' "$SESSION_DIR"/*.jsonl` == 0
- trajectory.json has exactly 2 turns
**Pass**: both turns complete without tool calls; TUI renders incremental tokens
**Watch**: duplicated tokens in TUI; missing final newline; ANSI color bleeding; cursor artifacts on reflow

#### A2. Session resume after exit
**Tags**: session, cli, tui, harness
**Prereqs**: complete A1 first; note the session ID
**Action**: kill and relaunch the TUI with `--resume <session-id>` (or equivalent flag — confirm from `koi --help`)
**User query**: `What did we just talk about?`
**Expected**: agent references the previous turn's content (Bun / TypeScript)
**Verify**: session JSONL has both pre-exit and post-resume messages in order
**Pass**: resumed context is coherent; no duplicated system prompt
**Watch**: lost conversation history; duplicated system prompt; ID collision; file lock errors

---

### Group B — Core file I/O

#### B1. Read a file
**Tags**: tools-builtin/read, tool-execution, event-trace
**Prereqs**: fixture project at cwd
**User query**: `Show me the contents of src/math.ts`
**Expected turn**: agent calls `read` tool → returns file content → summarizes
**Follow-up**: `What functions does it export?`
**Expected**: agent answers `add` and `multiply` (from previous tool result in context)
**Verify**: `grep '"tool":"read"' "$SESSION_DIR"/*.jsonl` shows exactly 1 call in the first turn
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

---

### Group C — Bash & security

#### C1. Bash with allowed command
**Tags**: tools-bash, bash-security, bash-tool streaming, tool-execution
**User query**: `Run 'bun test' in the fixture project and tell me the result.`
**Expected turn**: bash tool runs; agent reports pass/fail
**Verify**: trajectory.json shows bash tool call with exit code 0
**Pass**: command output streams live into TUI (not buffered)
**Watch**: output buffering; ANSI color mangling; SIGPIPE errors; timing out on quick commands

#### C2. Bash with denied pattern
**Tags**: bash-security deny-list, permissions denial path, tool-execution error handling
**Setup**: configure a deny rule for `rm -rf /` in the local config
**User query**: `Delete everything in /tmp/some-dir and recreate it with a README.`
**Expected turn**: bash tool call blocked before execution; agent receives a denial and chooses a safer alternative (e.g., asks for confirmation or narrows scope)
**Verify**: `grep '"denied"' "$SESSION_DIR"/*.jsonl` shows the deny event; fixture unchanged
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
**Verify**: `grep 'ssrf\|blocked' "$SESSION_DIR"/*.jsonl`
**Pass**: no outbound request; agent explains that link-local addresses are blocked
**Watch**: IPv6-mapped addresses not blocked; DNS rebinding; redirect chain not checked; localhost/loopback slipping through

#### D3. Web search
**Tags**: tools-web/web-search, builtin-search-provider
**User query**: `Search the web for "OpenTelemetry GenAI semantic conventions 2026" and summarize the top 3 results.`
**Expected turn**: web-search returns results; agent produces a summary with citations
**Verify**: trajectory shows web-search tool call with results array
**Pass**: results are present; summary cites URLs
**Watch**: hallucinated URLs; empty results not handled; rate limiting breaking the turn

---

### Group E — Permissions & hooks

#### E1. Permission allow-list match
**Tags**: permissions rule-evaluator, classifier
**Setup**: config with `tools.bash.allow: ["bun test", "bun run build"]`
**User query**: `Run the tests.`
**Expected**: bash runs `bun test` without prompt (allow-list match)
**Pass**: no approval prompt; tool executes

#### E2. Permission ask-list triggers prompt
**Tags**: permissions, ask-user tool, channel-cli
**Setup**: permission rule with `verdict: 'ask'` on `edit` tool
**User query**: `Fix the typo in README.md (change 'Fixture' to 'Fixtures').`
**Expected**: TUI prompts for approval before the edit; user approves; edit applies
**Verify**: session JSONL shows `permission.asked` then `permission.granted`
**Pass**: approval prompt appears in TUI; user input accepted
**Watch**: prompt hanging the agent loop; double-prompting; approval not persisted within session

#### E3. Pre-tool-use command hook
**Tags**: hooks (command executor), hooks lifecycle, hook-prompt
**Setup**: hook config that runs `echo "pre-tool-use: $TOOL_NAME" >> /tmp/hook-log.txt` before every tool call
**User query**: `Read src/math.ts and then write a summary to /tmp/summary.txt.`
**Expected**: both tool calls fire; hook log captures both
**Verify**: `cat /tmp/hook-log.txt` shows at least 2 entries with tool names
**Pass**: hook fires in correct order; agent loop not blocked by hook
**Watch**: hook output leaking into agent context; hook failures crashing the turn; env var not set

#### E4. HTTP hook receives event
**Tags**: hooks HTTP executor, event serialization
**Setup**: start a simple HTTP listener: `python3 -m http.server 9999 &` or similar; configure hook to POST to it
**User query**: `Read README.md`
**Expected**: HTTP listener receives a POST with the tool event payload
**Verify**: listener log shows inbound POST with correct JSON
**Pass**: event shape is stable, documented, backward-compatible
**Watch**: sensitive data leaking in the event body; blocking the agent on a slow hook

---

### Group F — Context & compaction

#### F1. Long conversation triggers compaction
**Tags**: context-manager, middleware-compactor (if shipped as separate middleware), token budget, middleware-extraction
**Setup**: lower the compaction threshold via config to force early compaction (e.g. 10k tokens)
**User queries**: paste a long file (e.g. `cat packages/lib/query-engine/src/turn-runner.ts`) into the conversation, then ask 10+ short questions about it
**Expected**: at some point the TUI or logs indicate compaction fired
**Follow-up**: `What was the function name you saw earlier?`
**Expected**: agent still recalls the key fact (summary preserved it)
**Verify**: session JSONL contains at least one `compaction` event; message count drops after compaction
**Pass**: compaction does not lose the most recent turns or the system prompt
**Watch**: pruning user's current question; dropping tool calls mid-sequence; prompt cache invalidated unnecessarily

#### F2. Tool output truncation
**Tags**: context-manager tool-output pruning
**User query**: `Run 'find / -type f 2>/dev/null | head -5000' and tell me how many files.`
**Expected**: tool output truncated in context; agent still reports correct count (from last line of tool output)
**Verify**: session JSONL shows truncation marker in the historical message
**Pass**: recent turn sees the real output; old turns have truncated placeholder
**Watch**: truncation cutting off the last line (the answer); off-by-one in windowing

#### F3. System prompt preserved across compaction
**Tags**: context-manager protected regions
**Setup**: force compaction (as in F1)
**User query** (after compaction): `What is your name?` (something that would be in the system prompt)
**Expected**: answer consistent with system prompt
**Pass**: system prompt is intact after compaction
**Watch**: system prompt getting summarized away; role confusion

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

#### H1. Spawn general-purpose subagent
**Tags**: agent-runtime, subagent spawn, inheritance, task tool (if that's the entry)
**User query**: `Use a subagent to investigate how the permissions package classifies rules, and report back.`
**Expected turn**: parent agent spawns a subagent with a focused prompt; subagent explores; returns a summary
**Verify**: trajectory shows parent + child agent events, distinguishable by agent-id
**Pass**: child finishes, parent receives result, parent incorporates into its answer
**Watch**: child inheriting too much scope (permission leak); child not inheriting enough (can't do its job); infinite spawn loop

#### H2. Parallel subagents
**Tags**: agent-runtime concurrent spawn, result aggregation
**User query**: `Spawn 3 subagents in parallel: one to count files in src/, one to count files in test/, one to count files in docs/. Aggregate the results.`
**Expected**: 3 child agents spawn concurrently; parent waits and aggregates
**Verify**: timestamps show overlapping execution; 3 distinct child session entries
**Pass**: parallel execution genuinely overlaps; aggregation arithmetic correct
**Watch**: serialization-as-parallel (one at a time); race conditions in shared state; child crashes pulling down parent

#### H3. Plan mode (read-only enforcement)
**Tags**: plan-mode tool, permissions scoping
**User query**: enter plan mode (via the plan-mode tool); then `Plan how to add a divide function to src/math.ts.`
**Expected**: agent produces a plan; cannot edit files while in plan mode
**Attempt**: while still in plan mode, ask `Go ahead and edit the file to add it.`
**Expected**: edit tool is denied (plan mode is read-only); agent surfaces the denial to the user and asks to exit plan mode first
**Verify**: no writes to src/math.ts in the fixture
**Pass**: plan mode is honored; agent provides clear error
**Watch**: plan mode leaking writes via bash (`echo >>`); plan mode persisting after exit; plan-mode exit tool missing

---

### Group I — Skills

#### I1. Skill discovery from disk
**Tags**: skills-runtime loader, skill-tool
**Setup**: add a skill file under `~/.koi/skills/hello/SKILL.md` with a simple one-line procedure
**User query**: `What skills do you have?`
**Expected**: agent lists available skills including the new one
**Verify**: trajectory shows skill registry populated
**Pass**: new skill discoverable without restart (if hot-reload shipped) or after restart
**Watch**: duplicate skills; skill name collisions; malformed skill files crashing discovery

#### I2. Skill invocation
**Tags**: skill-tool, skills-runtime execution
**User query**: `Use the hello skill.`
**Expected**: agent invokes the skill procedure; output matches skill definition
**Pass**: skill output returned verbatim
**Watch**: skill parameter binding; skill tool schema not matching declared inputs

#### I3. Skill scanner rejects suspicious skill
**Tags**: skill-scanner (security)
**Setup**: add a skill that references a suspicious pattern (e.g., `rm -rf`, exfiltrating env vars)
**User query**: `List skills.`
**Expected**: the suspicious skill is flagged or excluded from the registry with a clear warning
**Verify**: startup log (TUI capture) mentions the skill was rejected
**Pass**: malicious skill does not appear in the runtime registry
**Watch**: scanner false-positives on legitimate skills; scanner bypass via encoding/obfuscation

---

### Group J — Tasks

#### J1. Create task
**Tags**: tasks CRUD, task-tools, tasks lifecycle
**User query**: `Create a task to refactor the multiply function in src/math.ts.`
**Expected**: task created with a unique id; TUI task board shows it in pending state
**Verify**: `jq '.[] | select(.subject | contains("multiply"))' ~/.koi/tasks.json` or equivalent
**Pass**: task visible in TUI task panel

#### J2. Task state transitions
**Tags**: tasks state machine
**User queries**: create a task → mark it in_progress → mark it completed
**Expected**: each transition is valid; invalid transitions (e.g., pending → completed without in_progress) are rejected
**Verify**: trajectory shows the exact sequence of transitions
**Pass**: state machine honors declared valid transitions
**Watch**: allowing invalid transitions; completed tasks reverting to pending silently

#### J3. Task list in TUI
**Tags**: task-board, TUI rendering
**User query**: `Show me all my current tasks.`
**Expected**: TUI renders a task list with status, owner, blocked-by relationships
**Pass**: long lists scroll; filtering by status works
**Watch**: stale display after async updates; sort order unstable

---

### Group K — Memory

#### K1. Memory extraction after turn
**Tags**: middleware-extraction (if shipped), memory storage
**User query**: `My project uses Bun 1.3 and Biome for linting. Also we prefer explicit return types.`
**Expected**: after the turn, memory extraction runs and stores these as facts
**Verify**: `ls ~/.koi/memory` shows entries; `jq . ~/.koi/memory/*.json` shows the facts
**Pass**: facts are stored, not verbatim conversation

#### K2. Memory recall in new session
**Tags**: memory retrieval, relevance matching
**Setup**: K1 must be complete; then reset the TUI session (new session, not resumed)
**User query**: `What do you remember about my project's toolchain?`
**Expected**: agent recalls Bun 1.3, Biome, explicit return types
**Pass**: recall is accurate; agent cites that it's drawing from memory (ideally)
**Watch**: stale memory showing old facts; cross-session bleed of unrelated memories

#### K3. Memory extraction filters sensitive data
**Tags**: memory-team-sync filter, redaction
**User query**: `My OpenAI API key is sk-test-fake-key-12345 and my email is test@example.com.`
**Expected**: memory extraction skips or redacts these
**Verify**: `grep -r 'sk-test-fake' ~/.koi/memory` is empty
**Pass**: no secrets in memory store
**Watch**: partial redaction (key prefix leaking); false negatives (other secret formats)

---

### Group L — Plugins

#### L1. Plugin manifest loads
**Tags**: plugins loader, manifest parsing
**Setup**: add a minimal plugin at `~/.koi/plugins/hello-plugin/plugin.yaml`
**Action**: restart TUI
**Expected**: plugin discovered in startup logs
**Verify**: `tmux capture-pane -t "$KOI_SESSION" -p | grep hello-plugin`
**Pass**: plugin listed as loaded
**Watch**: malformed manifest crashing startup; version mismatch silently ignored

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

#### M2. fs-nexus backend basic operations
**Tags**: fs-nexus backend, Nexus integration
**Setup**: Nexus running (§1.4); config points to nexus backend
**User query**: `Create a file named greeting.txt with content "hi" in my Nexus workspace.`
**Expected**: file written via Nexus API, not local filesystem
**Verify**: Nexus API query confirms file exists; local `/tmp` unchanged
**Pass**: round-trip through Nexus works
**Watch**: silent fallback to local backend on Nexus error; auth header missing

#### M3. Backend switching mid-session
**Tags**: fs-nexus + fs-local coexistence
**Setup**: both backends configured
**User query**: operations that touch both local and Nexus paths
**Expected**: each operation routes to the correct backend based on path prefix or scope
**Pass**: no cross-backend confusion
**Watch**: path resolver picking wrong backend; write appearing on both

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

#### O1. CLI non-interactive pipe
**Tags**: cli, harness, channel-cli, headless one-shot
**Action** (NOT in TUI — run directly):
```bash
echo "What is 2 + 2?" | bun run packages/meta/cli/src/bin.ts run --one-shot
```
**Expected**: one turn, answer printed, exit code 0
**Pass**: works without TUI; no ANSI escape codes in stdout
**Watch**: hanging waiting for TTY; partial output; wrong exit code

#### O2. CLI config override flag
**Tags**: cli flags, config precedence
**Action**:
```bash
bun run packages/meta/cli/src/bin.ts --config /tmp/override.yaml up
```
**Expected**: TUI starts using the override config
**Pass**: override actually takes effect; startup banner shows the path
**Watch**: silent fallback to default config; relative paths not resolved from cwd

#### O3. CLI subcommand dispatch
**Tags**: cli command registry, REPL
**Action**: try each documented subcommand (`up`, `config`, etc.) from `--help`
**Expected**: each command has a clear behavior and exit code
**Pass**: no crashes on `--help`; no undocumented subcommands
**Watch**: subcommand argument parsing off-by-one; help text stale vs actual flags

---

### Group P — Observability

#### P1. ATIF trajectory completeness
**Tags**: event-trace ATIF v1.6, trajectory writer
**Setup**: complete scenario B2 (multi-step workflow)
**Verify**: `jq '.steps | length' "$SESSION_DIR/trajectory.json"` > 5
**Check that trajectory contains**: MCP lifecycle steps (if MCP configured), middleware spans, model steps, tool steps, hook steps
**Pass**: trajectory is a valid ATIF v1.6 document per schema
**Watch**: missing span parents; overlapping timestamps; tool result missing; event ordering violated

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
**Tags**: read/edit tool size limits, context-manager tool-output pruning
**Setup**: create a 10MB file in the fixture
**User query**: `Read /tmp/bigfile.txt and tell me how many lines it has.`
**Expected**: read tool enforces a max size or paginates; agent gets enough info to answer
**Pass**: no OOM; no TUI hang; answer is roughly correct
**Watch**: silent truncation without warning; memory blow-up; streaming blocked

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
| tools-builtin plan-mode | H3 |
| tools-builtin ask-user | E2 |
| tools-builtin todo | J1, J2 |
| tools-bash | C1, C2, C3, E3, Q1 |
| bash-security | C2 |
| tools-web web-fetch | D1, D2 |
| tools-web url-policy | D2 |
| tools-web web-search | D3 |
| lsp tool | (add scenario if shipped) |
| notebook tool | (add scenario if shipped) |
| permissions rule-evaluator | E1, E2, C2 |
| hooks command executor | E3 |
| hooks HTTP executor | E4 |
| hooks prompt executor | (via plugin L2) |
| context-manager compaction | F1, F3 |
| context-manager tool-output pruning | F2, Q5 |
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
| fs-nexus | M2, M3 |
| file-resolution | M1, M2 |
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
| cli one-shot / headless | O1 |
| cli config precedence | O2 |
| tui rendering | A1, B2, J3 |
| tui interrupt (Ctrl+C) | Q1, C3 |
| tui streaming | C1, Q3 |

> Rows with `(add scenario if shipped)` indicate subsystems that are in the plan but where the current scenario set doesn't have dedicated coverage. Add scenarios during the bash if those subsystems are in scope for your run.

---

## 5. Exit Criteria

The bug bash is done when:

1. **All Group A–J scenarios have been run at least once by one tester** (core functionality).
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

| Tester | Groups | Tmux session slug |
|---|---|---|
| T1 | A, B, C | `<worktree>-bb-t1` |
| T2 | D, E, F | `<worktree>-bb-t2` |
| T3 | G, H, I | `<worktree>-bb-t3` |
| T4 | J, K, L | `<worktree>-bb-t4` |
| T5 | M, N, O | `<worktree>-bb-t5` |
| T6 | P, Q | `<worktree>-bb-t6` |

Each tester uses their own worktree copy (via `git worktree add`) to avoid filesystem and tmux contention.

---

## 7. Appendix — Quick verification cheatsheet

```bash
# Tail the session transcript
SESSION_ID=$(ls -t ~/.koi/sessions | head -1)
tail -f ~/.koi/sessions/$SESSION_ID/*.jsonl

# Count tool calls by name
jq -r 'select(.kind=="tool_call") | .tool' ~/.koi/sessions/$SESSION_ID/*.jsonl | sort | uniq -c

# Extract all errors
jq -c 'select(.kind=="error")' ~/.koi/sessions/$SESSION_ID/*.jsonl

# Pretty-print the trajectory
jq . ~/.koi/sessions/$SESSION_ID/trajectory.json | less

# Re-run golden query replay (should always pass on main)
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
