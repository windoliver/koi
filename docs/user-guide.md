# Koi Progressive User Guide

This is the single doc to use when you want to test Koi without getting crushed by the full package surface. It follows [`demo-strategy.md`](../demo-strategy.md), starts with Demo 1, and only asks you to add one new moving part at a time.

The rule for this guide is simple:

1. start local
2. keep Nexus in local embed mode by default
3. keep the CLI channel on
4. use `koi start --admin` first so you get CLI, admin panel, and TUI together
5. only move to the next demo when the current checklist passes
6. when you switch to remote Nexus, change only the URL

Use [`package-coverage-map.md`](./package-coverage-map.md) only when you need package-by-package detail.

## Before You Start

For the first demos, assume all of this unless you have a strong reason not to:

- Bun 1.3.x is installed
- you have one model provider key ready, such as Anthropic or OpenAI
- `uv` is installed and on `PATH`
- the `nexus` command is available through `uv run nexus`
- you are willing to stay on one machine until Demo 1 and Demo 2 feel boring

Why `uv` matters:

- local Nexus embed mode currently resolves its binary as `uv run nexus`
- that means local auto-start is zero-config at the Koi level, but it still depends on `uv` being present

If `uv run nexus` is missing, fix that first. Do not jump to remote Nexus just to get around local setup.

## How To Run `koi`

The examples below use `koi ...` for readability.

If you already have a `koi` binary installed, use the commands exactly as written.

If you are running from this monorepo, do this first:

```bash
git clone https://github.com/windoliver/koi.git
cd koi
bun install
bun run build:cli
```

Then run the CLI from the repo as:

```bash
bun run koi -- start --dry-run
bun run koi -- start --admin
bun run koi -- tui
```

Notes for the monorepo path:

- `bun install` may fail in `lefthook install` if this repo already has a local `core.hooksPath`; if that happens, run `lefthook install --force` and continue
- the repo does not put a plain `koi` binary on your shell `PATH`; inside this repo, use `bun run koi -- ...`
- if you want the full workspace built, `bun run build` still works, but `bun run build:cli` is the shortest first-timer path

## Nexus Mode: Local First, Remote By URL Only

This is the most important setup rule in the whole guide:

- local mode: do not set `nexus.url`, do not pass `--nexus-url`, do not set `NEXUS_URL`
- remote mode: keep the same agent and the same rest of the manifest, and provide only a remote URL

The CLI already resolves Nexus in this priority order:

1. `--nexus-url`
2. `NEXUS_URL`
3. `nexus.url` in `koi.yaml`
4. no URL -> local embed mode

That means the intended switch really is this simple:

```bash
# Local embed mode
koi start --admin

# One-off remote switch for this launch only
koi start --admin --nexus-url https://nexus.example.com

# Or use an env var
NEXUS_URL=https://nexus.example.com koi start --admin
```

And if you want the switch to live in config instead of the shell:

```yaml
nexus:
  url: https://nexus.example.com
```

If changing from local to remote Nexus requires extra manifest rewrites, treat that as a bug.

## Ports You Will Use

- `koi start --admin` -> admin API on `http://localhost:3100/admin/api`
- `koi tui` -> defaults to `http://localhost:3100/admin/api`
- `koi serve --admin` -> admin panel shares the service port by default, usually `9100`
- `koi admin` -> standalone admin panel on `9200` by default

For the first two demos, stay on `koi start --admin` so you do not have to think about multiple ports.

## Commands You Will Reuse

```bash
koi init my-agent
koi start --dry-run
koi start --admin
koi tui
koi serve --admin --port 9100
koi doctor
```

## Base `koi.yaml` For Demo 1

Start from something this small:

```yaml
name: demo-1-first-contact
version: 0.1.0
description: First local Koi demo
model: "anthropic:claude-haiku-4-5-20251001"
engine: loop

# Leave nexus.url unset for local embed mode.
# Add it only when you intentionally switch to remote/shared Nexus.
# nexus:
#   url: https://nexus.example.com

channels:
  - name: "@koi/channel-cli"

context:
  bootstrap: true
```

Important:

- there is no active `nexus:` section here on purpose
- leaving `nexus.url` unset is what keeps you in local embed mode
- `@koi/channel-cli` stays on so you always have one simple way to drive the agent
- `context.bootstrap: true` gives you the normal local bootstrap path without extra work

## Demo 1 - First Contact (P1)

Goal:

- prove the agent starts
- prove CLI chat works
- prove admin panel works
- prove TUI can attach and chat
- prove local Nexus embed mode is not getting in your way

Packages you are exercising:

- `koi`, `@koi/cli`
- `@koi/manifest`, `@koi/starter`
- `@koi/channel-cli`
- `@koi/engine`, `@koi/engine-pi`
- `@koi/tui`
- `@koi/nexus-embed`

Steps:

1. Create the demo app.

```bash
koi init my-agent
cd my-agent
```

2. Open the generated `koi.yaml` and make sure it matches the base manifest above.

3. Dry-run it first.

```bash
koi start --dry-run
```

4. Start the agent with admin enabled.

