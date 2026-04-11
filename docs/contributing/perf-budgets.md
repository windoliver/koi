# Performance budgets

We gate startup latency on every PR. This doc explains what is measured, how
the gate works, how to reproduce locally, and how to refresh the baseline.

Tracking issue: [#1637](https://github.com/windoliver/koi/issues/1637).

## Why

Multiple agent CLIs have shipped releases that regressed cold start from
well under a second to tens of seconds. The cause is rarely a single bad
import — it's death by a thousand cuts: small import-time costs accumulated
across many packages, invisible until a user complains. Bisecting after the
fact is expensive because every regression looks small on its own.

A committed baseline plus a multi-sample CI gate catches these regressions
inside the PR that introduces them, while `git blame` still points at the
right commit.

## What is measured

Two scenarios run on every PR:

| Scenario | How it is invoked | What it exercises |
|---|---|---|
| `fast-path` | `koi --version` | `bin.ts` top-of-file through the pre-import fast path. No dynamic imports run. |
| `command-dispatch` | `bun packages/meta/cli/dist/bench-entry.js` | A non-shipped entrypoint built by tsup **alongside** `bin.js` (same pipeline, same chunks, same minification) that mirrors `bin.ts`'s dispatch-time dynamic imports (`args.ts` → `registry.ts` → `start` command loader). The `start` loader transitively pulls `@koi/channel-cli`, `@koi/core`, `@koi/engine`, and `@koi/harness` — the heaviest import graph in the CLI. Lightweight commands like `sessions list` don't pull in those deps and would mask regressions. |

### Production purity — zero probes in the shipped CLI

The shipped `bin.ts` contains **no** measurement hook: no probe env
var, no hidden flag, no `if (benchmark)` branch. Any such backdoor is
a trust-boundary footgun — an ambient env var inherited from a parent
shell or CI wrapper, or a CLI flag accidentally propagated by an
orchestration layer, could turn real lifecycle commands like `koi
stop`, `koi deploy`, or `koi start` into silent exit-0 no-ops.

Instead, the measurement harness lives at
`packages/meta/cli/src/bench-entry.ts`. It mirrors `bin.ts`'s
dynamic-import sequence (`args.ts` → `registry.ts` → `start` loader)
and exits 0 before calling any command body.

Critically, `bench-entry.ts` is **built alongside `bin.ts` by the same
tsup pipeline**. This means the measurement runs against real bundled
code — same chunks, same esbuild output, same minification, same
treeshaking — matching what users execute when they run `koi`. A
source-only harness would miss packaging/build regressions.

`bench-entry.ts` is excluded from npm publication via the `files`
field negation in `packages/meta/cli/package.json`:

```json
"files": [
  "dist/",
  "!dist/bench-entry.js",
  "!dist/bench-entry.d.ts",
  "!dist/bench-entry.d.ts.map",
  "!dist/bench-entry.js.map"
]
```

Users who `bun add @koi-agent/cli` never receive the bench entrypoint,
even though it sits in `dist/` locally.

Three contracts are enforced by regression tests in
`packages/meta/cli/src/benchmark.test.ts`:

1. **bin.ts is probe-free** — no `KOI_STARTUP_PROBE`, no
   `__startup-probe`, no `__probe`, no reference to `bench-entry`.
2. **bench-entry parity** — every dispatch token that appears in
   `bin.ts` (`args.js`, `parseArgs`, `isTuiFlags`, `isKnownCommand`,
   `registry.js`, `COMMAND_LOADERS`) must also appear in
   `bench-entry.ts`.
3. **Publication exclusion** — `package.json` `files` must contain
   `!dist/bench-entry.js`.

### "Warmed startup" — what the gate measures (and doesn't)

This gate measures **warmed/steady-state** startup. Each scenario
runs 3 untimed warmup launches (to prime Bun's module cache, OS
filesystem cache, and any JIT state) before taking the 20 timed
samples that feed p50/p90. That gives stable numbers and catches
incremental PR-to-PR regressions — which is the gate's primary job.

It does **not** measure "first launch after a fresh install" cost.
A genuine cold-start gate would require per-sample cache isolation
(clearing Bun's compile cache, the OS page cache, and process-level
caches between spawns) — infrastructure we don't have and don't plan
to build here. If that cost becomes a regression concern, the right
answer is a separate benchmark with its own tooling, not contorting
this one.

The trade-off is honest: PR authors cannot use the gate to argue
"fresh-install launches are fast". They can use it to argue "the PR
didn't make repeated launches slower".

### Gotcha: `--help` / `-h` / `--version` / `-V` short-circuit

`bin.ts` short-circuits on any raw argv containing `--help`, `-h`,
`--version`, or `-V` *before* any dynamic import runs. That means
something like `koi status --help` measures the same thing as
`koi --version` — it never reaches the lazy-load boundary, which is
why the command-dispatch scenario cannot use `<cmd> --help`.

## The gate

For each scenario, the measurement runs **3 untimed warmups** (discarded)
followed by **20 timed samples** (all kept). We compute `p50`, `p90`,
`mean`, `min`, and `max`. The gate checks three conditions per scenario
and fails on any violation:

```
1. stats.p50 <= scenario.budgetMs                                   (hard ceiling)
2. stats.p50 <= max(baseline.p50 + absSlopMs, baseline.p50 * 1.20)  (median drift)
3. stats.p90 <= max(baseline.p90 + absSlopMs, baseline.p90 * 1.25)  (tail drift)

where absSlopMs = 50 for fast-path, 200 for command-dispatch
```

Budgets (hard ceilings, CI p50):

| Scenario | Budget |
|---|---|
| `fast-path` | 250 ms |
| `command-dispatch` | 2000 ms |

The `max(abs, pct)` tolerance is important. A pure multiplicative gate
gives tiny absolute slack on a fast baseline — a 40 ms `--version` × 1.20
is 48 ms, less than normal GH Actions runner noise. The additive floor
keeps fast scenarios stable while still catching real regressions.

## Running locally

Build the CLI, then run the local gate:

```bash
bun install
bun run build
bun run bench:startup:local
```

Local mode only gates against the **hard budget**, not the committed
baseline. Local machines have different CPUs, filesystems, and caches
than the CI runner; comparing them against the CI-recorded baseline
would either spam false positives or let real regressions through. The
budget is the right local guard.

The script refuses `--update-baseline` outside CI for the same reason.

### CI mode requires a committed baseline

Running the script without `--local` and without `--update-baseline`
(i.e. the mode CI uses) **fails hard** if `bench/startup-baseline.json`
is missing. Without a baseline, drift detection is skipped and the gate
only enforces the coarse hard ceilings — that silently lets incremental
regressions ship, which defeats the point.

If you are bootstrapping the gate on a fresh branch:

```bash
gh workflow run ci.yml -f update_baseline=true --ref <branch>
```

Download the `startup-latency-baseline` artifact from the run, commit
`bench/startup-baseline.json` to the branch, and re-push. The next CI
run will use it.

## Reading a failed CI report

A failing CI job prints something like:

```
✗ startup latency gate failed:
  • [command-dispatch] drift (p50): p50 840.3ms exceeds drift limit 720.0ms (baseline 600.0ms)
  • [command-dispatch] drift (p90): p90 1100.5ms exceeds drift limit 960.0ms (baseline 768.0ms)
```

The CI job also uploads a `startup-latency-report` artifact containing
the machine-readable `bench/startup-report.json`. Download it from the
job summary page to see every sample if the printed report is not
enough.

## Diagnosing a regression

1. Confirm the regression is reproducible locally:
   `bun run bench:startup:local`. If it passes locally, the regression
   may be CI-runner-specific; open an issue with the report artifact
   attached before changing the baseline.
2. Find the scenario: `fast-path` regressions mean something bypassed
   the pre-import fast path in `bin.ts` (e.g. a new top-level import).
   `command-dispatch` regressions mean one of the lazy-loaded modules
   (`args.js`, `registry.js`, a command loader) now transitively pulls
   in more code than before.
3. `git bisect run bun run bench:startup:local` — the script's non-zero
   exit on failure makes it a clean bisect predicate.
4. Once you have the bad commit, use Bun's profiling to see where the
   time went:
   ```bash
   BUN_INSPECT_PROFILE=1 bun packages/meta/cli/dist/bin.js --version
   ```
   Open the resulting profile in the Bun debugger to see which modules
   dominated the startup cost.

## Migrations: scenario rename, new scenario, Bun upgrade

Occasionally the gate's shape changes legitimately:

- You add, remove, or rename a scenario in `scripts/measure-startup.ts`
- You upgrade the pinned Bun version in `.github/actions/setup/action.yml`
- You migrate the CI runner (e.g. `ubuntu-latest` → `ubuntu-24.04`)

In each case, the committed baseline at the trusted ref is
incompatible with the current code: the schema no longer matches, or
the environment it was recorded under no longer matches. Under a
strict gate this would deadlock — you can't land the code change
without a new baseline, but you can't generate a new baseline without
landing the code change.

The gate handles this by **auto-falling-back to the working-tree
baseline** when the ref baseline is incompatible. The script emits a
loud `::warning::` annotation in CI logs explaining which mismatch
was detected (schema or environment), and uses the PR's own
`bench/startup-baseline.json` as the comparator instead.

The `baseline-migration` label also unlocks two other capabilities:

1. The PR's own `scripts/measure-startup.ts` is used to run the
   gate, instead of the trusted copy pulled from `origin/main`.
   Without the label, CI always runs main's copy of the script
   against the PR's built CLI so a regression PR cannot rewrite the
   benchmark logic to make itself pass.

2. The PR can modify the measurement surface. Without the label,
   CI hard-fails on any PR that touches:
   - `scripts/measure-startup.ts` — the measurement driver. Note
     that CI always runs main's copy via `trusted-script`, so
     PR-authored changes to this file don't affect the current
     PR's measurement; the label is a pre-merge gate that prevents
     the driver from changing under future PRs without review.
   - `scripts/measure-startup.test.ts` — unit tests for the
     driver's pure helpers. Weakened tests could hide bugs in
     the gate logic.
   - `packages/meta/cli/src/bench-entry.ts` — the benchmark harness
   - `packages/meta/cli/src/benchmark.test.ts` — parity invariants
   - `packages/meta/cli/src/dispatch.ts` — shared dispatch helper
     that both bin.ts and bench-entry.ts execute
   - `packages/meta/cli/tsup.config.ts` — bundling pipeline; a
     diverging tsup config would let bench-entry.js be built with
     different chunks/minification than bin.js
   - `packages/meta/cli/package.json` — the `bin` field and the
     `files` field that excludes bench-entry from publication
   - `.github/workflows/ci.yml` — the workflow itself, so a PR
     cannot disable the gate, force `--allow-migration`, or edit
     the trusted-script extraction step
   - `.github/actions/setup/action.yml` — the composite action
     that pins the Bun version. A PR could otherwise bump Bun to a
     version with different startup characteristics without
     refreshing the baseline.

   A regression PR could otherwise weaken any of these silently.
   The `.github/workflows/ci.yml` guard is necessarily coarse —
   any CI change (even unrelated) requires the label. A future
   follow-up could anchor the startup-latency job in a reusable
   workflow on main to avoid this; for now the label-gate is the
   best available protection without major restructuring.

Legitimate changes to the gate itself (new stats, bug fixes in
`measure-startup.ts`, new scenarios in `bench-entry.ts`, stronger
invariants in `benchmark.test.ts`) therefore all go through the
same label as baseline schema/env migrations, producing a single
visible human checkpoint for every change that can affect gate
behavior.

Workflow for a migration PR:

1. Make the code change (new scenario, Bun bump, scenario rename,
   measurer update, whatever triggers the schema/env incompatibility).
2. Open the PR.
3. **Apply the `baseline-migration` label to the PR FIRST,** before
   triggering the baseline refresh. This step must come first
   because the `workflow_dispatch` refresh authorization checks for
   an open PR that (a) has the label and (b) has a head SHA
   matching the dispatch commit. Without the label in place, the
   refresh would fall back to the trusted script from `main` and
   emit an old-shape baseline that cannot match the new code.
   Applying the label is a triage action that requires repository
   write access, creating a human checkpoint.
4. Trigger the refresh:
   `gh workflow run ci.yml -f update_baseline=true --ref <branch>`.
   The authorization step sees the labeled PR at the current SHA
   and runs the PR's own `scripts/measure-startup.ts` (necessary
   for new-schema or new-measurer migrations).
