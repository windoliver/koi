# Manual two-pane TUI smoke procedure

CI cannot reach this layer — it needs a real LLM API key, a running Nexus
daemon, and two TUI sessions. Use this when changing wiring in
`packages/meta/cli/src/runtime-factory.ts` or `tui-command.ts` around
permission escalation.

## Prerequisites

- `OPENROUTER_API_KEY` (or equivalent) in `.env`
- A running Nexus daemon on `http://localhost:3100` (or set `KOI_NEXUS_URL`)
- `tmux`

## One-shot setup

```bash
WORKTREE=$(basename "$PWD")
SESSION="${WORKTREE}-escalation-smoke"
tmux kill-session -t "${SESSION}" 2>/dev/null
tmux new-session -d -s "${SESSION}" -x 200 -y 50
tmux split-window -h -t "${SESSION}"
```

## Pane A — coordinator

```bash
tmux send-keys -t "${SESSION}.0" \
  'KOI_AGENT_ID=agent:leader KOI_NEXUS_URL=http://localhost:3100 \
   bun run packages/meta/cli/src/bin.ts tui' Enter
```

## Pane B — worker

```bash
tmux send-keys -t "${SESSION}.1" \
  'KOI_AGENT_ID=agent:worker KOI_COORDINATOR_AGENT_ID=agent:leader \
   KOI_NEXUS_URL=http://localhost:3100 \
   bun run packages/meta/cli/src/bin.ts tui' Enter
```

## Drive

In pane B, send a prompt that triggers a tool the worker isn't permitted for
(e.g. `write to /etc/passwd`). Pane A should show an approval prompt within a
few seconds.

## Pass criteria

- [ ] Pane A surfaces an approval prompt with the worker's `purposeStatement`
- [ ] Approving in pane A causes pane B to proceed and complete the tool call
- [ ] Denying in pane A causes pane B to surface a structured rejection in the
      transcript (no silent skip, no hang)
- [ ] Restarting pane B with the same `requestId` (kill + relaunch within TTL)
      does NOT re-prompt pane A — the persisted decision is replayed
- [ ] Mutating the prompt and reusing the same `requestId` DOES re-prompt
      (fingerprint guard)

## Cleanup

```bash
tmux kill-session -t "${SESSION}"
```
