# ClawBench harness

Runs [ClawBench](https://github.com/claw-bench/claw-bench) tasks against koi headless and aggregates scores.

## Task source

The runners read tasks from `$CLAWBENCH_SRC/tasks` (default `/tmp/claw-bench-src/tasks`).
`setup-tasks.sh` populates that checkout from the **koi-maintained fork** of claw-bench,
which carries reference-solution fixes — upstream claw-bench ships broken oracles
(84 of 319 reference solutions fail their own verifiers; the fork's oracle is 319/319).

It is invoked automatically on first run by `run-quick.sh`, `run-domain.sh`, and
`run-all-remaining.sh` when the checkout is missing. Run it manually to refresh:

```bash
clawbench/setup-tasks.sh
```

### Overrides (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `CLAWBENCH_REPO` | `https://github.com/JingW6/claw-bench.git` | Git URL to clone the task tree from |
| `CLAWBENCH_REF`  | `main` | Branch/tag/sha to check out |
| `CLAWBENCH_SRC`  | `/tmp/claw-bench-src` | Local checkout directory |

To run against upstream (unfixed) tasks instead:

```bash
CLAWBENCH_REPO=https://github.com/claw-bench/claw-bench.git clawbench/setup-tasks.sh
```

## Running

```bash
clawbench/run-quick.sh                 # 20-task smoke set
clawbench/run-domain.sh file-operations
clawbench/run-all-remaining.sh         # every domain without a summary yet
clawbench/run-task.sh "$CLAWBENCH_SRC/tasks/file-operations/file-002-csv-to-json"
```

Results land in `clawbench/results/` (git-ignored).