5. Download the `startup-latency-baseline` artifact and commit it
   to the branch.
6. Push. The next CI run sees the label on the PR event payload,
   passes `--allow-migration` to the trusted script, and gates
   against the refreshed working-tree baseline with a loud
   `::warning::` annotation explaining the fallback.
7. Review the PR: the baseline diff is visible, the label is
   visible, and the warning annotation appears in the check output.
   Reviewers can decide whether the new numbers are reasonable.

### Fork PRs: migration refresh requires a base-repo branch

The workflow_dispatch baseline refresh authorization binds to
(PR head SHA × head repository owner × baseline-migration label).
The head-repository-owner check prevents a fork PR from running
its own `scripts/measure-startup.ts` during refresh — even if a
maintainer triggers the dispatch with the migration label in
place. This is a deliberate paranoia: fork PRs are inherently
less trusted, and the `workflow_dispatch` trigger in GitHub
Actions does not expose the fork branch as a ref the base repo's
Actions tab can select cleanly.

If a fork PR needs a migration refresh (schema change, Bun
upgrade, measurer update), a maintainer must push the fork's
branch into the base repo (e.g. `git fetch fork branch && git
push origin branch:migration-from-fork`) and run the refresh
against that base-repo branch. Once the refresh artifact lands,
the maintainer can merge it into the fork PR via a new commit or
via recreating the PR from the base-repo branch.

