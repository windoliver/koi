---
name: review-loop
description: >
  Adversarial review-fix convergence loop. Runs Codex adversarial-review,
  fixes every finding, then reviews again — up to 10 rounds or until clean.
  Triggers on: "review loop", "review and fix", "harden this code",
  "keep reviewing until clean", "adversarial review", "codex review".
allowed-tools: Bash Read Write Edit Glob Grep Agent
---

# Adversarial Review-Fix Loop

You are running a convergence loop: Codex adversarial-review finds issues, you fix them, repeat until the code passes or you hit the round cap.

## Arguments

`$ARGUMENTS`

- `--rounds N` — max rounds (default: 10)
- `--base <ref>` — passed through to adversarial-review
- `--scope <auto|working-tree|branch>` — passed through to adversarial-review
- Any remaining text is passed as focus text to adversarial-review

## Loop Protocol

You MUST follow this protocol exactly. Do not skip rounds. Do not stop early unless the exit condition is met.

### Round Counter

Maintain a round counter starting at 1. Print a header at the start of each round:

```
══════════════════════════════════════
  ROUND {N}/{MAX} — Adversarial Review
══════════════════════════════════════
```

### Step 1: Run adversarial-review

Run the review in foreground (always `--wait`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --wait [--base <ref>] [--scope <scope>] [focus text]
```

Capture the full output.

### Step 2: Parse the result

The review outputs JSON with this structure:
```json
{
  "verdict": "approve" | "needs-attention",
  "summary": "...",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "title": "...",
      "body": "...",
      "file": "path/to/file",
      "line_start": 10,
      "line_end": 20,
      "confidence": 0.9,
      "recommendation": "..."
    }
  ],
  "next_steps": ["..."]
}
```

### Step 3: Check exit condition

**EXIT if ANY of these are true:**
- `verdict` is `"approve"` — print `PASSED on round {N}` and stop
- `findings` array is empty — print `PASSED on round {N} (no findings)` and stop
- Round counter equals max rounds — print `ROUND CAP REACHED ({MAX} rounds). Remaining findings:` then list them and stop

**If none of the exit conditions are met, continue to Step 4.**

### Step 4: Fix each finding

For each finding in the `findings` array, ordered by severity (critical first):

1. Read the file at the specified lines
2. Understand the finding's `body` and `recommendation`
3. Apply the fix using the Edit tool
4. Print: `Fixed: {title} ({file}:{line_start})`

Only fix findings with confidence >= 0.5. Skip low-confidence findings and note them.

### Step 5: Increment and continue

After all fixes are applied:
1. Increment round counter
2. Go back to Step 1

## Important Rules

- NEVER skip a round. If round 3 finds issues, you MUST fix them and run round 4.
- NEVER declare "good enough" early. Only the exit conditions in Step 3 can stop the loop.
- Fix findings by editing the actual code, not by adding comments or TODOs.
- If a fix introduces a syntax error or breaks the code, revert it and note it as unfixable.
- If the same finding keeps recurring across rounds (same file + similar title), skip it on the third occurrence and note it as a persistent issue.
- Do not run tests or build commands unless the finding specifically requires it to verify.
- Print a final summary when done:

```
══════════════════════════════════════
  REVIEW LOOP COMPLETE
  Rounds: {N}/{MAX}
  Result: {PASSED | CAPPED}
  Total findings fixed: {count}
  Persistent/skipped: {count}
══════════════════════════════════════
```
