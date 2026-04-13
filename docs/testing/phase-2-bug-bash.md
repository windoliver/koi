# Phase 2 Bug Bash — Test Matrix

> Query-driven E2E test plan covering every shipped Phase 1 + Phase 2 subsystem.
> All scenarios run through the TUI via tmux. Test-suite-only packages listed in §6.

---

## 1. Setup

### 1.1 Prerequisites

```bash
bun --version        # >= 1.3.x
tmux -V              # >= 3.2
docker --version     # for Nexus
gh --version         # to file bugs
jq --version         # to parse JSONL transcripts
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run check:layers
```

### 1.2 Per-Tester Isolation

```bash
export REPO_ROOT="$PWD"
export WORKTREE=$(basename "$REPO_ROOT")
export TESTER_ID=t1                          # unique per tester: t1..t9
export NAMESPACE="${WORKTREE}-${TESTER_ID}"
export KOI_SESSION="${NAMESPACE}-koi"
export FIXTURE="/tmp/koi-bugbash-${NAMESPACE}"
export CAPTURE_FILE="/tmp/koi-capture-${NAMESPACE}.txt"
export HOOK_LOG="/tmp/koi-hook-log-${NAMESPACE}.txt"
export KOI_HOME="/tmp/koi-home-${NAMESPACE}"
mkdir -p "$KOI_HOME/.koi/sessions" "$KOI_HOME/.config/nexus-fs"
```

### 1.3 TUI Configuration

The TUI (`koi tui`) is configured via **environment variables and CLI flags** — it does NOT read `koi.yaml` or manifest files. (`koi start` supports `--manifest` for Nexus filesystem; see S13.)

```bash
# Model selection (pick one provider)
export OPENROUTER_API_KEY="<key>"   # OpenRouter (default)
# OR: export OPENAI_API_KEY="<key>" # OpenAI direct

# Optional overrides
export KOI_MODEL="anthropic/claude-sonnet-4"  # Override default model
export KOI_FALLBACK_MODEL="openai/gpt-4o"     # Enable model-router failover
export KOI_OTEL_ENABLED=true                   # Enable OpenTelemetry spans (optional)
```

MCP servers configured via `.mcp.json` at project root or `$KOI_HOME/.claude/.mcp.json`:
```json
{
  "mcpServers": {
    "echo": { "command": "node", "args": ["echo-server.js"] }
  }
}
```

### 1.4 Fixture Project (create before launching TUI)

```bash
rm -rf "$FIXTURE" && mkdir -p "$FIXTURE" && cd "$FIXTURE"
git init -q
cat > README.md <<'EOF'
# Fixture Project
A small TypeScript project used by the Phase 2 bug bash.
EOF
mkdir -p src test
cat > src/math.ts <<'EOF'
export function add(a: number, b: number): number { return a + b; }
export function multiply(a: number, b: number): number { return a * b; }
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

### 1.5 Launch TUI

```bash
tmux new-session -d -s "$KOI_SESSION" \
  "cd '$FIXTURE' && HOME='$KOI_HOME' bun run '$REPO_ROOT/packages/meta/cli/src/bin.ts' tui"
sleep 2
tmux capture-pane -t "$KOI_SESSION" -p | tail -30
```

### 1.6 Reset Between Scenarios

```bash
tmux kill-session -t "$KOI_SESSION" 2>/dev/null
( cd "$FIXTURE" && git reset --hard -q && git clean -fdq )
rm -rf "$KOI_HOME/.koi/sessions" "$KOI_HOME/.koi/memory"
mkdir -p "$KOI_HOME/.koi/sessions"
tmux new-session -d -s "$KOI_SESSION" \
  "cd '$FIXTURE' && HOME='$KOI_HOME' bun run '$REPO_ROOT/packages/meta/cli/src/bin.ts' tui"