This is a known limitation and a trade-off against security
complexity. For same-repo branches the documented flow above
works as-is.

**Failure mode if you forget the label:** CI prints a clear error
message listing the mismatch reasons and pointing at this doc. Apply
the label; the workflow subscribes to the `labeled` pull_request
event type so adding the label automatically re-triggers a fresh
run with the updated label state (no manual re-run or dummy commit
needed).

**Post-merge push on main:** once the migration PR merges, the
`push` workflow on `main` runs the same gate. It re-authorizes
migration mode automatically when the pushed commit range modifies
`bench/startup-baseline.json` — the diff itself is evidence that a
legitimate baseline change just landed. Without this, the post-merge
push would hit the same schema/env mismatch as the PR and fail
despite the PR already being approved.

This is the "explicit migration mode" — visible in PR diffs, label-
gated, loud in CI logs, and unable to hide a regression because the
PR author still had to generate the new baseline in CI *and* get a
triager to apply the label.

**Non-migration PRs that touch `bench/startup-baseline.json` are
still visible in review.** The gate trusts them if the ref baseline
is incompatible (migration) or missing (bootstrap); otherwise the
normal ref baseline is used and the PR's working-tree baseline is
effectively ignored. A malicious PR cannot quietly inflate the
baseline to bypass drift detection — it can only do so in a visible
migration or bootstrap scenario.

