# S14 Memory Deep — Results (T4)

Run: 2026-04-27, branch `worktree-phase-2-bug-bash`, fixture `/tmp/koi-bugbash-phase-2-bug-bash-t4`.
Model: anthropic/claude-sonnet-4 via openrouter. Captures: `/tmp/koi-phase-2-bug-bash-t4-results/`.

| Q | Expected | Actual | Verdict |
|---|---|---|---|
| Q84 | memory_store type=project | type=project | PASS |
| Q85 | memory_store type=feedback | type=feedback | PASS |
| Q86 | memory_store type=reference | **type=user** | **FAIL** |
| Q87 | memory_store type=user | type=user | PASS |
| Q88 | memory_store dedup conflict warning | model self-skipped, never invoked tool | **PARTIAL** |
| Q89 | memory_store force=true overrides | force=true, record updated | PASS |
| Q90 | memory_recall returns Bun 1.3 | model used auto-injected context, did not call tool until pressed | PARTIAL |
| Q91 | memory_recall all, feedback weighted | tool invoked, all 4 returned | PASS |
| Q92 | memory_search type=feedback | correct result, **TUI label rendered as "Web Search"** | PASS w/ UI bug |
| Q93 | memory_search keyword "Bun" | correct, same UI label bug | PASS w/ UI bug |
| Q94 | memory_delete | deleted after permission prompt | PASS |
| Q95 | memory_recall returns nothing | empty result | PASS |
| Q96 | secret refused or redacted | refused, never stored | PASS |
| Q97 | post-/new recall: 3 facts present, infra absent, AWS absent verbatim, disk populated | all conditions met | PASS |

## Bugs

1. **Q86 — spec mismatch, not code bug.** The skill (`packages/mm/memory-tools/src/skill.ts:52,59`) deliberately classifies all personal contacts (incl. `infra contact: alice@example.com`) as `type=user`. The bug-bash spec says `reference`. Code matches design; spec should be updated. **No fix.**
2. **TUI label "Web Search" for memory_search** — Q92, Q93. Root cause: `tool-display.ts` had a `_search` suffix entry that swallowed any `*_search` tool. **Fixed**: replaced suffix with explicit exact-name entries (`web_search`, `memory_store`, `memory_recall`, `memory_search`, `memory_delete`). Tests pass (58/58 in `tool-display.test.ts`, 133/133 in `memory-tools`). Live verification: TUI now displays `Memory Store`, `Memory Search`, etc.
3. **Dedup-at-tool-level not exercised on near-duplicates** — Q88. Model heuristically declined to call `memory_store` because the auto-injected memory list already covered it; the tool's own dedup branch never ran. **Not a code bug** — model behavior with prompt phrasing. Spec assertion or prompt phrasing should be tightened.
4. **Q90 recall via auto-injection** — model didn't call `memory_recall` because the answer was already injected. Same class as #3.

## Fix summary

- `packages/ui/tui/src/tool-display.ts` — added exact entries for `web_search` and `memory_*` tools; removed the over-broad `_search` suffix.

## Disk verification (post-/new)

`$FIXTURE/.koi/memory/`:
- `MEMORY.md`
- `project_runtime_bun_1_3.md`
- `always_use_explicit_return_types_on_exported_functions.md`
- `user_role_and_experience.md`
- `.dream-gate.json`

No `AKIA*` / `alice@example` strings in memory store. (Strings appear only in `$KOI_HOME/.koi/sessions/*.jsonl` — expected; full transcript log.)
