# Koi User Guide

Getting started with Koi, one step at a time. Start local, add one thing at a time, don't move on until the current step works.

## Before You Start

- Bun 1.3.x installed
- One model provider key ready (e.g., `ANTHROPIC_API_KEY`)
- Building from the monorepo (Koi is not yet published to npm)

## How To Run `koi`

From the monorepo:

```bash
git clone https://github.com/windoliver/koi.git
cd koi
bun install
bun run build:cli
```

Then create and run an agent:

```bash
bun run koi -- init my-agent   # interactive wizard
cd my-agent
bun run up                     # starts everything
```

Inside a generated agent directory, these `bun run` scripts are available:

```bash
bun run up            # koi up — runtime + admin + TUI
bun run dry-run       # validate config without starting
bun run start:admin   # lighter: CLI + admin, no TUI
bun run tui           # attach TUI to a running admin API
bun run doctor        # diagnose health
```

## Nexus Mode: Local First

Leave `nexus.url` unset for local embed mode. This is the default and recommended starting point.

When you want remote/shared Nexus later, change only the URL:

```bash
# One-off remote switch
NEXUS_URL=https://nexus.example.com bun run up

# Or in koi.yaml
nexus:
  url: https://nexus.example.com
```

## Demo 1 — First Contact

**Goal**: prove the agent starts, CLI chat works, admin panel loads.

**Preset**: `local` (simplest)

1. Run `bun run koi -- init my-agent`, pick the **local** preset.
2. `cd my-agent`
3. Fill in your model API key in `.env`
4. `bun run dry-run` — validate config
5. `bun run up` — start everything
6. Send a trivial prompt: "say hello and tell me what tools you have"
7. Open `http://localhost:3100/admin` in a browser

**Pass when**:
- `bun run dry-run` passes
- CLI chat returns an answer
- Admin panel loads

## Demo 2 — Full Demo Experience

**Goal**: see forge, autonomous mode, demo data, TUI, and helper agents.

**Preset**: `demo`

1. Run `bun run koi -- init demo-agent`, pick the **demo** preset.
2. `cd demo-agent`
3. Fill in your model API key in `.env`
4. `bun run up`
5. The TUI auto-attaches. Chat with the agent.
6. Try: "What did I learn?" or "Show me data." — these use the seeded HERB dataset.
7. Check the admin panel at `http://localhost:3100/admin`

**What the demo preset auto-provisions**:
- HERB enterprise data: 530 employees, 120 customers, 30 products, 20 Q&A pairs
- Forge (self-extension) enabled
- Autonomous mode enabled
- TUI operator console
- `research-helper` agent alongside your primary agent
- Soul personality at `.koi/SOUL.md`

**Pass when**:
- Agent answers questions about HERB data
- TUI shows the session
- Admin panel shows agent status and data sources
- Forge-related events appear in logs

## Demo 3 — Adding Channels

**Goal**: add one non-CLI channel while keeping everything healthy.

1. Start from a working Demo 1 or Demo 2 setup.
2. Add one channel to `koi.yaml`:

```yaml
channels:
  - name: "@koi/channel-cli"
  - name: "@koi/channel-telegram"    # or slack, discord
```

3. Add the token to `.env`
4. `bun run up`
5. Send the same prompt from both CLI and the new channel

**Pass when**: both channels receive answers, admin panel shows both.

## Demo 4 — Middleware and Safety

**Goal**: add budget controls, permissions, and audit.

```yaml
middleware:
  - "@koi/middleware-pay": { budget: { daily: 0.50 } }
  - "@koi/middleware-permissions": { default: ask }
  - "@koi/middleware-audit": {}
```

**Pass when**: agent still answers, approval requests are visible, denied actions show in logs.

## Demo 5 — Multi-Agent (Mesh)

**Goal**: run multiple agents with governed delegation.

**Preset**: `mesh`

1. `bun run koi -- init mesh-demo`, pick the **mesh** preset.
2. `cd mesh-demo && bun run up`
3. This starts gateway + node in addition to everything from demo preset.

**Pass when**: routing between agents is observable in admin panel.

## Ports

| Command | Port | What |
|---------|------|------|
| `koi up` / `koi start --admin` | 3100 | Admin API + panel |
| `koi serve --admin` | 9100 | Health + admin (shared) |
| `koi admin` | 9200 | Standalone admin |
| `koi tui` | connects to 3100 | TUI client |

## Troubleshooting

- **Manifest errors**: run `bun run dry-run`
- **Admin panel missing**: confirm you used `koi up` (not `koi start` without `--admin`)
- **TUI can't find agent**: confirm admin is running on port 3100
- **Nexus errors**: remove any explicit `nexus.url` / `NEXUS_URL` to fall back to local embed
- **`bun install` fails at lefthook**: run `lefthook install --force`