## Refreshing the baseline

A baseline refresh is sometimes legitimate — for example, when a new
feature adds real and necessary startup cost, or when we upgrade Bun and
the new runtime has a different startup curve.

The rule: **baselines only come from CI.** A laptop-recorded baseline
is not a valid comparator for a GitHub Actions runner.

To refresh:

```bash
gh workflow run ci.yml -f update_baseline=true
```

The workflow runs on your branch, measures the scenarios, and writes the
refreshed `bench/startup-baseline.json`. It also uploads the file as a
`startup-latency-baseline` artifact so you can download, inspect, and
commit it in the same PR that justifies the refresh.

Reviewers should see a refresh PR and ask: *why did startup cost
increase?* If the answer is "we added a real feature and the new cost
is justified", merge the PR. If the answer is "we don't know", do not
merge.

## Known limitations

### Two-phase rollout — initial landing is warn-only

Borrowed from Claude Code's `src/bridge/trustedDevice.ts` staged
enforcement pattern: the initial rollout PR that introduces this
gate runs with `--warn-only` hard-coded into the workflow
invocations. In warn-only mode the script measures, reports, and
uploads the artifact, but any gate violations produce a GitHub
Actions `::warning::` annotation instead of a non-zero exit.

The reason: if the very first PR enforced the gate, a green
check on that PR would be the only evidence that its own
PR-authored measurer and budgets are correct. That is
self-certification — exactly the trust boundary we want to
avoid. Warn-only decouples "the measurement infrastructure is
landing" from "enforcement is active", so the reviewer of the
initial rollout evaluates the measurer itself, and a separate
follow-up PR enables enforcement by removing `--warn-only` from
the workflow (a single, easily-auditable diff).