```bash
koi start --admin
```

5. In another terminal, start the TUI.

```bash
koi tui
```

6. In the CLI window, send one trivial prompt such as `say hello and tell me what tools you have`.

7. In the TUI:

- attach to the running agent
- verify you can see the session
- send one short prompt
- hit `Esc`
- use `/sessions` to confirm the session exists

Stop checklist for Demo 1:

- `koi start --dry-run` passes
- CLI chat returns an answer
- admin panel loads on `http://localhost:3100/admin`
- TUI opens without extra flags
- TUI can attach to the running agent
- `/sessions` shows the saved session after you leave the console

If Demo 1 fails, do not move on. Fix this first:

- manifest errors -> rerun `koi start --dry-run`
- admin missing -> confirm you used `--admin`
- TUI missing agent -> confirm it is pointed at `3100`
- Nexus confusion -> remove any explicit `nexus.url`, `NEXUS_URL`, or `--nexus-url` and retry
- Nexus did not auto-start -> confirm `uv` is installed and that `uv run nexus` works

## Demo 2 - Sessions, Logs, And Real Nexus Behavior (P2)

Goal:

- prove the default local Nexus path is real, not theoretical
- prove sessions and agent files survive beyond one prompt
- prove the local-to-remote switch is only a URL change
- only then add real external connectors

Packages you are exercising:

- everything from Demo 1
- `@koi/context`
- `@koi/context-arena`
- `@koi/transcript`
- `@koi/session-store`
- `@koi/nexus`, `@koi/nexus-embed`

Steps:

1. Keep using `koi start --admin`.

2. Do not add `nexus.url` yet.

3. Add one or two more turns in CLI or TUI.

4. Leave the TUI console with `Esc`.

5. Reopen the same session from `/sessions`.

6. Use `/logs` in the TUI and confirm recent activity is there.

7. Restart `koi start --admin`, then reconnect with `koi tui` and confirm the admin-side agent and session data still make sense.

8. Only after local is stable, test the remote Nexus switch by changing exactly one thing:

- pass `--nexus-url https://nexus.example.com`, or
- set `NEXUS_URL=https://nexus.example.com`, or
- add `nexus.url` to `koi.yaml`

9. Run the same `koi start --admin` and `koi tui` flow again. The rest of the manifest should stay the same.

Only after that should you add real connector demos such as Gmail, Calendar, Drive, Notion, or Todoist.

Stop checklist for Demo 2:

- session resume works from the TUI
- `/logs` returns recent lifecycle data
- restarting the local agent does not make the setup feel stateless
- you can explain to yourself that local Nexus is running because you left `nexus.url` unset
- remote Nexus uses the same agent flow once you provide only the URL

What is still missing at this point:

- third-party credentials
- remote/shared Nexus auth via `NEXUS_API_KEY`
- production deployment

That is fine. Do not add them yet.

## Demo 3 - Verified Forge (P3)

Only do this after Demos 1 and 2 feel boring.

Goal:

- enable forge in a controlled local setup
- keep CLI, admin, and TUI visible while testing it

Add this next:

```yaml
forge:
  enabled: true
```

How to test it:

1. stay on `koi start --admin`
2. ask the agent to identify a missing capability or repeated workflow
3. watch the admin logs and TUI logs for forge-related lifecycle events
4. run `koi doctor` before you treat the setup as stable

Do not combine this with extra channels or remote infrastructure yet.

## Demo 4 - Omni-Channel (P4)

Goal:

- add exactly one non-CLI channel
- prove it works while CLI, admin, and TUI remain healthy

Recommended order:

1. keep CLI on
2. add one real channel you can authenticate today
3. send the same simple task through CLI and that channel
4. confirm the agent still looks normal in the admin panel and TUI

Do not jump straight to "all channels built". One extra channel is enough for the first pass.

## Demo 5 - Time Travel / Sessions (P5)

Treat this as a session-quality demo first, not as a broad systems demo.

What to test:

- can you create a session in the TUI
- leave it
- reopen it
- inspect logs
- tell whether the transcript feels trustworthy

If session resume is flaky, fix that before doing higher-level demos like browser automation, swarm, or voice.

## Demo 6 - Token Economics / Governance (P6)

Add safety one layer at a time.

Suggested order:

1. `@koi/middleware-pay`
2. `@koi/middleware-permissions`
3. `@koi/middleware-audit`

Suggested manifest snippet:

```yaml
middleware:
  - "@koi/middleware-pay": { budget: { daily: 0.50 } }
  - "@koi/middleware-permissions": { default: ask }
  - "@koi/middleware-audit": {}
```

What to verify:

- the agent can still answer normal prompts
- approval requests are understandable
- denied or limited actions are visible in logs
- you can explain what happened after the fact from the admin panel and TUI

## Personal Track After Demo 6

From here on, the right way to use `demo-strategy.md` is phase-by-phase, not all-at-once.