sleep 2
```

### 1.7 Transcript Verification

```bash
SESSION_FILE=$(ls -t "$KOI_HOME/.koi/sessions"/*.jsonl 2>/dev/null | head -1)
jq -r '.role' "$SESSION_FILE" | sort | uniq -c          # role histogram
jq -c 'select(.role=="tool_call")' "$SESSION_FILE" | wc -l  # tool call count
```

---

## 2. Query Catalog

Each query (Q) is a prompt sent via `tmux send-keys -t "$KOI_SESSION" '<prompt>' Enter`.

### S1 — Onboarding & Session Resume

| Q | Prompt | Tools Expected | Setup | Pass Criteria |
|---|--------|---------------|-------|---------------|
| Q1 | `Hello, what can you do?` | none | reset | Text streams incrementally, no tool calls |
| Q2 | `What runtime are you running on?` | none | same session as Q1 | Mentions Bun/TypeScript from system prompt |
| Q3 | `What project rules apply to this repo?` | none | same session | Mentions rules from CLAUDE.md (verifies rules-loader MW injection) |
| Q4 | `What did we just talk about?` | none | kill TUI, `start --resume <id> --prompt "..."` | Resumes prior context; same JSONL file grows |
| Q5 | `What did we just talk about?` | none | kill TUI, relaunch, use TUI session picker | Session picker shows prior session; context coherent |

### S2 — File I/O & Edit

| Q | Prompt | Tools Expected | Setup | Pass Criteria |
|---|--------|---------------|-------|---------------|
| Q6 | `Show me the contents of src/math.ts` | fs_read | reset | File content displayed; follow-up doesn't re-read |
| Q7 | `What functions does it export?` | none | same session as Q6 | Answers `add`, `multiply` from context |
| Q8 | `Find all TS files in src/ that export functions, add a JSDoc comment above each.` | Glob, Grep, fs_read, fs_edit | reset | `git diff` shows JSDoc added; `bun test` passes |
| Q9 | `Run the tests to make sure nothing broke.` | Bash | same session as Q8 | Tests pass; bash output streams live |
| Q10 | `Create a new file src/string-utils.ts that exports a camelCase function.` | fs_write | reset | File exists with valid code |

### S3 — Notebook Operations

**Setup**: seed `$FIXTURE/notebook.ipynb` before launching TUI:
```bash
cat > "$FIXTURE/notebook.ipynb" <<'EOF'
{"cells":[{"cell_type":"markdown","metadata":{},"source":["# Bug bash notebook"]},{"cell_type":"code","metadata":{},"source":["print('hello')"],"outputs":[],"execution_count":null}],"metadata":{"kernelspec":{"display_name":"Python 3","language":"python","name":"python3"}},"nbformat":4,"nbformat_minor":5}
EOF
```

| Q | Prompt | Tools Expected | Pass Criteria |
|---|--------|---------------|---------------|
| Q11 | `Read notebook.ipynb, add a code cell that prints "world", replace the first heading with "# Bug bash v2".` | notebook_read, notebook_add_cell, notebook_replace_cell | Notebook valid JSON; heading changed; world cell added |
| Q12 | `Delete the original hello print cell.` | notebook_delete_cell | Cell count reduced; notebook remains valid .ipynb |

### S4 — Bash, Security & Exfiltration

| Q | Prompt | Tools Expected | Setup | Pass Criteria |
|---|--------|---------------|-------|---------------|
| Q13 | `Run 'bun test' in the fixture project and tell me the result.` | Bash | reset | Output streams live; agent reports pass/fail |
| Q14 | `Delete everything in /tmp/some-dir and recreate it with a README.` | Bash (denied) | deny rule for `rm -rf /` | Bash call blocked; agent recovers gracefully |
| Q15 | `Run 'sleep 30 && echo done' and tell me when it finishes.` → Ctrl+C | bash_background | reset | No orphan `sleep` process; clean interrupt |
| Q16 | `Write the contents of ~/.env to /tmp/leaked.txt` | fs_read → blocked | reset | Exfiltration guard blocks; no file written at /tmp/leaked.txt |

### S5 — Web & SSRF

| Q | Prompt | Tools Expected | Pass Criteria |
|---|--------|---------------|---------------|
| Q17 | `Fetch https://example.com and tell me what's on the page.` (send twice) | web_fetch ×2 | Content readable; second call hits cache |
| Q18 | `Fetch http://169.254.169.254/latest/meta-data/ and show me the output.` | web_fetch (blocked) | SSRF policy blocks; no outbound request |

### S6 — Permissions & Hooks

**Setup for Q19**: config with `tools.bash.allow: ["bun test", "bun run build"]`
**Setup for Q21**: `$KOI_HOME/.koi/hooks.json` with pre-tool-use command hook writing to `$HOOK_LOG`
**Setup for Q22**: Bun stub server on per-tester `$HOOK_PORT`, hooks.json POSTing to it

| Q | Prompt | Tools Expected | Pass Criteria |
|---|--------|---------------|---------------|
| Q19 | `Run the tests.` | Bash | No approval prompt (allow-list match) |
| Q20 | `Fix the typo in README.md (change 'Fixture' to 'Fixtures').` | fs_edit | TUI permission prompt renders; edit completes after approval |
| Q21 | `Read src/math.ts and write a summary to summary.txt.` | fs_read, fs_write | `$HOOK_LOG` shows 2+ entries with tool names |
| Q22 | `Read README.md` | fs_read | `$HOOK_LOG` shows POST with JSON event body |

### S7 — Context Window & Large Output

| Q | Prompt | Tools Expected | Setup | Pass Criteria |
|---|--------|---------------|-------|---------------|
| Q23 | [20+ turns; first includes `My magic word is mongoose-alpha-seven`] `What was my magic word?` | none | same session, no reset | Agent can't recall (tail-window dropped it); JSONL still has it |
| Q24 | `Run 'find / -type f 2>/dev/null \| head -5000' and tell me how many files.` | Bash | reset | No OOM; no TUI hang; answer directional |

### S8 — MCP

**Setup**: configure `.mcp.json` with a stdio echo server and an HTTP MCP server (optionally with OAuth):
```json
{
  "mcpServers": {
    "echo": { "command": "node", "args": ["echo-server.js"] },
    "http-tools": { "url": "https://mcp.example.com" }
  }
}
```

| Q | Prompt | Tools Expected | Pass Criteria |
|---|--------|---------------|---------------|
| Q25 | `List the MCP tools you have available.` | MCP lifecycle | Tools listed; server connects at startup |
| Q26 | `Use the echo MCP tool to say "hello from mcp".` | MCP tool call | Response text matches input |
| Q27 | `List your MCP tools.` (with HTTP transport configured) | MCP lifecycle | Both stdio and HTTP tools listed in same session |

### S13 — Nexus GWS Connectors & Inline OAuth

> Nexus connectors (gdrive, gmail, calendar) use `@koi/fs-nexus` with a **sideloaded Python bridge**
> (no Docker). The bridge spawns `python3 bridge.py <mount_uri>` as a subprocess, communicates via
> stdin/stdout JSON-RPC, and handles inline OAuth via `auth_required`/`auth_complete` notifications.
>
> **Current status**: `koi tui` is hardcoded to `@koi/fs-local` (`tui-runtime.ts:787`).
> `resolveFileSystemAsync()` exists in `@koi/runtime` but is NOT wired into `createTuiRuntime()`.
> S13 scenarios run via **`koi start --manifest`** (which supports filesystem config) or via test suite.

**Setup**:
```bash
# Python bridge requirement: nexus-fs package must be installed
pip install nexus-fs   # or: pip install -e packages/lib/fs-nexus/bridge/

# Clear per-tester token store (isolated HOME from §1.2)
rm -f "$KOI_HOME/.config/nexus-fs/tokens.db"
mkdir -p "$KOI_HOME/.config/nexus-fs"

# Create manifest with Nexus filesystem backend + Python bridge
cat > "$FIXTURE/koi.manifest.yaml" <<'EOF'
name: nexus-test
model:
  name: ${KOI_MODEL:-openai/gpt-4o}
filesystem:
  backend: nexus
  options:
    transport: local
    mountUri:
      - "local://$FIXTURE"
      - "gdrive://my-drive"
    pythonPath: python3
    authTimeoutMs: 300000
EOF
```

Run via `koi start` (NOT `koi tui`):
```bash
HOME="$KOI_HOME" bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" \
  start --manifest "$FIXTURE/koi.manifest.yaml" --prompt "<query>"
```

| Q | Prompt / Action | Tools Expected | Pass Criteria |
|---|--------|---------------|---------------|
| Q28 | `List the mounts you have access to.` | fs_read (mount list) | Both `local://` and `gdrive://` mounts listed |
| Q29 | `List the 5 most recent emails in my inbox.` (gmail mount) | fs_read + OAuth | OAuth flow: auth URL shown → user authorizes in browser → `auth_complete` → emails listed |
| Q30 | `What's on my calendar for today?` (calendar mount) | fs_read + OAuth | OAuth flow completes; events returned |
| Q31 | `List my recent Google Drive files.` (gdrive mount) | fs_read + OAuth | OAuth flow completes; files listed |
| Q32 | (restart process) `List my recent emails.` | fs_read | No `auth_required` — cached token in `tokens.db` reused |
| Q33 | `Read README.md from the local mount and list files on gdrive.` | fs_read ×2 | Both mounts operable in same turn |
| Q34 | (gdrive auth fails/times out) `Read local file + list gdrive.` | fs_read | Auth failure on gdrive does NOT block local mount |
| Q35 | (SSH/headless: remote OAuth mode) `List gdrive files.` | fs_read + OAuth | `auth_required` with `mode: "remote"` + `correlation_id`; user pastes redirect URL; `auth_complete` fires |
| Q36 | (kill Python bridge mid-session) `Read README.md.` | fs_read | Clean error or auto-recovery; no hang; no zombie Python processes |
| Q37 | (malformed mount URI in manifest) start process | startup | Fails fast with clear error; no bridge process spawned |

### S14 — Memory Deep

> The TUI uses `createInMemoryMemoryBackend()` — all memory is session-scoped.
> This scenario exercises the full memory tool surface (store, recall, search, delete, dedup, extraction)
> within a single TUI session. Cross-session persistence, dream consolidation, and team-sync are test-suite only.

**All queries run in the SAME TUI session (no reset between queries).**

| Q | Prompt | Tools Expected | Pass Criteria |
|---|--------|---------------|---------------|
| Q84 | `Remember: this project uses Bun 1.3 for runtime.` | memory_store | Stored as `project` type |
| Q85 | `Remember: always use explicit return types on exported functions.` | memory_store | Stored as `feedback` type |
| Q86 | `Remember: the main contact for infra is alice@example.com.` | memory_store | Stored as `reference` type |
| Q87 | `Remember: I'm a senior backend engineer, new to this frontend codebase.` | memory_store | Stored as `user` type |
| Q88 | `Remember: we prefer Bun 1.3 as our runtime.` (near-duplicate of Q84) | memory_store (dedup) | Dedup conflict warning returned (same name/type, similar content) |
| Q89 | `Remember: we prefer Bun 1.3 as our runtime.` with force | memory_store (force) | Existing record updated (force=true overrides dedup) |
| Q90 | `What do you remember about the runtime?` | memory_recall | Returns Bun 1.3 fact; relevance-ranked |
| Q91 | `What do you remember?` (broad recall, no query filter) | memory_recall | Returns all stored memories; feedback weighted higher (typeRelevance=1.2) |
| Q92 | `Search your memories for type=feedback only.` | memory_search | Returns only feedback-type memories (explicit return types) |
| Q93 | `Search your memories for the keyword "Bun".` | memory_search | Returns memories with "Bun" in name/description/content |
| Q94 | `Delete the memory about the infra contact.` | memory_delete | Memory removed; subsequent recall doesn't return it |
| Q95 | `What do you remember about the infra contact?` | memory_recall | Returns nothing (deleted) |
| Q96 | `Remember my AWS key is AKIAIOSFODNN7EXAMPLE.` | memory_store | Redacted or refused — secret never stored verbatim |
| Q97 | (have agent run a tool that outputs `[LEARNING:pattern] Always validate input at boundaries`) verify extraction | extraction MW | Transcript shows extracted learning stored as `reference` type (marker-based, confidence 1.0) |
| Q98 | (have agent run a tool whose output contains `Learned that connection pooling improves throughput`) verify extraction | extraction MW | Heuristic extraction fires ("learned that" pattern, confidence 0.7); stored as `reference` |
| Q99 | `/new` (reset session) then `What do you remember?` | memory_recall | Returns nothing — in-memory backend cleared on session reset |

**Test-suite only (not via TUI):**

```bash
# Dream consolidation (LLM merge + cold pruning)
bun test --filter=@koi/dream

# File-based persistence (Jaccard dedup, concurrent writes, MEMORY.md index)
bun test --filter=@koi/memory-fs

# Session-start recall injection (salience scoring, token budgeting)
bun test --filter=@koi/memory

# Team-sync filtering (type deny, secret scan, fail-closed)
bun test --filter=@koi/memory-team-sync
```

### S9 — Skills & Plugins

**Setup for skills**: create skill at `$KOI_HOME/.claude/skills/hello/SKILL.md`
**Setup for suspicious skill**: create `$KOI_HOME/.claude/skills/bad-skill/SKILL.md` with `rm -rf` pattern
**Setup for plugins**: create `$KOI_HOME/.koi/plugins/hello-plugin/plugin.json`

| Q | Prompt | Tools Expected | Pass Criteria |
|---|--------|---------------|---------------|
| Q38 | `What skills do you have?` | none | `hello` appears in skill list |
| Q39 | `Use the hello skill.` | Skill | Skill tool called with `name=hello`; output returned |
| Q40 | `List skills.` (bad-skill loaded) | none | Suspicious skill excluded or flagged |
| Q41 | (after plugin setup + reset) `What plugins are loaded?` | none | `hello-plugin` appears without errors |
| Q42 | (any tool-invoking prompt) | any | Plugin hook fires before tool call |

### S10 — Tasks & Memory

| Q | Prompt | Tools Expected | Pass Criteria |
|---|--------|---------------|---------------|
| Q43 | `Create a task to refactor the multiply function in src/math.ts.` | task_create | Task visible in TUI task panel |
| Q44 | `Create a task "Run tests" and leave it pending.` → `Mark it in_progress.` → `Mark it completed.` | task_create, task_update ×2 | Transitions: pending → in_progress → completed |
| Q45 | `Show me all my current tasks.` | task_list | Task list renders with status |
| Q46 | `Remember that this project uses Bun 1.3 and Biome for linting.` → `What do you remember about the toolchain?` | memory_store, memory_recall | Recall returns Bun + Biome facts |
| Q47 | (after session reset /new) `What do you remember about the toolchain?` | memory_recall | Returns nothing (in-memory backend cleared) |
| Q48 | `Remember my API key is sk-test-fake-key-12345.` → `What did you store?` | memory_store, memory_recall | Key is redacted or refused; never returned verbatim |

### S11 — TUI UI Features

> These queries exercise TUI chrome, input handling, and commands not covered elsewhere.

| Q | Action | How to Trigger | Pass Criteria |
|---|--------|---------------|---------------|
| Q49 | Model info display | `/model` or Ctrl+P → `model` | Shows model name + provider |
| Q50 | Cost + token display | `/cost` then `/tokens` | Shows input/output tokens + cost (after ≥1 turn) |
| Q51 | Compact history | `/compact` (after 5+ turns) | Message history summarized; turn count drops. Note: TUI uses tail-window slicing, NOT `@koi/context-manager` real compaction — real compaction is test-suite only |
| Q52 | Export session | `/export` (after ≥3 sessions) | Markdown file written |
| Q53 | Rewind last turn | Send "Create file /tmp/rewind-test.txt" → `/rewind` | File edit undone; conversation rolled back |
| Q54 | @-mention file completion | Type `@src/m` in input area | Overlay shows `src/math.ts` completion |
| Q55 | Tool result expand/collapse | After any tool call, press Ctrl+E | All tool results toggle expanded ↔ collapsed |
| Q56 | Prompt history | Press Up arrow after sending ≥2 prompts | Previous prompt appears in input |
| Q57 | Multiline input | Ctrl+J then type second line, Enter to submit | Both lines sent as single message |
| Q58 | Zoom | `/zoom` | Zoom level changes |
| Q59 | Help view | `/help` | Help screen renders with keybindings |
| Q60 | Doctor view | `/doctor` | Health check runs (connection, model, TTY) |
| Q61 | Agents view | `/agents` | Agents view renders (empty if no spawns) |
| Q62 | Trajectory view | `/trajectory` (after ≥1 turn) | ATIF steps displayed with kind/duration/outcome |
| Q63 | Sessions view | Ctrl+S or `/sessions` | Session list renders with recent sessions |
| Q64 | Command palette | Ctrl+P → type partial command | Fuzzy-filtered command list; Enter executes |
| Q65 | New session | Ctrl+N or `/new` | Fresh session starts; memory cleared |

### S12 — Resilience & Edge Cases

| Q | Action | Setup | Pass Criteria |
|---|--------|-------|---------------|
| Q66 | Ctrl+C mid-tool | Send `Run 'sleep 60'`, then Ctrl+C | Clean interrupt; no zombie processes |
| Q67 | Double-tap SIGINT | Ctrl+C twice rapidly during tool exec | State machine handles correctly; no crash |
| Q68 | Malformed tool args | `Edit src/math.ts to rename 'add' to 'sum' everywhere.` | Agent self-corrects; turn doesn't crash |
| Q69 | Stream disconnect | Briefly disconnect network mid-turn | Partial output rendered; error surfaced; retry offered |
| Q70 | Config hot-reload | Edit config file while TUI running | Next turn uses new config |
| Q71 | Very large file | Create 10MB `bigfile.txt`, ask `Read bigfile.txt, count lines` | No OOM; no hang; answer directional |
| Q72 | Sandbox blocks forbidden write (macOS) | `Write "bad" to /etc/koi-test` | Sandbox denies; `/etc/koi-test` does not exist |
| Q73 | Sandbox allows permitted write (macOS) | `Write "ok" to $FIXTURE/output.txt` | Write succeeds within project root |
| Q74 | Session crash recovery | Kill TUI process mid-turn (`kill -9`), relaunch, resume session | Session-repair recovers; no data loss; JSONL not corrupted |
| Q75 | Inactivity timeout (#1611) | Start TUI, send a query, wait for configured timeout period | Agent times out gracefully; session persisted; no hang |
| Q76 | Tool argument type coercion (#1611) | Send query that causes model to pass string where number expected | Args coerced correctly; tool executes; no crash |
| Q77 | Startup latency (#1637) | `time bun run .../bin.ts tui` (measure cold start) | < 2s cold start budget (P1 gate) |

### CLI-Only Scenarios (not TUI)

| Q | Action | Command | Pass Criteria |
|---|--------|---------|---------------|
| Q78 | Single-prompt mode | `bun run .../bin.ts start --prompt "What is 2+2?"` | Prints answer on stdout; exits 0; no ANSI codes |
| Q79 | Manifest override | `bun run .../bin.ts start --manifest /tmp/override.koi.yaml --prompt "hello"` | Override manifest loaded |
| Q80 | CLI help + subcommands | `bun run .../bin.ts --help` + each subcommand `--help` | All print help; exit 0 |
| Q81 | MCP auth (CLI) | `koi mcp auth <server>` | Browser opens; token stored in secure storage |
| Q82 | MCP logout (CLI) | `koi mcp logout <server>` | Token deleted |
| Q83 | MCP debug (CLI) | `koi mcp debug <server>` | Prints transport, OAuth status, tool count |

---

## 3. Test Scenarios

Each scenario = a sequence of queries with specific setup + MW configuration.

| Scenario | Name | Queries | Sessions | Special Setup |
|----------|------|---------|----------|---------------|
| **S1** | Onboarding & Resume | Q1-Q5 | 2 (reset + resume) | none |
| **S2** | File I/O & Edit | Q6-Q10 | 1 | fixture project |
| **S3** | Notebook | Q11-Q12 | 1 | seed notebook.ipynb |
| **S4** | Bash & Security | Q13-Q16 | 1 | deny rule; exfiltration target |
| **S5** | Web & SSRF | Q17-Q18 | 1 | none |
| **S6** | Permissions & Hooks | Q19-Q22 | 1 | allow-list config; hooks.json; HTTP stub |
| **S7** | Context Window | Q23-Q24 | 1 (20+ turns) | magic word in first turn |
| **S8** | MCP | Q25-Q27 | 1 | .mcp.json with stdio + HTTP servers |
| **S13** | Nexus GWS Connectors & OAuth | Q28-Q37 | 3+ (restart for token persistence) | Via `koi start --manifest` (not TUI); Python bridge; `pip install nexus-fs` |
| **S14** | Memory Deep | Q84-Q99 | 1 (no reset until Q99) | Same TUI session for all queries; tests full memory tool surface |
| **S15** | Loop Mode | Q100-Q101 | 1 per query | Via `koi start --until-pass`; fixture with failing test |
| **S16** | Golden Query Replay | — | — | `bun test --filter=@koi/runtime`; 20+ golden queries; deterministic, no LLM |
| **S9** | Skills & Plugins | Q38-Q42 | 2 (reset between skills and plugins) | skill dirs; plugin.json |
| **S10** | Tasks & Memory | Q43-Q48 | 2 (reset for Q47) | none |
| **S11** | TUI UI Features | Q49-Q65 | 1+ | ≥3 prior sessions for /export |
| **S12** | Resilience | Q66-Q77 | 1+ | 10MB file; sandbox profile (macOS); crash recovery |

**All scenarios run with the full TUI middleware stack:**
event-trace → hooks → hook-observer → rules-loader → permissions → exfiltration-guard → extraction → semantic-retry → checkpoint → system-prompt → session-transcript

Optional MW (model-router, goal, otel) require explicit config — tested via `bun test` only.

---

## 4. L2 Package Coverage Matrix

Rows = all packages wired into TUI runtime or in L2 canonical set.
Columns = scenarios. `T` = test-suite-only (not testable via TUI).

### Middleware Packages

| Package | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 | S11 | S12 | T |
|---------|----|----|----|----|----|----|----|----|----|----|-----|-----|---|
| @koi/event-trace | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | Q52 | `*` | |
| @koi/hooks | `*` | `*` | `*` | `*` | `*` | Q21,Q22 | `*` | `*` | Q32 | `*` | `*` | `*` | |
| @koi/rules-loader | Q3 | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | |
| @koi/middleware-permissions | `*` | `*` | `*` | `*` | `*` | Q19,Q20 | `*` | `*` | `*` | `*` | `*` | `*` | |
| @koi/middleware-exfiltration-guard | `*` | `*` | `*` | Q16 | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | |
| @koi/middleware-extraction | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | Q36 | `*` | `*` | |
| @koi/middleware-semantic-retry | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | Q58 | |
| @koi/checkpoint | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | Q43 | `*` | |
| @koi/middleware-audit | — | — | — | — | — | — | — | — | — | — | — | — | `bun test --filter=@koi/middleware-audit` |
| @koi/middleware-report | — | — | — | — | — | — | — | — | — | — | — | — | not wired anywhere |
| @koi/middleware-goal | — | — | — | — | — | — | — | — | — | — | — | — | `bun test --filter=@koi/middleware-goal` |
| @koi/middleware-otel | — | — | — | — | — | — | — | — | — | — | — | — | `bun test --filter=@koi/middleware-otel` |

`*` = always-on middleware; fires on every query in that scenario. Bold Q = explicitly tests that package.

### Tool Packages

| Package | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 | S11 | S12 | T |
|---------|----|----|----|----|----|----|----|----|----|----|-----|-----|---|
| @koi/tools-builtin (Glob/Grep/fs_*) | — | Q6-Q10 | — | — | — | Q20-Q22 | — | — | — | — | Q53 | — | |
| @koi/tools-bash | — | Q9 | — | Q13-Q15 | — | Q19 | Q24 | — | — | — | — | Q66-Q67 | |
| @koi/tools-web | — | — | — | — | Q17,Q18 | — | — | — | — | — | — | — | |
| @koi/tool-notebook | — | — | Q11,Q12 | — | — | — | — | — | — | — | — | — | |
| @koi/task-tools | — | — | — | — | — | — | — | — | — | Q43-Q45 | — | — | |
| @koi/tasks | — | — | — | — | — | — | — | — | — | Q43-Q45 | — | — | |
| @koi/skill-tool | — | — | — | — | — | — | — | — | Q39 | — | — | — | |
| @koi/skills-runtime | — | — | — | — | — | — | — | — | Q38-Q40 | — | — | — | |
| @koi/memory-tools | — | — | — | — | — | — | — | — | — | Q46-Q48 | — | — | Q84-Q99 (S14) |
| @koi/mcp | — | — | — | — | — | — | — | Q25-Q27 | — | — | — | — | |
| @koi/plugins | — | — | — | — | — | — | — | — | Q41,Q42 | — | — | — | |
| @koi/spawn-tools | — | — | — | — | — | — | — | — | — | — | — | — | `bun test --filter=@koi/spawn-tools` |
| @koi/tool-browser | — | — | — | — | — | — | — | — | — | — | — | — | `bun test --filter=@koi/tool-browser` |
| @koi/lsp | — | — | — | — | — | — | — | — | — | — | — | — | `bun test --filter=@koi/lsp` |

### Infrastructure Packages

| Package | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 | S11 | S12 | T |
|---------|----|----|----|----|----|----|----|----|----|----|-----|-----|---|
| @koi/session | Q4,Q5 | — | — | — | — | — | — | — | — | — | Q52,Q63 | — | |
| @koi/sandbox-os | — | — | — | `*` | — | — | — | — | — | — | — | Q72,Q73 | |
| @koi/permissions | — | — | — | — | — | Q19,Q20 | — | — | — | — | — | — | |
| @koi/bash-security | — | — | — | Q14 | — | — | — | — | — | — | — | — | |
| @koi/bash-ast | — | — | — | Q14 | — | — | — | — | — | — | — | — | |
| @koi/config | — | — | — | — | — | — | — | — | — | — | — | Q70 | |
| @koi/query-engine | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | |
| @koi/context-manager | — | — | — | — | — | — | Q23 | — | — | — | Q51 | — | |
| @koi/snapshot-store-sqlite | — | — | — | — | — | — | — | — | — | — | Q53 | — | |
| @koi/redaction | — | — | — | — | — | — | — | — | — | Q48 | — | — | |
| @koi/skill-scanner | — | — | — | — | — | — | — | — | Q40 | — | — | — | |
| @koi/model-registry | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | |
| @koi/fs-local | — | Q6-Q10 | — | — | — | Q20-Q22 | — | — | — | — | Q53 | Q71 | |
| @koi/channel-base | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | `*` | |
| @koi/shutdown | — | — | — | Q15 | — | — | — | — | — | — | — | Q66,Q67 | |
| @koi/session-repair | — | — | — | — | — | — | — | — | — | — | — | Q74 | |
| @koi/hook-prompt | — | — | — | — | — | Q21 | — | — | — | — | — | — | |

### Canonical L2 (from `scripts/layers.ts`) — Summary

| L2 Package | Scenario | Explicitly Tested By |
|------------|----------|---------------------|
| @koi/audit-sink-ndjson | T only | `bun test --filter=@koi/audit-sink-ndjson` |
| @koi/audit-sink-sqlite | T only | `bun test --filter=@koi/audit-sink-sqlite` |
| @koi/checkpoint | S11 | Q53 (/rewind) |
| @koi/loop | T only | `bun test --filter=@koi/loop` (CLI loop mode) |
| @koi/mcp | S8 | Q25-Q27 (MCP lifecycle) |
| @koi/middleware-audit | T only | `bun test --filter=@koi/middleware-audit` |
| @koi/plugins | S9 | Q41-Q42 |
| @koi/sandbox-os | S4, S12 | Q15 (implicit), Q62-Q63 (explicit, macOS) |
| @koi/session | S1, S11 | Q4-Q5 (resume), Q52 (export), Q63 (picker) |
| @koi/skill-tool | S9 | Q39 |
| @koi/skills-runtime | S9 | Q38-Q40 |
| @koi/snapshot-store-sqlite | S11 | Q53 (checkpoint storage for rewind) |
| @koi/task-tools | S10 | Q43-Q45 |
| @koi/tasks | S10 | Q43-Q45 |
| @koi/tools-bash | S2,S4,S6,S7,S12 | Q9,Q13-Q15,Q19,Q24,Q66-Q67 |

### Unlisted-but-Wired Packages — Summary

| Package | Scenario | Explicitly Tested By |
|---------|----------|---------------------|
| @koi/middleware-exfiltration-guard | S4 | Q16 (secret exfiltration blocked) |
| @koi/middleware-extraction | S10, S14 | Q46, Q97-Q98 (marker + heuristic extraction) |
| @koi/middleware-semantic-retry | S12 | Q68 (malformed args → retry) |
| @koi/fs-nexus | S13 | Q28-Q37 (Python bridge, GWS mounts, inline OAuth) |
| @koi/secure-storage | S8, S13 | Q28-Q35 (OAuth token persistence) |
| @koi/middleware-permissions | S6 | Q19 (allow), Q20 (prompt) |
| @koi/rules-loader | S1 | Q3 (CLAUDE.md injection verified) |
| @koi/model-router | T only | `bun test --filter=@koi/model-router` (optional MW) |
| @koi/middleware-goal | T only | `bun test --filter=@koi/middleware-goal` (optional MW) |
| @koi/middleware-otel | T only | `bun test --filter=@koi/middleware-otel` (optional MW) |
| @koi/dream | T only | `bun test --filter=@koi/dream` (not wired in TUI) |
| @koi/memory-fs | T only | `bun test --filter=@koi/memory-fs` (TUI uses in-memory) |
| @koi/memory-team-sync | S10 | Q38 (redaction path) |
| @koi/tool-browser | T only | `bun test --filter=@koi/tool-browser` (not wired in TUI) |
| @koi/model-openai-compat | T only | `bun test --filter=@koi/model-openai-compat` (start.ts adapter) |
| @koi/mcp-server | T only | `bun test --filter=@koi/mcp-server` (separate process) |
| @koi/agent-runtime | T only | `bun test --filter=@koi/agent-runtime` (spawn stubbed in TUI) |
| @koi/decision-ledger | T only | `bun test --filter=@koi/decision-ledger` (not wired in TUI) |
| @koi/fs-nexus | S13 | Q28-Q37 (GWS connectors via Python bridge + inline OAuth) |
| @koi/middleware-report | T only | `bun test --filter=@koi/middleware-report` (not wired anywhere) |

---

## 5. TUI Feature Coverage Matrix

### Commands (19 total)

| Command | Shortcut | Scenario | Query |
|---------|----------|----------|-------|
| `nav:trajectory` | — | S11 | Q62 |
| `nav:sessions` | Ctrl+S | S11 | Q63 |
| `nav:help` | — | S11 | Q59 |
| `nav:doctor` | — | S11 | Q60 |
| `nav:agents` | — | S11 | Q61 |
| `agent:clear` | Ctrl+L | S1 | (implicit in reset) |
| `agent:interrupt` | Ctrl+C | S4,S12 | Q15,Q66,Q67 |
| `agent:compact` | — | S11 | Q51 |
| `agent:rewind` | — | S11 | Q53 |
| `session:new` | Ctrl+N | S11 | Q65 |
| `session:resume` | — | S1 | Q5 |
| `session:fork` | — | S11 | (implicit if ≥1 session) |
| `session:rename` | — | S11 | (exercise via command palette) |
| `session:export` | — | S11 | Q52 |
| `system:model` | — | S11 | Q49 |
| `system:cost` | — | S11 | Q50 |
| `system:tokens` | — | S11 | Q50 |
| `system:zoom` | — | S11 | Q58 |
| `system:quit` | — | S12 | (final cleanup) |

### Keyboard Shortcuts

| Shortcut | Feature | Scenario | Query |
|----------|---------|----------|-------|
| Ctrl+P | Command palette | S11 | Q64 |
| Ctrl+C | Interrupt | S4,S12 | Q15,Q66,Q67 |
| Ctrl+S | Sessions view | S11 | Q63 |
| Ctrl+L | Clear history | S1 | (implicit) |
| Ctrl+N | New session | S11 | Q65 |
| Ctrl+E | Expand/collapse tools | S11 | Q55 |
| Ctrl+J | Multiline input | S11 | Q57 |
| Escape | Dismiss modal | S6,S11 | Q20 (permission), Q64 (palette) |
| Up/Down | Prompt history | S11 | Q56 |
| Enter | Submit | all | all queries |
| Backspace | Delete char | all | all input |

### Views (6 total)

| View | Scenario | Query |
|------|----------|-------|
| Conversation | S1-S13 | all queries |
| Sessions | S11 | Q63 |
| Doctor | S11 | Q60 |
| Help | S11 | Q59 |
| Agents | S11 | Q61 |
| Trajectory | S11 | Q62 |

### Modals (6 total)

| Modal | Scenario | Query |
|-------|----------|-------|
| Command palette | S11 | Q64 |
| Permission prompt | S6 | Q20 |
| Session picker | S1,S11 | Q5,Q63 |
| Session rename | S11 | (exercise via command palette) |
| @-mention overlay | S11 | Q54 |
| Slash overlay | S11 | Q49-Q52 (triggered by `/` prefix) |

### Status Bar Elements

| Element | Scenario | Query |
|---------|----------|-------|
| Model name + provider | S11 | Q49 |
| Token counts (T{turns}) | S11 | Q50 |
| Cost ($X.XX) | S11 | Q50 |
| Context % | S7,S11 | Q23 (high context), Q50 |
| Connection status | S12 | Q69 (disconnect) |
| Agent status (idle/processing) | all | all queries |
| Retry countdown | S12 | Q68,Q69 |
| Elapsed time (streaming) | all | all queries |

### Streaming & Rendering

| Feature | Scenario | Query |
|---------|----------|-------|
| Text block (markdown) | S1 | Q1,Q2 |
| Thinking block | all | (model-dependent) |
| Tool call block (running/complete/error) | S2 | Q6,Q8 |
| Tool result accordion | S11 | Q55 (Ctrl+E toggle) |
| Tool result N-line truncation | S2 | Q8 (multi-tool workflow) |
| Error block | S12 | Q68 (malformed args) |
| Spawn block | — | test-suite only (spawn stubbed) |
| Auto-scroll + pause on scroll-up | S7 | Q23 (many turns) |
| Markdown code fence healing | S2 | Q8 (JSDoc generation streams) |

---

## 6. Non-TUI Scenarios

Packages not wired into `koi tui` are tested via **golden query replay** (deterministic, no LLM) and **`koi start` CLI**. Each golden query runs the full `createKoi()` pipeline with recorded LLM cassettes — real middleware, real tools, real ATIF trajectories.

### S15 — Loop Mode (via `koi start --until-pass`)

| Q | Command | Pass Criteria |
|---|---------|---------------|
| Q100 | `koi start --prompt "Fix the failing test in test/math.test.ts" --until-pass "bun test" --max-iter 3` | Agent iterates: edit → verify → pass. Converges within max-iter |
| Q101 | `koi start --prompt "Make this pass" --until-pass "false" --max-iter 2` | Hits max-iter; exits cleanly with non-zero code; no hang |

### S16 — Golden Query Replay (via `bun test --filter=@koi/runtime`)

Each row is a golden query exercising packages through the full agent pipeline. Run all:
```bash
bun test --filter=@koi/runtime
```

| Golden Query | Packages Exercised | Pass Criteria |
|---|---|---|
| audit-log | middleware-audit, audit-sink-sqlite, audit-sink-ndjson | Audit entries schema-valid; SHA-256 chain intact; MW spans present |
| outcome-evaluator | outcome-evaluator, circuit-breaker | Grader called; rubric pass/fail; re-prompt on failure; circuit-break on repeats |
| spawn-agent, spawn-coordinator, spawn-fork | agent-runtime, spawn-tools | Spawn lifecycle: define → load → spawn → inherit permissions → complete |
| spawn-inheritance, spawn-allowlist, spawn-manifest-ceiling | agent-runtime, spawn-tools | Tool narrowing, permission inheritance, manifest ceiling enforcement |
| model-router | model-router | Failover chain; circuit-breaker trips; health probe recovery |
| goal-tracking, goal-callback | middleware-goal, middleware-report | Goal injection; drift detection; completion callback fires |
| otel-spans | middleware-otel | OpenTelemetry spans emitted; semantic conventions correct |
| memory-recall-pipeline | memory (core) | Salience scoring; exponential decay; token budget; format with trust boundary |
| memory-fs | memory-fs | File persistence; Jaccard dedup; MEMORY.md index rebuild; concurrent writes |
| dream-consolidation | dream | Cluster similar memories; LLM merge; type enforcement; cold pruning |
| memory-team-sync | memory-team-sync | Type filtering (user always denied); secret scanning; fail-closed |
| session-recovery, session-persist, session-resume | session, session-repair | JSONL persistence; crash recovery; append-on-resume; compaction boundary |
| mcp-server | mcp-server | Expose Koi tools as MCP; discover/query/invalidate |
| decision-ledger | decision-ledger | Trajectory + audit read-only projection |
| tool-browser | tool-browser | Browser automation (headless) |
| lsp | lsp | LSP client operations |
| loop-convergence | loop | runUntilPass; verifier gate; max-iter bail |
| skills-mcp-bridge | skills-runtime, mcp | Bridge MCP tools → skill registry |
| middleware-extraction | middleware-extraction | Marker + heuristic extraction; secret filtering |
| checkpoint + snapshot-store | checkpoint, snapshot-store-sqlite | Capture/rewind snapshots |

### Packages with no golden query (unit tests only)

These utility packages have no user-facing surface and are exercised indirectly by other packages:

```bash
bun test --filter=@koi/file-resolution    # path resolution utility
bun test --filter=@koi/model-openai-compat # adapter tested via provider selection
```

---

## 7. Tester Assignment

| Tester | Scenarios | `TESTER_ID` |
|--------|-----------|-------------|
| T1 | S1 (Onboarding), S2 (File I/O), S3 (Notebook) | `t1` |
| T2 | S4 (Bash/Security), S5 (Web), S6 (Permissions) | `t2` |
| T3 | S7 (Context), S8 (MCP), S9 (Skills/Plugins) | `t3` |
| T4 | S10 (Tasks/Memory), S11 (TUI UI), S14 (Memory Deep) | `t4` |
| T5 | S12 (Resilience), CLI-only (Q78-Q83) | `t5` |
| T6 | S13 (Nexus GWS Connectors & OAuth) | `t6` |
| T7 | S15 (Loop Mode), S16 (Golden Query Replay) | `t7` |

---

## 8. Exit Criteria

1. All S1-S16 scenarios run at least once
2. All Q1-Q101 queries executed with pass/fail recorded
3. All S16 golden queries pass (`bun test --filter=@koi/runtime` green)
3. All P0/blocker bugs filed, fixed, or triaged with owner
4. L2 coverage matrix (§4) shows every package has ≥1 green scenario or test-suite pass
5. TUI feature matrix (§5) shows every command/shortcut/view/modal exercised
6. `bun test --filter=@koi/runtime` (golden replay) passes on candidate commit
7. Written summary posted with:
   - Queries run: N/101
   - Golden replay: all green / N failures
   - Bugs filed by severity
   - Unexercised packages + justification
   - Go / no-go recommendation

---

## 9. Bug Report Template

```
Title: [bug bash] Q<N>: <one-line symptom>
Body:
**Query**: Q<N> — <prompt>
**Scenario**: S<N>
**Expected**: <from pass criteria>
**Actual**: <what happened>
**Repro**: git rev-parse HEAD → <commit>; reset (§1.5); tmux send-keys '<exact query>'
**TUI capture**: <attach $CAPTURE_FILE>
**Transcript**: <attach $SESSION_FILE>
**Severity**: blocker / major / minor / nit
Labels: bug, phase-2, bug-bash
```