**Rollout sequence:**

1. **Phase 1 — measurement lands, gate is warn-only**
   This PR. The workflow, script, harness, baseline, and all
   guardrails ship on main. CI runs the gate on every PR and
   push but never blocks. Warning annotations surface any
   drift. Reviewers evaluate the measurer code independent of
   any green/red check.

   **IMPORTANT:** the `startup-latency` job MUST NOT be added
   to branch protection's required status checks during
   Phase 1. A green check in warn-only mode is telemetry, not
   enforcement. Treating it as a required check creates a
   false sense of protection because any regression would
   still pass.
2. **Phase 2 — enforcement enabled**
   A follow-up PR on main removes `--warn-only` from the two
   workflow invocations in `.github/workflows/ci.yml`. That
   diff is one line per invocation; a reviewer confirms only
   the flag changed and that no measurer code was touched.
   After merge, the `startup-latency` job can be added to
   required status checks. Before merge, the follow-up PR
   itself must be validated against the post-change gate
   (i.e. it needs to pass the now-enforcing gate on its own
   measurement to prove the budgets and baseline are
   acceptable).

### Initial bootstrap runs hard-budget-only

The very first PR that introduces this gate — and any future
situation where neither the trusted ref nor `origin/main` has a
committed baseline — runs in **hard-budget-only mode**. In this
mode the gate does NOT compare against the PR's working-tree
baseline file, because the PR author controls that file and
self-authored drift is exactly the failure mode we guard against.

Only the `budgetMs` ceilings defined in `SCENARIOS` at the top of
`scripts/measure-startup.ts` are enforced. Those come from the
trusted script (pulled from `origin/main` in CI), so a PR cannot
silently inflate them without also modifying the script — which is
a visible code diff, and gate-touching code changes require the
`baseline-migration` label anyway.

The PR's own `bench/startup-baseline.json` file is still recorded
(so reviewers can sanity-check the CI-generated numbers) but it's
not used as a comparator. Once the bootstrap PR merges, `main` has
a committed baseline, and all subsequent PRs use normal ref-based
drift comparison against it.

**Sanity-check checklist for reviewers of the bootstrap PR:**
- Is the baseline CI-generated (not a local run)? Check the
  `environment.runner` field — should be `github-actions/...`.
- Are the numbers reasonable? For `--version` on a modern bundle,
  p50 should be ~15–30 ms. For `command-dispatch`, p50 should be
  ~50–150 ms. Numbers above that on an ubuntu-latest runner
  warrant investigation.
- Do the hard budgets in `SCENARIOS` look appropriate? 250 ms for
  fast-path and 2000 ms for command-dispatch should leave plenty
  of headroom over the current numbers.

The alternative — splitting the rollout into "land the gate without
enforcement" + "separate PR to land the baseline and enable
enforcement" — is operationally cleaner but the bootstrap mode
above delivers the same safety property: no drift comparison
against a PR-authored file. Trade-off accepted.