| Demo | Build on | Add only this next | Stop when this is true |
| --- | --- | --- | --- |
| P7 Stock Monitor | Demo 2 + Demo 6 | one finance MCP server | one quote/check flow works end to end |
| P7b Governed Trading | P7 | permissions + audit + approvals around trading calls | risky actions are visibly gated |
| P8 Social Digest | Demo 2 | one content MCP source such as Reddit or YouTube | scheduled or manual digest works once |
| P9 Voice Agent | Demo 4 | voice only | you can complete one voice request without breaking CLI/admin |
| P10 Browser Autopilot | Demo 6 | Playwright/browser only | one safe browser task works with logs visible |
| P11 Smart Home | Demo 6 | Home Assistant MCP only | one read action and one safe write action work |
| P12 Content Creator Pipeline | Demo 5 | one multi-agent content chain | handoff between workers is inspectable |
| P13 Personal CRM | Demo 2 | one CRM backend | one contact lookup/write works |
| P13b AI SDR | P10 + P12 + Demo 6 | governed browser prospecting | outbound flow is visible and controlled |
| P14 Health Tracker | Demo 2 | schedule + memory + one alert channel | one scheduled check-in completes |
| P15 Second Brain | Demo 2 | search + memory only | you can retrieve a saved fact later |
| P16 Learning Loops | P15 | ACE / self-improvement only | the system can record and reuse one learning |
| P17 Evolving Ecosystem | P16 + P3 | crystallization / optimization only | one improvement cycle is explainable |
| P18 Code Copilot | P10 + P12 | filesystem/LSP/manager mode | one coding task runs without losing workspace control |
| P19 Deploy and Operate | Demo 2 | `koi serve --admin` and deploy lifecycle | service starts, stops, logs, and survives restart |
| P20 Personal AI Symphony | everything above | combine only the features you already trust | the final system still feels debuggable |

## Enterprise Track, But Still Progressive

Do not start enterprise demos before the first six personal demos feel stable. Once they do, use this order.

| Demo | Start from | Add next | Stop when this is true |
| --- | --- | --- | --- |
| E1 Everything is a File | Demo 2 | file browser / Nexus-backed paths | paths feel consistent and inspectable |
| E2 Search and Memory | E1 + P15 | search layers only | you can explain where answers came from |
| E3 Agent Mesh | P12 | one extra node or delegated agent | routing is observable |
| E4 Agent Swarm | E3 | task spawn + workspace isolation | workers do not trample each other |
| E5 Governance Stack | Demo 6 | stricter governance presets | denials and approvals are predictable |
| E6 Permissions and Multi-Tenancy | E5 | Nexus-backed permission model | one tenant boundary is clearly enforced |
| E7 Identity and Auth | E5 | delegation chain / identity layer | tokens and actor identity are auditable |
| E8 Payments and Credits | E5 | ledger layer | credits move correctly in one simple scenario |
| E9 Compliance and Audit | E5 | immutable audit path | one workflow is reconstructable from logs |
| E10 Agent Company | E3 + E4 + E5 | org structure only | budget and responsibility are understandable |
| E11 Collusion Detection | E5 | anomaly/fraud signals only | suspicious coordination produces a signal |
| E12 Multi-Tenant SaaS | E6 | shared platform shape | one cross-tenant safety check passes |
| E13 Workflow Automation | E4 | scheduler/workflow trigger only | one workflow triggers and completes |
| E14 Sandboxed Execution | Demo 6 + P10 | one sandbox backend at a time | timeout and failure behavior are clear |
| E15 Agent Evaluation | P3 or P18 | one eval suite | you can compare before vs after |
| E16 Skill Store and Governance | P3 | skill publishing or approval | one skill lifecycle is inspectable |
| E17 Developer Platform and Dashboard | Demo 1 | admin/browser polish only | operator view is trustworthy |
| E18 Data Pipeline and Connectors | E1 + E2 | one connector at a time | sync or import is reproducible |
| E19 Federation and Edge | E3 + E13 | federation only | remote execution routing is visible |
| E20 Enterprise AI Symphony | all proven enterprise demos | compose only trusted pieces | the system stays debuggable under load |

## What To Keep Constant While Testing

Until you are very confident, do not remove these:

- CLI channel
- admin panel
- TUI
- embed-mode Nexus

Those four give you the shortest path to understanding what the system is doing.

## What Is Still Missing From This Guide

These are the places where you will still need custom setup or a follow-up doc:

- credential-by-credential setup for Anthropic, OpenAI, Gmail, Slack, Discord, Telegram, Voice, Home Assistant, HubSpot, finance APIs, and similar demos
- a clean remote/shared Nexus setup section that covers `NEXUS_API_KEY`, shared tenancy, and production-style auth
- a short troubleshooting page for local prerequisites such as `uv run nexus` and monorepo `lefthook` friction
- Temporal and multi-node/federation deployment details
- per-demo production manifests for every single MCP-backed example in `demo-strategy.md`

If you want, the next pass should be:

1. add a `koi.yaml` example for Demo 2
2. add one governed manifest for Demo 6
3. add one browser manifest for Demo 10
4. add one swarm manifest for Demo 12
5. add one remote Nexus example with `NEXUS_API_KEY`

That will keep the guide progressive instead of turning it back into a wall of options.
