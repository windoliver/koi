# S17 Agent Spawning — Results (T8)

Run: 2026-04-27. Captures: `/tmp/koi-phase-2-bug-bash-t8-results/`.

| Q | Verdict | Notes |
|---|---|---|
| Q102 researcher | PASS | Found 2 TODOs in src/math.ts + src/util.ts |
| Q103 coder | PASS | Added isEven + 4 tests; bun test 6/6 |
| Q104 reviewer | PASS | Structured review returned, no file edits |
| Q105 coordinator | PASS | Spawned researcher + coder; util.test.ts created; 13 tests pass |
| Q106 dynamic | PASS | `agentName: "custom-helper"`, `toolAllowlist: ["Glob"]`; listed all 4 .ts files |
| Q107 /agents view | PASS w/ **UI bug** | View shows 7 spawns with ✓ status; status chars overlay description text |
| Q108 Ctrl+C | PASS | Spawn interrupted cleanly; TUI responsive; no zombies |
| Q109 6 spawns | PASS | 5 succeeded, 6th rejected: "blocked by fan-out limit (max 5 concurrent child agents per turn)" |

## Bugs

1. **`/agents` view text rendering** — In Recent list, status indicators interleave into the description text. Examples observed:
   - `"ListoalleTypeScript files in this project"` (should be "List all TypeScript files…")
   - `"Searchcthe3entire7projectyfor all TODO"` (should be "Search the entire project for all TODO")
   - `"Addetest.coverage9for9thev`chunk`"` (should be "Add test coverage for the `chunk`")

   The pattern looks like progress/status chars (numbers, single letters) being injected one-per-original-char into the text column. Cosmetic only — functionality intact.

2. **API key leak via process args (harness, not Koi code)** — When the TUI is launched with `OPENROUTER_API_KEY=...` inline on the command line (as in the bug-bash doc §1.4), `ps` exposes it system-wide. The bug-bash doc should recommend exporting the key into the env *before* the tmux invocation, e.g. `export OPENROUTER_API_KEY=...; tmux new-session ... 'bun run ...'` rather than `tmux new-session ... 'OPENROUTER_API_KEY=... bun run ...'`. Not a Koi defect; doc-fix.