### The measurement surface is a hand-maintained surrogate

The `command-dispatch` scenario spawns `dist/bench-entry.js`, not
`dist/bin.js`. That file mirrors `bin.ts`'s dispatch sequence and is
built through the same tsup pipeline with the same chunks, but the
*source* (`src/bench-entry.ts`) is hand-maintained. A parity test in
`packages/meta/cli/src/benchmark.test.ts` enforces that both files
contain the same critical tokens (`args.js`, `parseArgs`,
`isTuiFlags`, `isKnownCommand`, `registry.js`, `COMMAND_LOADERS`),
but that check is static — it can't prove semantic equivalence.

If `bin.ts` grows a new dispatch step that shares no tokens with the
old path (e.g. a new pre-parse middleware), the parity test may pass
while `bench-entry.ts` silently measures a different code path. The
mitigation is review discipline: when you change `bin.ts`'s dispatch,
update `bench-entry.ts` in the same PR and run the bench locally to
confirm numbers are still meaningful. This is acknowledged as a
persistent known limitation.

### The gate only measures up to — not through — `run()`

The `command-dispatch` scenario exits at the boundary where
`bin.ts` would call `mod.run(flags)`. That means it catches
regressions in:

- `bin.ts` top-of-file code (fast-path, argv slice)
- `args.ts` import + parse
- `registry.ts` import
- The `start` command loader + its top-level imports
  (`@koi/channel-cli`, `@koi/core`, `@koi/engine`, `@koi/harness`)

It does NOT catch regressions in code that runs *inside*
`start.ts`'s `run()` body — manifest loading, API config resolution,
hook loader, channel setup, transcript prep. Those are all cost the
user pays before `koi start` becomes interactive, and they can grow
unbounded without the gate noticing.

We accept this trade-off deliberately: measuring inside `run()`
would require a probe/hook inside the command module itself, which
re-opens the "shipped backdoor" footgun that #1637 was designed to
avoid. When/if post-`run()` startup cost becomes the dominant
concern, the right fix is a separate end-to-end latency gate that
exercises the real command up to its first interactive prompt —
not a probe bolted onto the existing one.

If you are landing work that moves cost from import-time into
`run()`, note it in the PR description so reviewers can decide
whether that shift is acceptable.

## Other limitations

- **We measure the dev-build `dist/bin.js`, not a shipped wrapper.** Koi
  does not yet publish an npm wrapper or a `bun build --compile`
  standalone binary. When we do, we'll need to extend the gate to
  measure the packaged artifact. The dev build is the closest proxy.
- **Single `ubuntu-latest` runner.** We do not run the gate across a
  macOS/Windows matrix. Runner-class variance dominates cross-OS
  variance at these sample sizes, and adding a matrix would triple CI
  flakiness without proportional value.
- **Bun version is pinned** in `.github/actions/setup/action.yml`. If
  you upgrade Bun, also refresh the baseline in the same PR. Mismatches
  cause the gate to fail loud (not silently pass) with a clear message.
- **No phase checkpoints yet.** Claude Code instruments its CLI with
  named phase checkpoints so regressions can be attributed to a phase
  without bisecting. We may adopt that pattern if bisect-and-profile
  becomes the bottleneck.

## Adding a new scenario

If you have a new code path that matters for startup and isn't covered
by the existing two scenarios:

1. Add an entry to the `SCENARIOS` const in
   `scripts/measure-startup.ts`. Pick an argv that reaches the code
   path *without* triggering side effects like network calls or service
   startup — the whole point is a stable measurement. If you need a new
   exit hook, add it to a new non-shipped harness file in
   `packages/meta/cli/scripts/` — never to `bin.ts`, and never as an
   environment variable or hidden flag on the shipped CLI.
2. Set a `budgetMs` that matches the scenario's p50 in CI plus some
   headroom. Don't use the current measurement as the budget; leave
   room for legitimate growth.
3. Refresh the baseline via the workflow dispatch above.
4. Document the new scenario in this file.
