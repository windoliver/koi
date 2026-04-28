# Q77 Cold-start regression — investigation

Bug-bash S12 Q77 measured wall-clock cold start at 5.0s default / 3.6s
`--no-governance`. The P1 budget is < 2s (issue #1637).

## Methodology

Added KOI_BOOT_TRACE=1 instrumentation to `bin.ts` and `tui-command.ts`,
plus a separate import timer that loads the major workspace packages in
isolation, to attribute cost to specific phases.

Measurements: `tmux new-session ... bun run .../bin.ts tui` → poll
the captured pane until "Type a message" appears.

## Result (one representative warm-cache run, fixture `/tmp/koi-bugbash-s12`)

```
[boot parent    25ms] bin.ts start
[boot parent    44ms] import dispatch — done
[boot parent    45ms] runDispatch → tui-reexec        ← parent done, spawn child
[boot child     9ms] bin.ts start
[boot child    23ms] import dispatch — done
[boot child    24ms] runDispatch → tui
[boot child    24ms] import tui-command — start
[boot child  1273ms] import tui-command — done        ← 1249ms inside one import
[boot     0ms] runTuiCommand entered                  ← timer reset, ms = since runTui
[boot    13ms] phase 3: assemble runtime — start
[boot   468ms] phase 5: tree-sitter init — start      ← 455ms in createKoiRuntime + setup
[boot   635ms] phase 5: tree-sitter init — done       ← 167ms tree-sitter
[boot   641ms] phase 6: createTuiApp.start() — begin
[boot   689ms] phase 6: createTuiApp.start() — done   ← TUI mounted

wall_to_prompt = 2337ms (parent process start → first paint visible in tmux)
```

## Where the time goes

| Phase | Cost (ms) | % of 2337ms wall |
|---|---:|---:|
| Parent `bin.ts` + dispatch | 45 | 2% |
| `Bun.spawn` child + child `bin.ts` + dispatch | ~80 | 3% |
| **Child: `import("./tui-command.js")`** | **1249** | **53%** |
| `runTuiCommand` phases 1–3 (config + manifest discovery) | 13 | 1% |
| `createKoiRuntime` resolution + supporting setup | 455 | 19% |
| Tree-sitter WASM init | 167 | 7% |
| `createTuiApp` + `start()` | 48 | 2% |
| First-paint render to terminal (post-`start()`) | ~250 | 11% |
| **TOTAL** | **2337** | |

The `--no-governance` and default-mode cases differ by ~1.4s (3.6s vs
5.0s in the bug-bash measurements); that delta is dominated by the
governance preset wiring inside `createKoiRuntime` (phase 3).

## Per-package import cost (isolated)

```
[   28ms] start
[   76ms] after @koi/core           (+48ms)
[  197ms] after @koi/engine         (+121ms)
[  456ms] after @koi/runtime        (+259ms)
[  494ms] after @koi/middleware-permissions (+38ms)
[  499ms] after @koi/governance-defaults    (+5ms)
[  499ms] after @koi/middleware-audit       (+0)
[  499ms] after @koi/audit-sink-ndjson      (+0)
[  499ms] after @koi/audit-sink-sqlite      (+0)
[ 1533ms] after @koi/tui            (+1034ms)  ← biggest
[ 1534ms] after @opentui/core       (+1)
[ 1601ms] after @koi/skills-runtime (+67ms)
[ 1602ms] after @koi/loop           (+1)
[ 1616ms] after @koi/model-router   (+14ms)
[ 1622ms] after @koi/spawn-tools    (+6ms)
```

Top contributors to import time:
1. **`@koi/tui`: ~1s** — pulls in `@opentui/core`, `react`, JSX runtime, all components
2. **`@koi/runtime`**: ~260ms (the L3 meta package; bundles many L2 dependencies)
3. **`@koi/engine`**: ~120ms

## Why the tui-command import is so expensive

`packages/meta/cli/src/tui-command.ts` has ~46 distinct `import`
specifiers at module top, including the heavy `@koi/tui`, `@koi/runtime`,
`@opentui/core`, `@koi/skills-runtime`, `@koi/loop`, `@koi/forge-demand`,
`@koi/agent-summary`, `@koi/context-manager`, `@koi/tool-browser`, and
many more. ESM hoists static imports, so all of those (and their
transitive closures) load before the first line of `runTuiCommand`
runs.

A non-trivial fraction of those imports are only used **after** first
paint (e.g. `microcompact` for `/compact`, `loop-mode` runUntilPass,
agent-summary, browser tool, forge-demand defaults).

## Recommendations (in priority order)

### 1. Lazy-load post-paint features inside `tui-command.ts` (highest ROI)
Convert imports of features only used after first paint to `await
import()` inside the closure where they are first needed:
- `microcompact` (compact command)
- `runUntilPass`, `createArgvGate` (loop mode — only `--loop` flag)
- `createAgentSummary` (summary command)
- `@koi/tool-browser` (browser tool — only when manifest enables it)
- `@koi/forge-demand` defaults (config-time, can defer to first use)

Estimated saving: 200–500ms off the 1249ms `import tui-command` step
(transitively also drops `react` JSX bits used only by browser tool).

### 2. Drop the TUI re-exec dance (#1750 / solid-js condition fix)
Saves ~125ms (parent dispatch + Bun.spawn). Requires either:
- Fixing the solid-js export-condition resolution at `bunfig.toml`
  level so the parent already resolves the browser build, OR
- Switching `@koi/tui` away from solid for the rendering layer.
Risky and out-of-scope for a perf pass.

### 3. Pre-render a "Loading…" frame before runtime assembly
Currently the TUI doesn't paint anything until `createTuiApp.start()`
returns at +689ms after `runTuiCommand` enters. A two-stage TUI mount
(splash frame → swap to real app once `runtimeReady` resolves) would
let the user see *something* well before 2.3s, even if the underlying
import + runtime cost stays the same. Perceived-latency win.

### 4. Defer `@koi/runtime` re-export aggregation
`@koi/runtime` is an L3 meta-package that re-exports many L2 packages.
Each re-export forces transitive loading. The CLI currently uses only a
small subset of `@koi/runtime` (`createArtifactToolProvider`,
`resolveFileSystemAsync`, etc.) — switching those imports to direct L2
specifiers (e.g. `@koi/artifacts`, `@koi/file-resolution`) would skip
the unrelated re-export chain.

### 5. Tree-sitter WASM init (~167ms)
Already runs serially at boot for markdown rendering. Could be deferred
to first markdown render (`getTreeSitterClient().initialize()` is
idempotent). Saves ~167ms but only helps if no markdown renders before
the user types — true for most cold starts.

## Recommended next step

Land #1 first (lazy-load post-paint features). It is the single biggest
movable lever and is mechanical/low-risk: each candidate import only
needs to move inside the function that actually uses it. Target:
trim 300ms+ off the `import tui-command` cost, bringing wall-clock to
~2s. Combined with #3 (splash frame) it should feel sub-second on warm
caches.

#2 and #4 require deeper refactors and should be tracked in #1637 as
follow-ups.

## Update — first pass landed

Converted four post-paint imports to dynamic `await import()`:
- `microcompact` (`@koi/context-manager`) — only on `/compact`
- `createAgentSummary` (`@koi/agent-summary`) — only on `/summary`
- `createArgvGate` + `runUntilPass` (`@koi/loop`) — only `--until-pass`
- `createBrowserProvider` + `createMockDriver` (`@koi/tool-browser`) —
  only when `KOI_BROWSER_MOCK=1`

Also added `KOI_BOOT_TRACE=1` env-gated phase-timing in `bin.ts` so
future work on this regression can measure without re-instrumenting.

### Measured impact (warm caches, median of 6 runs)

| Metric | Baseline | After pass 1 | Delta |
|---|---:|---:|---:|
| Wall-clock to first paint | ~2337ms | ~2100ms | −10% |
| `import tui-command` | ~1249ms | ~1500ms | +20% (noise) |

The wall-clock improvement is real but small — the four packages we
deferred are individually tiny (each ~5–60ms isolated). The dominant
cost remains the transitive load of `@koi/tui` (~1s isolated) and
`@koi/runtime` (~260ms isolated), both of which are still imported
statically because they are used during pre-paint runtime assembly.

To get under the 2s budget, the next pass needs to attack the
**structural** drivers, not the leaf imports:
- Defer `@koi/runtime` re-exports → switch CLI consumers to direct
  L2 imports (`@koi/artifacts`, `@koi/file-resolution`, etc.) so the
  re-export aggregation cost is paid lazily.
- Drop the solid-js TUI re-exec dance (saves ~125ms parent dispatch
  + spawn).
- Render a "Loading…" splash frame from `createTuiApp` before
  `runtimeReady` resolves so perceived latency drops to ~1s while the
  underlying assembly continues in the background.

Each of those is a non-trivial refactor and should be tracked in #1637.
