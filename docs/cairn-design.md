# Cairn — Standalone Harness‑Agnostic Agent Memory Framework

> **Status:** Design brief — architecture + needs (no code)
> **Date:** 2026‑04‑22

---

> *"Vannevar Bush described the Memex in 1945 — a personal curated knowledge store where the connections between documents are as valuable as the documents themselves. The part he couldn't solve was who does the maintenance."*
>
> **Cairn is that piece.** The agent does the maintenance — continuously, durably, off the request path.

---

## 1. Thesis

**Cairn** is a stand‑alone, harness‑agnostic agent memory framework. It gives any agent loop — local or cloud, open‑source or proprietary — a shared substrate for per‑turn extraction, nightly consolidation, trajectory→playbook learning, hot‑memory prefix injection, typed taxonomy, consent‑gated propagation, and a privacy‑first local default. Its external contract is a tiny MCP surface — **eight core verbs** (`ingest`, `search`, `retrieve`, `summarize`, `assemble_hot`, `capture_trace`, `lint`, `forget`) plus opt‑in extension namespaces for aggregates / admin / federation (§8). Its default backend is **Nexus `sandbox` profile** — a Python sidecar that brings SQLite + BM25S + `sqlite-vec` semantic search in a single `nexus.db` file with zero external services; scale happens through federation to a Nexus `full` hub, not through swapping adapters. The `MemoryStore` contract is still swappable if a team already runs a different store. It is lightweight enough to `bunx cairn` on a laptop and industrial enough to run behind an enterprise gateway — **same interfaces, same Nexus, different topology**.

### 1.a What the end user actually does (KISS)

The rest of this doc is architecture. From the user's seat, Cairn is five things:

```
1. Install once          bunx cairn init                       (30 seconds)

2. Ignore it              — memory just happens on every turn —
                         (no commands, no schema, no config required)

3. Steer in chat          "remember that I prefer X"           → user memory
                         "forget what I said about Y"          → forget verb
                         "what do you know about Z"            → search + retrieve
                         "skillify this"                       → skill promoted

4. Inspect any editor    open <vault>/raw/ in Obsidian / VS Code / vim
                         records are .md files with YAML frontmatter
                         grep works · git works · diff works

5. Extend if you want    edit .cairn/config.yaml
                         swap storage · LLM · orchestrator · sensors · frontend
                         (never a code fork)
```

That's the whole user surface. Everything under this is optional:

| If you want… | Do… | Otherwise… |
|--------------|-----|------------|
| A desktop GUI | Install Cairn Electron app | Use your existing markdown editor |
| Team sharing | `cairn init --template team` + set up hub | Stay on single‑user laptop vault |
| Source sensors (Slack, email, GitHub) | Enable in config | Just use hook + IDE sensors |
| Custom classifier / ranker / hot‑memory recipe | Write a plugin | Take the defaults |
| Temporal instead of tokio | Set `orchestrator: temporal` (v0.2+) | Run on the built‑in tokio scheduler |

### 1.b First principles (why it stays small as it grows)

1. **Memory is markdown files on disk.** Not a proprietary database. Any editor can read them; `grep` finds them; `git` diffs them.
2. **One contract, one door.** MCP is the only public entry point (eight core verbs + opt‑in extensions). CLI, hooks, library calls — all route through the same verbs.
3. **Schema is YAML frontmatter.** No migrations. Add or disable `MemoryKind`s in `.cairn/config.yaml`; the pipeline follows.
4. **Plugins, not forks.** Every non‑trivial component is behind a typed contract; swapping is a config line. The default plugins and third‑party plugins use the same registration path.
5. **Local‑first, cloud‑optional.** `bunx cairn` works on a fresh laptop with zero credentials. Cloud is opt‑in per sensor and per write path.
6. **Failures become skills.** Skillify (§11.b) turns any observed failure into a tested, durable skill. The agent gets better from use, not from retraining.
7. **No hidden state.** Every mutation goes through the WAL (§5.6); every promotion goes through the nine‑gate predicate (§11.3); every consent decision lands in the append‑only journal (§14).

These are the load‑bearing invariants — everything else in this doc is consequence.

---

## 2. Design Principles (non‑negotiable)

1. **Harness‑agnostic.** Works with any agent loop that can speak MCP.
2. **Default to one backend; scale by federation, not by swapping.** Nexus `sandbox` profile is the default `MemoryStore` at every tier (embedded, local, cloud). Scale‑up is federation from sandbox → Nexus `full` hub over HTTP — not a code change in Cairn. The contract is still swappable if a team already runs a different store, but Cairn does not "multi‑backend for multi‑backend's sake".
3. **Stand‑alone.** `bunx cairn` on a fresh laptop with zero cloud credentials works end‑to‑end.
4. **Local‑first, cloud‑optional.** The vault lives on disk. Cloud is opt‑in per sensor, per write path.
5. **Narrow typed contracts.** Five real interfaces. Fifteen pure functions. Everything else is composition.
6. **Continuous learning off the request path.** A durable `WorkflowOrchestrator` runs Dream / Reflect / Promote / Consolidate / Propagate / Expire / Evaluate in the background. Default v0.1 implementation is `tokio` + a SQLite job table; Temporal is an optional adapter. Harness latency is untouched in either case.
7. **Privacy by construction.** Presidio pre‑persist, per‑user salt, append‑only consent log, no implicit share.
8. **MCP is the contract.** If a harness speaks MCP it speaks Cairn.
9. **Procedural code owns the environment. The agent owns content.** Deterministic hooks + workflows do classification, validation, indexing, and lifecycle. Content decisions (what to write, where to file, what to link) stay with the agent.
10. **A note without links is a bug.** Orphan detection is a first‑class metric.
11. **Good answers file themselves back.** `summarize(persist: true)` turns a synthesis into a new memory with provenance.
12. **Folders group by purpose. Links group by meaning.** A memory lives in one file; it links to many.
13. **Compiled once, kept current.** Knowledge is compiled into the vault once, then maintained — not re‑derived from raw sources on every query. The maintenance is the LLM's job; the curation is the human's.
14. **Sources are immutable; records are LLM‑owned; schema is co‑evolved.** Three layers, strict roles. Humans never edit records; LLMs never edit sources; both evolve the schema together.
15. **Plugin architecture, interface programming.** Every non‑trivial component is behind a typed contract. Default implementations sit alongside third‑party plugins with **no special privileges** — the same registry, the same loader, the same public traits. Cairn's L0 core has zero dependencies on any storage, LLM provider, workflow engine, sensor, or UI shell. Swapping a plugin is a config change, not a code fork.

---

## 3. Vault Layout (the on‑disk surface)

Flat markdown. Git‑friendly. Obsidian‑compatible. Editor‑agnostic. Three layers, strict roles.

| Layer | Folder | Who writes it | Mutability | Publicness |
|-------|--------|---------------|------------|------------|
| **Sources** — immutable inputs | `sources/` | the human (drops files in) + source sensors | append‑only; Cairn never mutates | private by default |
| **Working memory** — LLM‑owned raw records | `raw/`, `index.md`, `log.md` | the agent | read/write by LLM and workflows | private |
| **Public artifacts** — promoted, curated, quotable | `wiki/`, `skills/` | the agent via `PromotionWorkflow`, review‑gated | read/write but promotions are change‑controlled | crosses visibility tiers (§6.3) |
| **Schema** — conventions the LLM follows | `purpose.md`, `.cairn/config.yaml`, `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` | the human, co‑evolved with the LLM | edited by humans | private unless the vault itself is shared |

**Working memory vs public artifacts.** `raw/` is always private working memory — it may contain half‑formed ideas, unconfirmed beliefs, contradictions in flight. `wiki/` and `skills/` are **public artifacts**: every record in them passed evidence gates, conflict resolution, and (when the promotion crosses private→team) a review gate. This is the distinction OpenClaw calls "public artifacts" — Cairn elevates it to a layer of the vault.

The same split Karpathy's LLM‑Wiki pattern prescribes: the LLM compiles and maintains the middle layer, reading from the immutable sources and following the schema. Knowledge is **compiled once and kept current** — not re‑derived on every query.

```
<vault>/
├── purpose.md            SCHEMA — human‑authored; why this vault exists; grounds every session
├── index.md              LLM‑OWNED — auto‑maintained catalog; bounded 200 lines / 25 KB
├── log.md                LLM‑OWNED — append‑only chronological; prefix `## [YYYY-MM-DD] <kind> | <Title>`
│
├── sources/              SOURCES — immutable inputs (never mutated by Cairn)
│   ├── articles/             clipped web articles (markdown via Readability)
│   ├── papers/               PDFs, research
│   ├── transcripts/          meeting / podcast transcripts
│   ├── documents/            DOCX, Notion / Confluence exports, plain text
│   ├── chat/                 Slack / email exports
│   └── assets/               images, attachments referenced by sources
│
├── raw/                  LLM‑OWNED — per‑memory records, one .md per record with frontmatter
│   ├── user_*.md             user preferences, goals, constraints
│   ├── feedback_*.md         corrections and validated approaches
│   ├── project_*.md          project state, decisions, stakeholders
│   ├── reference_*.md        pointers to external systems / documents
│   ├── fact_*.md             claims about the world
│   ├── belief_*.md           claims held with confidence
│   ├── opinion_*.md          subjective stances (user's or sources')
│   ├── event_*.md            things that happened, when
│   ├── entity_*.md           people, orgs, products (become entity pages in wiki/)
│   ├── workflow_*.md         multi‑step procedures
│   ├── rule_*.md             invariants ("never X", "always Y")
│   ├── strategy_success_*.md validated approaches
│   ├── strategy_failure_*.md approaches that did not work
│   ├── trace_*.md            reasoning trajectories (what happened)
│   ├── reasoning_*.md        decision rationales (why the agent chose)
│   ├── playbook_*.md         reusable procedural templates
│   ├── sensor_*.md           raw sensor observations
│   ├── signal_*.md           derived user‑behavior signals
│   └── knowledge_gap_*.md    things the agent could not answer
│
├── wiki/                 LLM‑OWNED — promoted, curated notes with [[wikilinks]]
│   ├── entities/             one page per person / org / product (backlinks = evidence)
│   ├── concepts/             topic / theme / idea pages
│   ├── summaries/            one page per source (derived from sources/)
│   ├── synthesis/            cross‑source analyses, comparisons, canvases
│   └── prompts/              reusable prompt fragments (evolvable artifacts)
│
├── skills/               LLM‑OWNED — distilled procedural skills; LRU‑cached at runtime
│
└── .cairn/               SCHEMA + STATE
    ├── config.yaml           manifest — vault name, tier, adapters, enabled sensors, scopes, UI shell
    ├── consent.log           append‑only, immutable audit trail
    ├── evolution/            PR‑style diffs for evolved artifacts (awaiting review when human_review)
    ├── lint-report.md        latest health check
    ├── metrics.jsonl         per‑event telemetry (including discard reasons)
    └── cache/                embeddings, FTS, graph edges
```

**Flow between layers:**

1. A source lands in `sources/` (drag‑drop, web clip, source sensor).
2. `Capture → Extract → Filter → Classify → Store` writes one or more records into `raw/`.
3. `ConsolidationWorkflow` + `PromotionWorkflow` merge / compress / promote records into `wiki/` pages and `skills/` procedures.
4. `wiki/` pages link to `raw/` records (via frontmatter `source_ids`) which link to `sources/` documents (via frontmatter `origin`). The trail is auditable end to end.
5. `EvaluationWorkflow` + `lint` detect orphans, contradictions, stale claims, and data gaps across all three layers.

**Memory file format.** YAML frontmatter (id, kind, class, visibility, scope, confidence, salience, created, updated, origin, source_ids, provenance, tags, links) + markdown body. Pure functions read/write the frontmatter; LLM calls author the body. Humans rarely edit `raw/` or `wiki/` directly — when they do, the next `ConsolidationWorkflow` pass reconciles.

**Git is first‑class.** The vault is a git repo. Version history, branching, and collaboration come free. Humans curate sources + schema; the LLM edits records + wiki; merge conflicts are resolved by `ConsolidationWorkflow`.

### 3.0 Storage topology — Cairn on top of Nexus primitives

Nexus is the platform; **Cairn is the memory layer** that does not exist in Nexus itself. Nexus gives Cairn four primitives — `filesystem` for storage, `search` for retrieval, `rebac` for scoping, `snapshot` for versioning — plus `parsers`, `workflows`, `mcp`, and `ipc`. All memory semantics (the 19 kinds, consolidation, promotion, evolution, hot‑memory assembly, confidence bands, conflict DAG, etc.) are Cairn's own.

Nexus is the platform; **Cairn is the memory layer** that does not exist in Nexus itself. Nexus has 26 bricks — Cairn uses 13 of them and deliberately ignores the rest.

```
  Cairn Rust core  ──HTTP/MCP──►  Nexus sandbox (Python, ~300 MB RSS, one nexus.db file)
  (owns memory taxonomy, pipeline,
   workflows, Dream / Promote / Evolve)
```

### Nexus bricks Cairn leverages

| Brick | How Cairn uses it |
|-------|-------------------|
| `filesystem` | persist every memory record + source + wiki page as a file with frontmatter; vault tree IS a Nexus path tree |
| `search` | BM25S + `sqlite-vec` (semantic) + `litellm` embeddings — Cairn's `search` and `retrieve` MCP verbs call this |
| `rebac` | enforce `{userId, agentId, project, team, org}` scope + visibility at path level; Cairn never re‑implements ACLs |
| `access_manifest` | declarative policy manifest for visibility tier boundaries (`private` → `session` → `project` → `team` → `org`) |
| `snapshot` | `cairn snapshot` = Nexus snapshot of `/<vault>/`; weekly archive is a one‑call op |
| `versioning` | every memory edit gets undo history via Nexus's operation‑undo service — Cairn doesn't build its own revert |
| `portability` | `.nexus` bundles = Cairn's export/import native format; `cairn export` and `cairn import --from <another-cairn-vault>` are thin wrappers |
| `parsers` | PDF / DOCX / HTML / CSV / Parquet / JSON → markdown on the way into `sources/`; Cairn's source sensors delegate parsing |
| `catalog` | schema extraction for structured sources (CSV/Parquet/JSON) — feeds `entity_*.md` and `fact_*.md` records automatically |
| `share_link` | `PropagationWorkflow` generates consent‑gated share links for `private → team → org` promotion, with expiry + revocation |
| `workspace` | per‑project or per‑user Cairn vaults isolated as separate Nexus workspaces |
| `mcp` | Cairn's eight core verbs register as MCP tools on the Nexus MCP surface; harnesses talk to either side interchangeably |
| `workflows` | optional durable job queue for teams that prefer Nexus‑native orchestration over Cairn's `tokio` default or Temporal |
| `discovery` | dynamic skill + playbook registration — `EvolutionWorkflow` publishes evolved skills through Nexus discovery |

### Nexus bricks Cairn does NOT use

| Brick | Why skip |
|-------|----------|
| `ipc` | filesystem‑as‑IPC for agent‑to‑agent. Cairn agents talk through MCP, not FS‑IPC |
| `auth`, `identity`, `secrets` | the harness upstream owns user auth; Cairn inherits context |
| `pay`, `sandbox` (brick), `mount`, `upload` | out of scope — billing, sandbox provisioning, FUSE, upload UI |
| `context_manifest`, `governance`, `task_manager`, `delegation` | overlap with features Cairn owns (hot memory, user signals, workflow, propagation); revisit if a Nexus primitive becomes clearly better than Cairn's |

### Operational notes

- **No `memory` brick in Nexus today.** Cairn owns memory. If a future Nexus `memory` brick ships, Cairn's adapter can delegate.
- **Two files on disk (backup covers both).** Nexus owns `<vault>/nexus.db` (records, vectors, FTS, metadata); the Rust core owns `.cairn/cairn.db` (control‑plane state — see schema below). Back up by copying both files atomically (or use `cairn snapshot`, which sequences both with a filesystem snapshot).
- **Semantic search is opt‑in.** With an embedding API key (`OPENAI_API_KEY` or any `litellm` provider), `sqlite-vec` is primary. Without a key, BM25S results are stamped `semantic_degraded=true` end to end.
- **Records land through `filesystem` + `search`.** A memory = a markdown file with frontmatter at `/<vault>/raw/<kind>_<slug>.md`. `search` indexes body; `rebac` + `access_manifest` enforce scope; `snapshot` + `versioning` cover backup and undo. Cairn's Rust core **does not speak to the Nexus memory‑store SQLite file directly** — all memory mutations are HTTP calls to the Nexus sidecar. See "Durability topology" below for the full atomicity model.
- **Durability topology (two SQLite files, one ownership line):**
  - **`nexus.db`** — owned by the Nexus Python sidecar. Holds records, vectors, FTS, metadata. Cairn reaches it only over HTTP + MCP.
  - **`.cairn/cairn.db`** — owned by the Rust core, opened directly from the Cairn process. Small (typically < 50 MB). Canonical control‑plane schema (all tables in one DB; this is the authoritative list referenced everywhere else in this doc):

    ```sql
    -- WAL state machine (§5.6)
    CREATE TABLE wal_ops    (operation_id TEXT PK, state TEXT, envelope JSONB, …);
    CREATE TABLE wal_steps  (operation_id TEXT, step_ord INT, state TEXT, PK(operation_id, step_ord));

    -- Replay ledger (§4.2)
    CREATE TABLE used                   (operation_id TEXT, nonce BLOB, issuer TEXT, sequence INT, committed_at INT, UNIQUE(operation_id, nonce));
    CREATE TABLE issuer_seq             (issuer TEXT PK, high_water INT);
    CREATE TABLE outstanding_challenges (issuer TEXT, challenge BLOB, expires_at INT, PK(issuer, challenge));

    -- Concurrency control (§5.6, §10.1)
    CREATE TABLE locks        (scope_kind TEXT, scope_key TEXT, mode TEXT, holder_count INT, lock_id TEXT, leased_until INT, PK(scope_kind, scope_key));
    CREATE TABLE reader_fence (session_id TEXT PK, op_id TEXT, state TEXT);

    -- Audit
    CREATE TABLE consent_journal (row_id INTEGER PK AUTOINCREMENT, op_id TEXT, actor TEXT, kind TEXT, payload JSONB, committed_at INT);
    ```

    These are **local control‑plane state** the Rust core must access natively for single‑host atomicity. They are never shared with Nexus.
  - **Atomicity model.** Cairn uses a durable‑messaging pattern, not a distributed transaction: (1) Rust core commits a local SQLite transaction in `cairn.db` that atomically writes the WAL `PREPARE` row + replay consumption. **No `consent_journal` row is written at PREPARE time** — consent is linearized with the state transition, not with PREPARE. (2) Rust calls the Nexus HTTP apply endpoint, keyed by `operation_id`, which performs its own single local SQLite transaction inside `nexus.db`. (3) On success, the Rust core commits a second short local transaction that atomically marks `wal_ops.state = 'COMMITTED'` **and** writes the `consent_journal` row. This ordering means `consent_journal` only records operations that are reader‑visible (or, for deletes, operations that made data reader‑invisible); a crash between (1) and (2) leaves no consent entry. Crash between (1) and (2) ⇒ recovery re‑calls Nexus with the same `operation_id` (idempotent). Crash between (2) and (3) ⇒ recovery observes Nexus has already applied, then runs step (3) to both promote `COMMITTED` and append the `consent_journal` row in one transaction. Nexus's own durability is guaranteed by its internal SQLite transaction; Cairn's guarantee is that every PREPARED row is either COMMITTED or ABORTED after bounded recovery, and every `consent_journal` row corresponds to a reader‑visible state transition.
  - **No cross‑process two‑phase commit required.** The idempotency key is the linearization primitive; SQLite provides atomicity inside each process. This is strictly weaker than distributed 2PC, and we call it out rather than pretending otherwise.
  - Canonical on‑disk paths: `<vault>/nexus.db` (Nexus memory store) and `.cairn/cairn.db` (Cairn control plane: `wal_ops`, `used`, `issuer_seq`, `outstanding_challenges`, `consent_journal`, `locks`, `reader_fence`). Any other `.cairn/*.db` path in this doc is a typo against these two.
- **Federation, not re‑platforming, scales.** A sandbox on a laptop can federate `search` queries to a remote Nexus `full` hub (PostgreSQL + Dragonfly + Zoekt + txtai). Hub unreachable → graceful BM25S fallback, never a boot failure.
- **Process boundary.** Nexus is Python; Cairn core is Rust. They communicate over HTTP + MCP. `cairn-nexus-supervisor` spawns Nexus, tails logs, health‑checks, restarts.

### 3.1 The layout is a template — configurable, not prescribed

Everything above is the **default** vault shape. Users and teams reshape it through `.cairn/config.yaml`. The three‑layer split (sources / records+wiki / schema) is an **invariant**; everything else is a knob.

**Configurable:**

- Folder names. `sources/` → `inbox/`; `raw/` → `memories/` or `records/`; `wiki/` → `notes/`. Rename any folder; Cairn follows the config.
- Which folders exist. A minimal vault may be just `raw/` + `wiki/` + `.cairn/`. A research vault may add `sources/papers/` only. A team vault may split `wiki/` per project.
- File naming. `kind_slug.md` (default), `YYYY-MM-DD-slug.md`, `<uuid>.md`, or a user regex. Cairn resolves by frontmatter, not filename.
- Index + log caps. `index.md` 200 lines / 25 KB is the default; configurable up or down. `log.md` prefix format is configurable (the grep‑friendly form is the default).
- Enabled `MemoryKind`s. Disable `opinion`, `belief`, `sensor_observation` if the domain doesn't use them. The extraction pipeline only classifies into the enabled set.
- Frontmatter schema extensions. Add user‑defined fields (e.g., `quarter`, `client_id`, `severity`) that Cairn preserves but ignores unless a custom `Ranker` uses them.
- Retention policy per folder. Different decay curves for `raw/trace_*.md` (short) vs `wiki/entities/*.md` (long‑lived).
- Schema files. Default is the harness triple (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`). Users may add `CURSORRULES.md`, `.windsurfrules`, per‑project `PROJECT.md`, or drop the ones they don't use.
- Hot‑memory assembly recipe. Default mixes `purpose.md` + `index.md` + pinned `user/feedback` + top‑salience `project` + active `playbook` + recent `user_signal`. Users override the recipe for their workflow (e.g., researcher wants recent `synthesis/` on top).
- UI shell. `ui.shell: electron | tauri | none`.

**Invariant (never configurable):**

- Three‑layer separation — sources immutable, records+wiki LLM‑owned, schema co‑evolved.
- Provenance is mandatory on every record.
- `consent.log` is append‑only.
- The MCP surface is eight core verbs (plus opt‑in extension namespaces) — the public contract (§8).
- Capture → Store is always on‑path; Consolidate onward is off‑path.
- Discard is never silent — every `no` from Filter writes a reason to `metrics.jsonl`.

**Config sketch** (shape only — the full schema is defined in `cairn-core`):

```yaml
# .cairn/config.yaml
vault:
  name: my-vault
  tier: local                 # embedded | local | cloud
  ui:
    shell: electron           # electron | tauri | none
  layout:
    sources: inbox            # rename sources/ to inbox/
    records: memories         # rename raw/ to memories/
    wiki: notes               # rename wiki/ to notes/
    skills: skills
    enabled_kinds:            # subset of the 19 kinds; empty = all
      - user
      - feedback
      - project
      - reference
      - fact
      - strategy_success
      - strategy_failure
      - trace
      - reasoning
      - playbook
      - knowledge_gap
    file_naming: "{kind}_{slug}.md"
    index:
      max_lines: 200
      max_bytes: 25600
  schema_files:
    - CLAUDE.md
    - AGENTS.md
    - GEMINI.md
  hot_memory:
    recipe:                   # order matters; top is first in prefix
      - purpose
      - index
      - pinned_feedback
      - top_salience_project
      - active_playbook
      - recent_user_signal
    max_bytes: 25600
  retention:
    raw/trace_*.md: 30d
    raw/sensor_*.md: 7d
    raw/signal_*.md: 90d
    wiki/entities/*.md: forever
sensors:
  hooks: { enabled: true }
  ide: { enabled: true }
  screen: { enabled: false }
  slack: { enabled: false, scope: [] }
store:
  kind: nexus-sandbox         # nexus-sandbox | nexus-full | postgres | custom:<name>
  path: <vault>/nexus.db      # canonical location — Nexus-owned memory store (§3 Durability topology)
llm:
  provider: openai-compatible
  base_url: https://…
workflows:
  orchestrator: temporal      # temporal | local
```

A new vault inherits the default config. Teams fork a config as a shareable template (e.g. `cairn init --template research`, `--template engineering`, `--template personal`).

### 3.2 Vault topology — who shares what

A **vault** is the unit of physical colocation + atomic durability: one filesystem tree + one `.cairn/cairn.db` (Rust control plane) + one `<vault>/nexus.db` (memory store) + one `consent.log`. **Users, agents, and sessions are actors WITHIN a vault**, scoped by the identity model in §4.2 and the visibility tiers in §6.3. A vault is never per‑agent or per‑session; isolation across actors happens through scope tuples + rebac, not through separate files.

**Four canonical shapes** (same format, same MCP contract, different scale):

```
  SHAPE 1: LAPTOP SOLO                SHAPE 2: LAPTOP MULTI-AGENT
  ────────────────────                ────────────────────────────
                                      ┌───────────────────────────┐
  ┌─────────────────────┐             │  hmn:alice:v1             │
  │  hmn:alice:v1       │             │  ├─ agt:claude-code:…     │
  │  └─ agt:claude-code │             │  ├─ agt:codex:…           │
  │     └─ sessions…    │             │  ├─ agt:research-bot:…    │
  │                     │             │  └─ agt:reviewer-bot:…    │
  │  ONE VAULT          │             │  └─ sessions (per (user,  │
  │  one user, one      │             │     agent) pair)          │
  │  agent, many        │             │                           │
  │  sessions           │             │  ONE VAULT                │
  │                     │             │  one user, N agents,      │
  │                     │             │  many sessions            │
  └─────────────────────┘             └───────────────────────────┘

  SHAPE 3: TEAM HUB                   SHAPE 4: ORG FEDERATION
  ──────────────────                   ───────────────────────
  ┌───────────────────────┐           ┌──────────────┐   ┌──────────────┐
  │  team-hub vault       │           │ alice laptop │   │ bob laptop   │
  │  ├─ hmn:alice         │           │   (shape 2)  │   │   (shape 2)  │
  │  ├─ hmn:bob           │           └──────┬───────┘   └──────┬───────┘
  │  ├─ hmn:carol         │                  │  federation       │
  │  ├─ agt:team-reviewer │                  ▼                   ▼
  │  ├─ agt:team-deployer │                ┌────────────────────────────┐
  │  └─ sessions (M×N)    │                │  org hub vault             │
  │                       │                │  ├─ all team hubs          │
  │  ONE VAULT (shared)   │                │  ├─ aggregate memory       │
  │  M users, N agents,   │                │  └─ promoted public wiki   │
  │  rebac enforces scope │                │                            │
  └───────────────────────┘                │  N+1 VAULTS, federated via │
                                           │  §12.a share_link/federation│
                                           └────────────────────────────┘
```

**Scope tuples on every record (authoritative):**

| Record field | Values | Source |
|--------------|--------|--------|
| `tenant` | e.g. `acme-corp`, `personal` | vault‑level; set at `cairn init` |
| `user_id` | `hmn:alice:v1` | actor_chain principal (§4.2) |
| `agent_id` | `agt:claude-code:opus-4-7:main:v3` | actor_chain author (§4.2) |
| `session_id` | ULID, auto‑discovered per (user, agent) | §8.1 |
| `visibility` | `private` / `session` / `project` / `team` / `org` / `public` | §6.3 |
| `entity_id` | the record's own ULID | generated at create |

Reads and writes compose these into keyspaces. `retrieve(scope: {user: "alice", agent: "reviewer"})` reads only records where both match. `search(visibility: "team")` reads records shared to the team tier and below, filtered by rebac (§4.2). An agent's `scope` tuple (`allowed_kinds`, `allowed_tiers`, …) from §4.2 restricts what that agent can write — a sandboxed scratchpad agent may write only to `private`, never to `team`.

**When to use which shape:**

| Question | Shape |
|----------|-------|
| "I want agent memory on my laptop" | Shape 1 |
| "Multiple agents on my machine should share context" | Shape 2 — one vault, scope by `agent_id` |
| "Multiple agents should NOT share memory" (privacy / sandbox) | Shape 2 + per‑agent scope restriction + visibility `private` only |
| "My team shares decisions, playbooks, incident postmortems" | Shape 3 — team hub with rebac |
| "Each engineer keeps their own laptop vault but we share org knowledge" | Shape 4 — federation |
| "Agent serves many tenants (e.g., SaaS)" | One vault per tenant (Shape 3 or 4) + `cairn.aggregate.v1` extension for anonymized cross‑tenant insight |

**What a vault is NOT:**

- A vault is not a per‑agent filesystem — N agents share one vault, isolated by `agent_id` + scope.
- A vault is not a per‑session filesystem — session is a metadata tuple, not a physical directory.
- A vault is not a cross‑tenant container — one tenant per vault (hard boundary; federation crosses vaults).

**Per‑agent isolation without per‑agent vaults.** When stronger isolation than rebac is required (regulated domains, adversarial agents), use one of:

1. Separate vaults per agent (multiple `cairn init` roots, each with its own `.cairn/cairn.db`) — administratively heavier but hardest isolation.
2. One vault + `tenant` field set per agent (`tenant: agt:<name>`) — uses the tenant isolation already in §4.2 and §5.6 lock scoping, cheaper than separate vaults.

Most deployments use Shape 1–3 with rebac; the escape hatch exists for the edge cases.

---

## 4. Contracts — the Five That Matter

### 4.0 Overall architecture at a glance

```
                ┌───────────────────────────────────────────────┐
                │   HARNESSES  (CC · Codex · Gemini · custom)   │
                └─────────────────────┬─────────────────────────┘
                                      │  MCP (8 core verbs: ingest · search · retrieve · summarize
                                      │       · assemble_hot · capture_trace · lint · forget
                                      │       + opt-in extensions §8.0.a)
                                      ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                          CAIRN CORE  (L0, Rust, zero runtime deps)             │
│                                                                                │
│   Five contracts (traits)              Pipeline (pure functions)               │
│   ─────────────────────────            ──────────────────────────────          │
│   MemoryStore ◄───────────┐            Extract · Filter · Classify · Scope     │
│   LLMProvider             │  dispatch  Match · Rank · Consolidate · Promote    │
│   WorkflowOrchestrator ◄──┼──────────► Expire · Assemble · Learn · Propagate   │
│   SensorIngress           │            Redact · Fence · Lint                   │
│   MCPServer ◄─────────────┘                                                    │
│                                                                                │
│   Identity layer:  HumanIdentity · AgentIdentity · SensorIdentity              │
│                    Ed25519 keys · actor_chain on every record · ConsentReceipt │
│                                                                                │
│   Crash safety:    WAL (§5.6) · two‑phase apply · single‑writer locks          │
└─────┬──────────────┬────────────────┬──────────────┬───────────────┬───────────┘
      │              │                │              │               │
      ▼              ▼                ▼              ▼               ▼
┌──────────┐   ┌──────────┐    ┌────────────┐   ┌────────────┐   ┌────────────┐
│ Store    │   │ LLM      │    │ Orchestr.  │   │ Sensors    │   │ Frontend   │
│ plugin   │   │ plugin   │    │ plugin     │   │ plugins    │   │ adapter    │
│ (Nexus   │   │ (OpenAI‑ │    │ (tokio     │   │ (hook, IDE,│   │ (Obsidian, │
│ sandbox) │   │ compat.) │    │  default,  │   │  clipboard,│   │  VS Code,  │
│          │   │          │    │  Temporal) │   │  screen,   │   │  Logseq,   │
│          │   │          │    │            │   │  Slack,    │   │  desktop,  │
│          │   │          │    │            │   │  GitHub…)  │   │  headless) │
└────┬─────┘   └──────────┘    └────────────┘   └─────┬──────┘   └─────┬──────┘
     │                                                │                │
     ▼                                                ▼                ▼
┌─────────────────────────┐                 ┌──────────────────┐ ┌────────────────┐
│  <vault>/ (on disk)     │                 │ external systems │ │ third‑party    │
│  ├── sources/    immut. │                 │ (Slack, email,   │ │ editor reads   │
│  ├── raw/        private│                 │  GitHub, Notion, │ │ .md + sidecar; │
│  ├── wiki/  skills/     │                 │  Calendar…)      │ │ optional plug‑ │
│  │           promoted   │                 │                  │ │ in for live UI │
│  ├── .cairn/ config+WAL │                 └──────────────────┘ └────────────────┘
│  └── consent.log audit  │
└─────────────────────────┘
```

**Read this top‑down.** Harnesses call MCP. MCP hits Cairn core. Core dispatches through pure‑function pipelines using the five contracts. Contracts are satisfied by plugins (swap any one via `.cairn/config.yaml`). Plugins touch the outside world: vault on disk, external APIs, third‑party editors.

**Everything you'd plug in has a single socket.** Adding Postgres‑backed storage? Implement `MemoryStore`. Adding a Temporal Cloud workflow runner? Implement `WorkflowOrchestrator`. Adding Typora support? Implement `FrontendAdapter` (§13.5.d). No core changes, no forks.

Everything in Cairn is a pure function over data, except these five interfaces.

| # | Contract | Purpose | Default implementation |
|---|----------|---------|------------------------|
| 1 | `MemoryStore` | typed CRUD + ANN + FTS + graph over `MemoryRecord` | **Nexus `sandbox` profile** (Python sidecar; SQLite + BM25S + `sqlite-vec` for semantic via `litellm` embeddings + in‑process LRU; single DB file, zero external services; ~300–400 MB RSS, <5 s warm boot). **Scale‑up path = federation** — sandbox instances delegate to a **Nexus `full`** hub zone (PostgreSQL + Dragonfly + Zoekt + txtai) over HTTP; Cairn does not switch Cairn‑side adapters to scale. Cairn talks to Nexus over HTTP + MCP, **not in‑process** (Rust core ↔ Python Nexus across the process boundary). |
| 2 | `LLMProvider` | one function — `complete(prompt, schema?) → text \| json` | OpenAI‑compatible (local Ollama, any cloud) |
| 3 | `WorkflowOrchestrator` | durable scheduling + execution for background loops | **Rust‑native default**: `tokio` + a SQLite‑backed job table (durable, crash‑safe, single binary, zero services). **Optional Temporal adapter**: `temporalio-sdk` + `temporalio-client` (both published on crates.io, currently prerelease) when GA; a TypeScript Temporal worker sidecar as the safe path today |
| 4 | `SensorIngress` | push raw observations into the pipeline | hook sensors, IDE, clipboard, screen (opt‑in), web clip |
| 5 | `MCPServer` | harness‑facing tools | stdio + SSE; eight core verbs + opt‑in extensions (§8) |

Everything else — Extractor, Filter, Classifier, Scope, Matcher, Ranker, Consolidator, Promoter, Expirer, SkillEmitter, HotMemoryAssembler, TraceCapturer, TraceLearner, UserSensor, UserSignalDetector, PropagationPolicy, OrphanDetector, ConflictDAG, StalenessScanner — is a **pure function** with a typed signature. Cairn ships a default implementation for each; users override by pointing `.cairn/config.yaml` at a different function exported from any registered plugin.

### 4.1 Plugin architecture

Cairn is plugin‑first end to end. "Plugin" means exactly one thing: a crate or package that **implements a Cairn contract trait** and registers itself through the shared loader. There is no distinction between "built‑in" and "third‑party" at runtime — Cairn's own `cairn-store-nexus`, `cairn-llm-openai`, and `cairn-sensors-local` crates use the same registration path a third‑party `cairn-store-qdrant` crate would.

**Registry rules:**

- **L0 core (`cairn-core`) has zero implementation dependencies.** It defines traits + types + pure functions, nothing that talks to a network, filesystem, LLM, or workflow engine. L0 compiles with zero runtime deps.
- **Every contract in §4 is a trait.** `MemoryStore`, `LLMProvider`, `WorkflowOrchestrator`, `SensorIngress`, `MCPServer`. Implementations live in separate crates / packages.
- **Every pure function in the pipeline is a trait + default impl.** `Extractor`, `Classifier`, `Ranker`, `HotMemoryAssembler`, etc. Override any one by naming a different function in `.cairn/config.yaml` under `pipeline.<stage>.function`.
- **Registration is explicit, not magic.** Plugins call `cairn_core::register_plugin!(<trait>, <impl>, <name>)` in their entry point. The host assembles the active set from config at startup. No classpath scanning, no auto‑discovery surprises.
- **Config selects the active implementation.** `.cairn/config.yaml` → `store.kind: nexus | qdrant | opensearch | custom:<name>`; `llm.provider: openai-compatible | ollama | bedrock | custom:<name>`; same pattern for every contract.
- **Contracts are versioned.** Each trait declares a `CONTRACT_VERSION`. Plugins declare the range they support. Startup fails closed if versions diverge — never a silent run with a mismatched contract.
- **Capability declaration.** Each plugin publishes a capability manifest (supports streaming? multi‑vault? async? transactions?). Cairn's pipeline queries capabilities before dispatching — features gracefully degrade (e.g., if the store doesn't support graph edges, `wiki/entities/` still works but backlinks fall back to text search).
- **Plugins can compose.** A `MemoryStore` plugin may wrap another — e.g., `cairn-store-caching` wraps any inner store with an LRU cache. Same pattern for middleware over any contract.

**What this buys:**

| Concern | Plugin point |
|---------|--------------|
| Storage | `MemoryStore` trait — swap Nexus for Qdrant, OpenSearch, Postgres, Neptune, or a bespoke internal store |
| LLM | `LLMProvider` — swap OpenAI‑compatible for Bedrock, Gemini, Ollama, or any endpoint |
| Orchestration | `WorkflowOrchestrator` — swap the `tokio` default for Temporal, DBOS, Inngest, Hatchet, or a custom runner |
| Sensors | `SensorIngress` — every sensor (hooks, IDE, Slack, email, GitHub, …) is its own crate; enable or disable per deployment |
| Pipeline stages | pure functions named in config — swap the default `Classifier` for a domain‑specific one (clinical, legal, trading, etc.) |
| Privacy | `Redactor` / `Fencer` — default is Presidio; drop in a bring‑your‑own PII detector |
| UI shell | Electron default, Tauri alternative, or bring your own over the MCP surface |
| Hot‑memory recipe | Ordered list of function names in `.cairn/config.yaml` → swap / extend without forking |
| Propagation policy | `PropagationPolicy` trait — default consent flow, enterprise deployments wire SSO + DLP |

**What stays non‑pluggable (the contract surface itself):** the MCP verb set (eight core verbs + the extension registration protocol), the vault layout invariants (§3.1), the append‑only `consent.log`, and the record frontmatter schema. Those are *the* contract — everything else is replaceable.

**How to verify this principle at any commit:**
```
cargo tree -p cairn-core                 # zero runtime deps expected
grep -rn "extern crate\|use " cairn-core # no imports from cairn-store-*, cairn-llm-*, etc.
cairn plugins list                       # shows all loaded plugins + versions + capabilities
cairn plugins verify                     # runs contract conformance tests against every active plugin
```

CI enforces all four: L0 has no impl deps; no module in core imports from any adapter; every bundled plugin passes contract conformance; capability declarations match runtime behavior.

### 4.2 Identity — agents, sensors, actor chains

Multi‑agent collaboration only works if every memory record can answer **who wrote this, who asked for it, on whose behalf**. Cairn treats identity as a first‑class contract, not a string tag.

**Three identity kinds, all stable + verifiable:**

| Kind | Format | How it's provisioned | What signs |
|------|--------|-----------------------|------------|
| `HumanIdentity` | `hmn:<slug>:<rev>` (e.g., `hmn:tafeng:v1`) | OS keychain keypair on first run; SSO/OIDC binding optional | user consent events, memory authored by user, `ConsentReceipt` |
| `AgentIdentity` | `agt:<harness>:<model>:<role>:<rev>` (e.g., `agt:claude-code:opus-4-7:reviewer:v3`) | Ed25519 keypair generated at agent registration; bound to harness + model + role manifest | every memory record the agent writes, every MCP call, every Dream/Reflection workflow run |
| `SensorIdentity` | `snr:<family>:<name>:<host>:<rev>` (e.g., `snr:local:screen:mac-tafeng:v2`) | keypair generated when sensor is first enabled; bound to machine + OS user | every `raw event` the sensor emits |

Every identity keypair lives in the platform keychain (Keychain on macOS, Secret Service on Linux, DPAPI on Windows) — never on disk in plaintext, never synced into the vault.

**Actor chain on every record.** `MemoryRecord` frontmatter carries a typed chain describing the full provenance:

```yaml
actor_chain:
  - { role: principal,  identity: hmn:tafeng:v1,               at: 2026-04-22T14:02:11Z }
  - { role: delegator,  identity: agt:claude-code:opus-4-7:main:v3, at: 2026-04-22T14:02:14Z }
  - { role: author,     identity: agt:claude-code:opus-4-7:reviewer:v1, at: 2026-04-22T14:02:17Z }
  - { role: sensor,     identity: snr:local:hook:cc-session:v1,  at: 2026-04-22T14:02:11Z }
signature: ed25519:...                 # signed by the *author* identity
attestation_chain: [sig1, sig2, sig3]  # countersignatures from each actor
```

**Why a chain and not a single `author` field:** multi‑agent systems delegate. A supervisor agent spawns a reviewer agent; the reviewer spawns a critic agent; the critic writes a memory. Every hop is material to trust and auditability. Cairn enforces the chain at write time — a record without a valid signed chain is rejected by the Filter stage (§5.2). Verification at read time lets `recall` surface records with broken chains for human review rather than silently hiding them.

**Per‑agent scope + policy:**

- **Scope tuple on every agent**: `(allowed_kinds, allowed_tiers, max_writes_per_hour, max_bytes_per_day, pii_permission, tool_allowlist)`. A reviewer agent may be allowed to write `feedback`/`opinion` but not `rule`/`playbook`; a scratchpad agent may be sandboxed to `private` tier only.
- **Trust score per identity** — derived from: (a) historical precision of writes that passed review, (b) fraction of `opinion`s upgraded to `fact` via independent corroboration, (c) fraction of records that survived `ExpirationWorkflow`. Feeds into the Ranker (§5.1) so high‑trust identities get weighted higher, and into the `Promotion` gate so untrusted agents can't lift a record into a shared tier.
- **Shared‑tier writes require an explicit principal.** An agent cannot promote its own writes to `team`/`org`/`public` — it must attach a `ConsentReceipt` signed by a `HumanIdentity` that has promotion capability for that tier. This is the fail‑closed rule behind the shared‑tier gate (§11.3).

**Sensor tags + labels:**

- Sensors don't just sign; they tag. Every emitted event carries `sensor_labels: {machine, os_user, app_focus, network, session_id, …}` so downstream stages can segment by origin — e.g., "only consolidate memory from `app_focus ∈ {Terminal, Code}` for this project" or "drop Slack messages from channel `#watercooler` before Extract."
- Tag taxonomy is declared in the sensor's plugin manifest; Cairn refuses to load a sensor that emits undeclared labels. Keeps the tag vocabulary auditable.

**Leveraging Nexus `catalog` + `workflows` bricks for per‑identity memory processing:**

| Nexus brick | Cairn use | How identity enters |
|-------------|-----------|-----------------------|
| `catalog` | stores the schema registry of memory‑process templates — one entry per pipeline variant (e.g., "clinical‑extract‑v3", "legal‑classifier‑v2", "default‑consolidator‑v1"). Every `MemoryRecord` links to the catalog entry that produced it (`produced_by: <catalog_id>@<version>`). | Each agent's manifest declares which catalog entries it is allowed to invoke; Cairn rejects a pipeline run that uses an entry outside the agent's scope |
| `workflows` | backs `WorkflowOrchestrator` when the user wires the Temporal / Nexus‑workflow adapter; per‑identity workflows are real first‑class Temporal workflows registered under `agent_id` as namespace | Each Dream / Reflection / Consolidation / Promotion / Evolution run is keyed by `(agent_id, scope, operation_id)` — Temporal's replay history gives per‑agent audit without extra logging |
| `discovery` | publishes active agent identities + their catalog entries so other agents in the same tenant can find them for delegation | The discovery record is itself signed by the agent's key; rogue discovery entries fail signature verification |
| `rebac` | resolves "can agent X read memory written by agent Y" at read time, without Cairn hand‑rolling ACL logic | `rebac` relation graph holds `(agent_id, tier, scope)` tuples updated whenever a new agent or `ConsentReceipt` is registered |

The payoff: "memory process" is not a hardcoded pipeline — it is a **catalog entry + an agent identity + a workflow run**. Operators can ship new pipelines (a new classifier, a new consolidator) as catalog entries without restarting Cairn, and every per‑record provenance trail ties back to the exact pipeline version that produced it. This is how Cairn supports multiple agents collaborating on one vault without devolving into "last writer wins."

**Signed payload schema — anti‑replay and key rotation:**

Every signature Cairn checks (actor chain, `ConsentReceipt`, WAL op, discovery record, share_link) uses this canonical envelope. Missing or expired fields → reject at the Filter stage (§5.2) before any side effect runs.

```json
{
  "operation_id": "01HQZ...",     // ULID, must not repeat for this issuer within `expires_at`
  "nonce": "base64:16B",          // fresh per message; server keeps a rolling 24h bloom + ledger
  "sequence": 41828,              // monotonic per-issuer counter; strictly increasing, signed
  "target_hash": "sha256:...",    // bound to the record/plan/receipt this signature authorizes
  "scope": { "tenant": "...", "workspace": "...", "entity": "...", "tier": "private|..." },
  "issuer": "agt:claude-code:opus-4-7:reviewer:v1",
  "issued_at": "2026-04-22T14:02:11Z",
  "expires_at": "2026-04-22T14:07:11Z",   // default 5 min; promotion receipts default 24 h
  "key_version": 3,               // matches the current rev of the issuer's keypair
  "server_challenge": "base64:...",     // optional nonce from a prior cairn handshake; required when sequence is absent or when issuer uses challenge-mode
  "chain_parents": ["op:01HQ...","op:01HR..."],   // operations this one depends on
  "signature": "ed25519:..."      // over the canonical JSON of ALL fields above (including sequence + server_challenge)
}
```

`sequence` and `server_challenge` are **inside the signed payload** — an attacker cannot rewrite them without invalidating the signature. Callers without a reliable local counter (e.g., stateless retries) must use `server_challenge` mode: call `cairn handshake` to get a fresh server‑minted nonce, bake it into the signed envelope, and the server consumes it atomically with the rest of the replay check.

**Atomic replay + ordering check.** All replay and ordering state lives in **one SQLite file** — `.cairn/cairn.db` (see §3 "Durability topology") — under the `used`, `issuer_seq`, and `outstanding_challenges` tables. SQLite does **not** support `SELECT ... FOR UPDATE`; the algorithm below uses only executable SQLite 3.35+ semantics (`INSERT ... ON CONFLICT`, `UPDATE ... WHERE ... RETURNING`) and avoids global write serialization.

```
# Hot-path order — signature verify BEFORE any disk write
1. Ed25519 signature verify                            (in‑memory, ~0.05 ms)
2. Timestamp bounds check against server monotonic clock
3. Key version + revocation check (cached)
4. Bloom filter probe on (operation_id, nonce)         (rejection fast path)

# Disk path — two short SQLite transactions (WAL mode enables many readers + 1 writer without blocking)
5. BEGIN;
     INSERT INTO used (operation_id, nonce, issuer, sequence, committed_at)
       VALUES (:op, :nonce, :issuer, :seq, :now)
       ON CONFLICT (operation_id, nonce) DO NOTHING
       RETURNING rowid;
     -- If RETURNING is empty, this is a replay → ROLLBACK; reject.
     -- Otherwise continue.
     UPDATE issuer_seq
        SET high_water = :seq
      WHERE issuer = :issuer
        AND high_water < :seq
        RETURNING high_water;
     -- If RETURNING is empty, the sequence was not strictly greater than
     -- the current high_water → ROLLBACK; reject as out-of-order replay.
   COMMIT;
```

The two statements run inside one short `BEGIN` transaction — no `FOR UPDATE`, no `BEGIN IMMEDIATE` against the main vault DB. Concurrent submissions from the **same issuer** are serialized by the `issuer_seq` row lock (SQLite acquires a reserved write lock at UPDATE time); concurrent submissions from **different issuers** do not contend, because the `UPDATE … WHERE high_water < :seq` is the only write and SQLite's WAL journaling allows multiple readers and one writer without blocking each other. The guarded `WHERE high_water < :seq` is the compare‑and‑swap — if another concurrent request already advanced the high‑water mark, RETURNING is empty and we roll back cleanly. No race, no `FOR UPDATE`, no global single‑writer.

**Throughput budget.** Replay checks measured on SQLite 3.45 + NVMe at 10 k QPS single issuer (p99 < 3 ms disk commit) and 30 k QPS aggregated across 50 issuers. Bloom filter absorbs > 99 % of replays without entering the transaction. The same bounds hold on HDD but with p99 ~ 20 ms; deployments with > 10 k QPS single‑issuer workloads switch to the `cairn.admin.v1` extension's sharded replay DB (one file per tenant).

**Signature‑first rejection.** Signature verification runs **before** any disk write to `.cairn/cairn.db`. An attacker replaying a valid signature hits step 5's unique constraint; an attacker sending junk never reaches step 5 because signature check rejects first. This prevents ledger pollution by unauthenticated traffic.

**Replay consumption is coupled to WAL `PREPARE`, not independent.** The replay ledger (`used`, `issuer_seq`, `outstanding_challenges`) and the WAL op log (`wal_ops`, `consent_journal`) all live in the same SQLite file — `.cairn/cairn.db` — owned directly by the Rust core (see "Durability topology" in §3). Nexus has its own `nexus.db` for memory state; the two files are coordinated via idempotency keys (§5.6), not via a distributed transaction. The transaction below is a single local SQLite commit that atomically couples replay consumption with the WAL `PREPARE` row:

```
BEGIN;
  INSERT OR ROLLBACK INTO used (…) RETURNING rowid;            -- replay consume
  UPDATE OR ROLLBACK issuer_seq SET high_water = :seq …;       -- sequence CAS
  INSERT INTO wal_ops (operation_id, state, plan_ref, …)       -- WAL PREPARE
    VALUES (:op, 'PREPARED', :plan, …)
    ON CONFLICT (operation_id) DO NOTHING;
COMMIT;
```

Either all three rows land or none. There is no window where replay is consumed but no operation is prepared. A retry with the same `operation_id` after an earlier crash finds the `wal_ops` row already in `PREPARED` or a terminal state and resumes from the per‑op step marker (§5.6 recovery) — the replay row's unique constraint is a no‑op because the first retry's row is already durable.

**First‑seen issuer bootstrap + challenge mode.** `issuer_seq` rows are created atomically via UPSERT rather than requiring prior registration; `server_challenge` mode has its own explicit transaction:

```
-- Bootstrap / CAS path (used when envelope carries `sequence`)
INSERT INTO issuer_seq (issuer, high_water)
  VALUES (:issuer, :seq)
  ON CONFLICT (issuer) DO UPDATE SET high_water = :seq
    WHERE issuer_seq.high_water < :seq
  RETURNING high_water;
-- Empty RETURNING ⇒ sequence was not strictly greater ⇒ reject.

-- Challenge mode (used when `sequence` is absent; envelope carries `server_challenge`)
BEGIN;
  DELETE FROM outstanding_challenges
    WHERE issuer = :issuer AND challenge = :server_challenge
    RETURNING rowid;                        -- must return a row; empty ⇒ reject
  -- replay consume + WAL PREPARE exactly as above, with high_water CAS skipped
COMMIT;
```

Challenge‑mode clients call `cairn handshake` first to receive a fresh `server_challenge` stored in `outstanding_challenges`; each challenge is single‑use with a 60 s TTL. If v0.1 chooses not to ship challenge mode, the `server_challenge` field simply fails validation and only sequence mode is supported — the capability is advertised in `handshake.capabilities`.

**Server‑side freshness.** Signer‑supplied timestamps are treated as untrusted hints — the server enforces the real freshness window:

- `issued_at` must be within `±2 min` of the server's monotonic clock. Outside that window → `ExpiredIntent`. Bounds backdating against a stolen key.
- `expires_at` must be `≤ issued_at + max_ttl` (default 5 min, 24 h for promotion receipts) — clients can't extend their own TTLs.
- `sequence` must be **strictly greater** than the stored high‑water mark for the issuer (checked inside the same transaction as the ledger write, above). Sequence gaps are tolerated; reversals are not. Stateless clients use `server_challenge` mode instead.
- Post‑revocation: even a technically valid signature from a revoked key is rejected before any ledger write, bounded by the `effective_at` revocation timestamp.

**Key rotation + revocation.**

- Each identity owns a **key ring** (current + up to two predecessors); frontmatter references `key_version` so records signed by an older version still verify until TTL expires.
- Rotating = minting a new key, signing it with the current key, publishing to the Nexus `discovery` brick, incrementing `key_version`.
- Revoking = publishing a signed revocation to `discovery` with `effective_at`; every later operation whose `issued_at > effective_at` fails closed. Earlier operations remain valid unless their `operation_id` appears on a **per‑key revocation list** (for stolen‑key incidents — the operator can blanket‑revoke every op in a time window).
- Revocation publication is itself countersigned by a `HumanIdentity` with the `IdentityAdmin` capability, so a compromised agent key can't revoke its way out of audit.

**TOFU is disallowed for shared‑tier writes.** Trust‑on‑first‑use holds only inside the `private` tier. Every `session | project | team | org | public` promotion (§11.3) requires:

1. An `IdentityProvider` plugin resolution for the principal (enterprise OIDC, hardware key, or explicit `cairn identity approve`).
2. A fresh `ConsentReceipt` with valid `nonce`, `operation_id`, `expires_at`, `chain_parents`, matching `target_hash`.
3. A `key_version` that is current (no revoked keys).

The shared‑tier gate (§11.3) re‑verifies the receipt at apply time — a receipt good at plan time but expired by apply time fails closed, even if the FlushPlan was already signed off.

**Chain verification at read time.** `search` / `retrieve` walk the `actor_chain` and validate each hop's signature + key_version + revocation status. Records with a broken chain are flagged `trust: "unverified"` in the response and filtered out of shared‑tier reads by default (a caller can opt in with `allow_unverified: true` for forensic work only).

**What identity does *not* do:**

- It is not authentication for the MCP surface (that's harness‑level — CC's settings, Codex's config, etc.). It is the *attribution* layer underneath.
- It is not a global namespace — identities are per‑Cairn‑deployment. Cross‑deployment federation uses the `share_link` / signed `ConsentReceipt` flow (§12.a, §14), not a shared identity service.
- It does not require a public CA, but it **does** require an `IdentityProvider` for any shared‑tier write — the default local provider serves `private` only. Enterprise deployments wire SSO/OIDC/hardware key attestation through the same plugin point.

---

## 5. Pipeline — Read, Write, Consolidate

Cairn's pipeline has three explicit paths: the **read path** that serves a turn, the **write path** that captures what the agent learned, and the **consolidation path** that runs off‑request.

### 5.0 End‑to‑end agent turn journey

One message, one turn — trace every stage:

```
╔═══════════════════════╗                                    ╔═══════════════════════╗
║   USER (human)        ║ ── message ──►                ◄── ║   AGENT response      ║
╚═══════════════════════╝                                    ╚═══════════════════════╝
                                                                       ▲
                                                                       │
      ┌────────────────────────────────────────────────────────────────┼────────────────────┐
      │ HARNESS (Claude Code / Codex / Gemini / custom)                │                    │
      │                                                                │                    │
      │  [1] SessionStart hook ──► cairn assemble_hot                  │                    │
      │                                     │                          │                    │
      │                                     ▼                          │                    │
      │                         ┌───────────────────────┐              │                    │
      │                         │ HOT PREFIX  (< 25 KB) │              │                    │
      │                         │ ─────────────────────  │              │                    │
      │                         │ purpose.md             │              │                    │
      │                         │ AutoUserProfile        │              │                    │
      │                         │ top‑K recent memories  │              │                    │
      │                         │ project state          │              │                    │
      │                         └──────────┬────────────┘              │                    │
      │                                    │                           │                    │
      │  [2] UserPromptSubmit ──► classify intent, add routing hints   │                    │
      │                                    │                           │                    │
      │                                    ▼                           │                    │
      │                           [optional: on‑demand                 │                    │
      │                            cairn search / retrieve             │                    │
      │                            via MCP, bounded to                 │                    │
      │                            N tokens budget]                    │                    │
      │                                    │                           │                    │
      │                                    ▼                           │                    │
      │                          [LLM generates; calls tools           │                    │
      │                           as needed — each tool call           │                    │
      │                           fires PostToolUse hook]              │                    │
      │                                    │                           │                    │
      │  [3] PostToolUse ──► write child trace record                  │                    │
      │                                    │                           │                    │
      │                                    ▼                           │                    │
      │                          [response streamed back]──────────────┘                    │
      │                                                                                     │
      │  [4] Stop hook ──► cairn capture_trace  (full turn)                                 │
      │                                                                                     │
      └──────────────────────────────────┬──────────────────────────────────────────────────┘
                                         │
                                         ▼
                            ┌────────────────────────┐
                            │   WRITE PATH (§5.2)    │
                            │  Extract → Filter →    │
                            │  Classify → Scope →    │
                            │  Match → Rank →        │
                            │  FlushPlan → Apply     │
                            │  (WAL 2‑phase §5.6)    │
                            └───────────┬────────────┘
                                        │
                                        ▼
                            ┌────────────────────────┐        ┌────────────────────┐
                            │   VAULT ON DISK        │──────► │ frontend adapters  │
                            │   raw/trace_*.md       │        │ project new turn   │
                            │   raw/turn_*.md        │        │ to Obsidian/VSCode │
                            │   (optionally wiki/    │        │ sidecar / plugin   │
                            │    via promotion)      │        └────────────────────┘
                            └───────────┬────────────┘
                                        │  (async, off request path)
                                        ▼
                            ┌────────────────────────┐
                            │  LightSleep scheduled  │───► REMSleep ───► DeepDream
                            │  (every Stop / N turns)│     (nightly)    (weekly)
                            │  orphan check, recap   │
                            └────────────────────────┘
```

**Total harness latency added:** hot‑prefix assembly on `SessionStart` (p50 < 20 ms warm) + optional on‑demand `search` on `UserPromptSubmit` (p50 < 10 ms). The write path, WAL flush, and workflow scheduling all run **off** the response path — the user never waits on them.

**Where each user story (§18.c) shows up:** US1 turn sequence = raw/turn_*.md boxes; US3 user memory = AutoUserProfile in hot prefix; US5 tool calls = PostToolUse arrow; US4 rolling summary = LightSleep / REMSleep loop.

### 5.1 Read path — agent queries memory during a task

```
User ──task──► Agent (LLM + Tools) ──query──► [Scope Resolve] ──scoped query──► [Memory Store]
                                              (user / project / org / team)     (Episodic · Semantic · Procedural · KG)
                                                                                        │ candidates
                                                                                        ▼
                                                                                 [Rank & Filter]
                                                                                 relevance · recency · staleness
                                                                                        │
                                                                                        ▼
                                                              Agent context  ◄──results──
```

| Stage | What it does | Pure function |
|-------|--------------|---------------|
| **Scope Resolve** | map request `{userId, agentId, project, team, org}` → keyspace + visibility filter | `resolveScope` |
| **Memory Store query** | typed lookup across the four classes (episodic / semantic / procedural / graph) — BM25 + ANN + graph hybrid | `MemoryStore.query` (contract) |
| **Rank & Filter** | score candidates on relevance × recency × staleness × confidence × salience; drop below threshold; return top N within token budget | `rankAndFilter` |

The read path is invoked internally by the `search`, `retrieve`, `summarize`, and `assemble_hot` MCP verbs. The harness never reaches the store directly — it always goes through Scope Resolve and Rank & Filter.

**Skill LRU cache.** Frequently‑hit `playbook` and `skills/*.md` memories live in an in‑process LRU keyed by `(agentId, skillId)`. Cache invalidates on `PromotionWorkflow` or `EvolutionWorkflow` updating the artifact. Keeps procedural recall under ~5 ms on a warm cache.

### 5.2 Write path — agent stores what it learned

```
Agent ──interactions──► [Capture] ──raw events──► [Extract] ──extracted──► [Filter: Memorize?]
                        events, tool                experiences, facts,             │
                        calls, outcomes             preferences, skills             │
                                                                          ┌─────────┴─────────┐
                                                                      yes │                   │ no
                                                                          ▼                   ▼
                                                                 [Classify & Scope]       [Discard]
                                                                  kind · class ·          volatile /
                                                                  visibility · scope      tool lookup /
                                                                          │               competing source
                                                                          ▼
                                                                    [Memory Store]
                                                                    episodic / semantic / procedural
```

| Stage | What it does | Pure function |
|-------|--------------|---------------|
| **Capture** | gather events, tool calls, outcomes, sensor frames, user signals | `capture` |
| **Tool‑squash** | compact verbose tool outputs before they become memories: dedup repeated lines, truncate with `[…skipped N lines…]`, strip ANSI, extract structured fields when the tool declares a schema | `squash` |
| **Extract** | LLM‑backed distillation of experiences, facts, preferences, skills — OR zero‑LLM regex fallback | `extract` |
| **Filter (Memorize?)** | decide `yes` (proceed) or `no` (discard). Discard reasons are first‑class and logged: `volatile`, `tool_lookup`, `competing_source`, `low_salience`, `pii_blocked`, `policy_blocked`, `duplicate`. Also handles PII redaction (Presidio) and prompt‑injection fencing before the yes branch | `shouldMemorize` + `redact` + `fence` |
| **Classify & Scope** | kind (19) × class (4) × visibility (6) × scope → keyspace; emits `ADD / UPDATE / DELETE / NOOP` decision. Kind cardinality is generated from the single IDL (§13.5) — a CI check fails on drift across sections, examples, and validators | `classifyAndScope` |
| **Memory Store upsert** | persist with provenance; write index + cache entries | `MemoryStore.upsert` (contract) |

Capture → Memory Store is **always on‑path** and bounded — p95 < 50 ms including hot‑memory re‑assembly on high‑salience writes.

### 5.3 Consolidation path — off‑request, durable

```
[Memory Store] ──► [Consolidate] ──► [Promote] ──► [Expire] ──► [Memory Store]
                   merge, compress    episodic →    retire
                                      skills        outdated
```

| Stage | What it does | Workflow |
|-------|--------------|----------|
| **Consolidate** | merge duplicates, compress similar memories, resolve conflicts, update confidence, update graph edges | `ConsolidationWorkflow` (per‑entity on write) + `DreamWorkflow` (nightly sweep) |
| **Promote** | `episodic → procedural` when confidence > 0.9 and evidence count ≥ N; emit distilled skill to `skills/` | `PromotionWorkflow` |
| **Expire** | tiered decay + multi‑factor salience + TTL; retire outdated; never hard‑delete without policy consent | `ExpirationWorkflow` |

Consolidation also fans into `ReflectionWorkflow`, `PropagationWorkflow`, and `EvaluationWorkflow` — §10 enumerates all seven.

### 5.4 Key properties

- Read path and write path share **no mutable state**; the agent can query while writes are in flight.
- Capture → Store is always on‑path and bounded; everything from Consolidate onward is off‑path.
- Every stage is a pure function that takes `MemoryRecord[]` (or a `Query`) and returns `MemoryRecord[]` (+ side effects through one of the five contracts).
- Any stage can fail without losing data; the `WorkflowOrchestrator` (default tokio + SQLite; Temporal optional in v0.2+) replays from the last persisted step.
- Discard is **never silent** — every `no` from Filter writes a row to `.cairn/metrics.jsonl` with the reason code.

### 5.5 Plan, then apply

Every write path run produces a **FlushPlan** before any bytes hit the `MemoryStore`. A FlushPlan is a typed, serializable object listing the concrete upserts / deletes / promotions / expirations it would apply and why. The `apply` step is a pure function from `FlushPlan → side effects`.

| Mode | Behavior |
|------|----------|
| `autonomous` (default) | Capture → … → Plan → apply inline, same turn |
| `dry_run` | Plan returned via MCP `ingest(dry_run: true)`; no writes |
| `human_review` | Plan written to `.cairn/flush/<ts>.plan.json` + human diff; apply waits for `cairn flush apply <id>` |

Benefits: plans are idempotent (re‑apply = no‑op), reviewable, replayable for eval, and the primary audit artifact for *every* memory mutation. Same pattern as OpenClaw's flush‑plan.

### 5.6 Write‑Ahead Operations + Crash‑Safe Apply

Every mutation — single upsert, promotion, session delete fan‑out, skill evolution rollout — runs through a two‑phase WAL protocol. Durability (US2), atomic delete (US8), and concurrent‑writer safety (§10.1) all rest on this section.

**WAL record schema — rows in the `wal_ops` table (single source of truth, inside `.cairn/cairn.db`):**

There are no per‑op log files. Earlier drafts referenced `.cairn/wal/<op>.log` — that has been removed. Every op is a row in `wal_ops` with a JSONB payload; per‑step completion markers are rows in a child `wal_steps` table, both inside the same SQLite database so every state transition is a single local transaction. A crash leaves the DB consistent (SQLite journaling handles torn writes); boot recovery reads only from `wal_ops` + `wal_steps` — no file scan, no divergence possible.

The JSON payload stored in `wal_ops.envelope`:

```json
{
  "operation_id": "01HQZ...",            // ULID, monotonic, client‑provided idempotency key
  "kind": "upsert | delete | promote | expire | forget_session | forget_record | evolve",
  "issued_at": "2026-04-22T14:02:11.417Z",
  "issuer": "agt:claude-code:opus-4-7:reviewer:v1",
  "principal": "hmn:tafeng:v1",          // present when required by policy tier (§6.3)
  "target_hash": "sha256:abc...",        // deterministic hash of (target_id, plan_body)
  "scope": { "tenant": "t1", "workspace": "default", "entity": "record:xyz" },
  "plan_ref": ".cairn/flush/<ts>.plan.json",   // full FlushPlan already serialized
  "dependencies": ["01HQ..."],           // WAL ops this one must apply after
  "expires_at": "2026-04-22T14:07:11Z",  // 5‑min receipt TTL; replays past this are rejected
  "signature": "ed25519:...",            // issuer‑signed over all fields above
  "countersignatures": [ { "role": "principal", "sig": "ed25519:..." } ]
}
```

**Lifecycle — one WAL op as a finite‑state machine:**

```
ISSUED ──acquire locks──► PREPARED ──fan-out: nexus store/index + consent_journal──► COMMITTED
   │                          │                                                     │
   │  validation fail         │  any side‑effect fails                               │
   │  / lock conflict         │                                                      │
   ▼                          ▼                                                      ▼
REJECTED (never applied)   ABORTED (WAL entry marked, side‑effects compensated)   DURABLE
```

| Transition | Requires | What happens |
|------------|----------|--------------|
| `ISSUED → PREPARED` | signature valid, idempotency key unused, principal/issuer policy ok, locks acquired (see below) | writes `PREPARE <op>` marker at end of WAL; locks held under `(scope, entity_id)` |
| `PREPARED → COMMITTED` | all fan‑out side effects succeeded (Nexus store upsert, vector upsert, FTS upsert, edge upsert, and the `consent_journal` row atomically committed in the same SQLite transaction as the state change that triggers it). `.cairn/consent.log` file is updated by the async `consent_log_materializer` — never on the request path. | writes `COMMIT <op>` marker; releases locks |
| `PREPARED → ABORTED` | any side effect failed OR supervisor crashed | compensating ops run (delete partial rows, remove vectors); writes `ABORT <op>` marker; releases locks |
| `ISSUED → REJECTED` | signature invalid / idempotency key reused / policy deny | writes `REJECT <op>` + reason; no locks ever taken |

**Idempotency.** `operation_id` is the idempotency key — second `PREPARE` with the same id returns the first commit's outcome without re‑doing side effects. Third‑party writers collide safely on retries; broken networks can't double‑apply.

**Lock granularity and compatibility matrix — implemented as a lock table, not advisory.** SQLite does not provide cross‑process row‑level advisory locks, so Cairn implements lock acquisition as ordinary inserts/updates in a `locks` table inside `.cairn/cairn.db`, protected by the SQLite write serialization. Every lock is a row; every lock has a **fencing token** (`lock_id` = ULID) and a **lease TTL** (default 30 s, heartbeat every 10 s). The lock table:

```sql
CREATE TABLE locks (
  scope_kind   TEXT NOT NULL,      -- 'entity' | 'session'
  scope_key    TEXT NOT NULL,      -- "(tenant, workspace, entity)" or "(tenant, workspace, session)"
  mode         TEXT NOT NULL,      -- 'shared' | 'exclusive'
  holder_count INTEGER NOT NULL,   -- number of shared holders (exclusive ⇒ 1)
  lock_id      TEXT NOT NULL,      -- fencing token, renewed every heartbeat
  leased_until INTEGER NOT NULL,   -- epoch ms
  waiters      BLOB,               -- small queue of pending acquirers
  PRIMARY KEY (scope_kind, scope_key)
);
```

Cairn defines two lock scopes: entity locks `(tenant, workspace, entity_id)` and session locks `(tenant, workspace, session:<id>)`. Every write acquires an entity lock in exclusive mode; a write that carries a `session_id` in its scope **also** acquires the session lock in **shared** mode. `forget_session` acquires the session lock in **exclusive** mode for the full Phase A (§5.6 delete row).

**Acquisition protocol (one SQLite transaction per lock):**

```
BEGIN;
  SELECT mode, holder_count, leased_until FROM locks
    WHERE scope_kind = ? AND scope_key = ?;
  -- If missing: INSERT with this acquirer as sole holder.
  -- If held in compatible mode + lease valid: UPDATE holder_count += 1, refresh lease.
  -- If held in compatible mode + lease expired: reclaim (see crash recovery below).
  -- If held in incompatible mode: return WAIT; caller enqueues in waiters and retries
  --   with exponential backoff; no busy-loop.
COMMIT;
```

**Lease + fencing semantics — enforced on the Rust side before Nexus is called, and re‑asserted on every chunk transaction.** Every held lock carries a `lock_id` generated at acquisition. The Rust core checks `lock_id` freshness in the same local SQLite transaction that promotes the WAL op from `PREPARED` to about‑to‑apply; if the lease has expired or the `lock_id` differs from the current holder, the op is aborted locally and Nexus is never called.

**Per‑chunk fencing for multi‑step and chunked operations.** For any op with more than one transaction (notably `forget_session` Phase A's `forget_chunk`‑sized writes, and any promote/expire with drain steps), each chunk's SQLite transaction opens with a CAS assertion against the lock table:

```sql
BEGIN;
  -- Lock validity CAS: must match AND lease must be live
  SELECT lock_id, leased_until FROM locks
    WHERE scope_kind = ? AND scope_key = ?;
  -- Abort the transaction if lock_id ≠ :my_lock_id OR leased_until < :now
  -- (application-level check; sqlite errors out via RAISE if mismatched)
  -- ... chunk's mutation statements ...
COMMIT;
```

A stale worker whose lease expired cannot commit a chunk transaction — the CAS fails, the transaction rolls back, the worker self‑aborts. Heartbeats renew the lease every 10 s; a chunk takes at most `max_chunk_duration` (default 500 ms) so the lease margin is always ≥ 20×. If a worker detects a heartbeat failure (network partition, process stall), it stops issuing further chunks; the next acquirer sees the expired lease and reclaims. No two holders can produce durable mutations — the CAS gate is the single choke point.

**Single lock‑authority clock — epoch counter, not wall clock.** `leased_until` is not wall‑clock ms — it is a **lease epoch counter** stored in the `locks` table (SQLite row‑level). Every heartbeat increments the issuer's per‑process `epoch` column; the CAS compares `:expected_epoch == locks.epoch`, not timestamps. The lock authority is the `locks` table in `.cairn/cairn.db` — the only clock that matters is the serial order of SQLite commits on that table. NTP jumps, DST changes, container clock drift, and suspend/resume events cannot trigger false reclaims or liveness stalls because the protocol does not read wall clocks. For operator‑facing dashboards a wall‑clock `last_heartbeat_at` is logged alongside the epoch — but never read by the fencing path.

`max_chunk_duration` is enforced by the worker counting SQLite commits on its own lock row, not by wall‑clock. A concurrency test asserts the invariant "no chunk commits after a newer epoch has been published" across synthetic clock‑skew + NTP‑step schedules; this test is part of the §15 gate.

This is the Martin Kleppmann / Chubby fencing pattern applied to the single lock authority (Rust‑owned `.cairn/cairn.db`) at chunk granularity, not just at the PREPARED→apply boundary.

**Crash recovery.** A lock with `leased_until < now` is a "zombie" — a prior holder crashed without releasing. The next acquirer can reclaim by deleting the row (or decrementing `holder_count` in shared mode) and taking the lock with a new `lock_id`. Zombie reclaim rejects any in‑flight writes from the old holder by the fencing check above.

**Why `forget_session` exclusive blocks child writes.** A write to a session child opens two SQLite transactions: one to acquire the entity lock and one to acquire the session lock in shared mode. If `forget_session` holds the session lock exclusive, the shared acquisition returns WAIT, and the child write blocks (with a configurable timeout — default 5 s, after which it fails with `SessionLockUnavailable`). The planner refuses to retry with a stale session lock — once `forget_session` commits, the session is gone and retries fail fast.

**Serialization bound.** Because every lock op is a short transaction on `.cairn/cairn.db`, the bottleneck is that one SQLite file's write throughput. Measured: 10 k lock ops/s on NVMe, 1 k/s on HDD. For sandbox scale (< 100 concurrent agents) this is not limiting. Hub deployments (v0.3+) shard the lock table per tenant, producing O(tenant) parallelism.

### Lock compatibility

| Op (wants)                 | Entity lock       | Session lock        |
|----------------------------|-------------------|----------------------|
| `upsert` / `ingest` / `capture_trace` (has session_id) | exclusive on entity | **shared** on session |
| `upsert` / `ingest` (no session) | exclusive on entity | — |
| `forget_record`            | exclusive on entity | shared on session (if record carries one) |
| `forget_session`           | exclusive on every matching entity | **exclusive** on session |
| `promote` / `expire`       | exclusive on entity | shared on session (if applicable) |
| `search` / `retrieve`      | none              | none (readers use version + reader_fence filters) |

Rules:
- Shared × shared on the same session lock is compatible (many concurrent writes to the same session).
- Shared × exclusive on the same session lock is NOT compatible — while `forget_session` holds exclusive, every incoming write that names that session blocks until Phase A commits. This is what closes the "child inserted after snapshot but before fence close" race: a fresh insert can't acquire the shared session lock, so no child lands between the snapshot and the fence close.
- Exclusive × exclusive on the same session lock is serialized by acquisition order; two concurrent forgets on the same session yield one winner and one retry.

**Deadlock‑free acquisition (single ordering function).** There is exactly one ordering function used by every op — child writes, promotes, expires, `forget_record`, and `forget_session` all acquire locks via `acquire_locks_in_order(op)`:

1. Collect the lock set: session lock (if `session_id` in scope) + all entity locks the op will touch.
2. Sort by lexicographic `(scope_kind_rank, scope_key)` where `scope_kind_rank` is `0` for session, `1` for entity. Session locks are always acquired before entity locks; entity locks are acquired in sorted key order.
3. For each lock in order: acquire with mode determined by the op's lock table row (see compatibility matrix above). Block / wait / timeout per op's policy.
4. If any lock returns WAIT, release all previously‑acquired locks and enter the waiter queue with the full lock set as a batch; re‑attempt atomically when the conflicting holder releases — no partial‑hold deadlock window.

Because every op uses the same ordering function and always releases on WAIT before re‑acquiring, there is no AB‑BA cycle possible. Cross‑session mutations are refused by the planner (keeps session locks independent — a write that targets two sessions must split into two ops, each acquiring its own session lock independently).

A dedicated CI concurrency test runs 1000 random schedules of concurrent child writes + `forget_session` + `promote` on the same session; the invariants "no deadlock," "no child write visible after `forget_session` commit," and "every op either commits or cleanly aborts" must hold for every schedule. The test lives in §15 Evaluation and gates every release.

**Concurrency invariant test (CI).** A dedicated test runs many random writers against a session while `forget_session` runs concurrently; the invariant "no record with `session_id = X` is reader‑visible after `forget_session(X)` commits" must hold across all schedules — enforced as a permanent regression test in the eval harness (§15).

**Fan‑out order per operation kind (operation‑specific step graphs).** Each `kind` has its own deterministic step list and its own compensation rules — never "delete steps to roll back a delete." Steps marked `[idem]` are idempotent re‑runs of the same arguments; `[tombstone]` marks inserts a redoable mark that recovery reads; `[snapshot]` copies state into the WAL entry before mutation so rollback restores it exactly.

| Op | Forward steps (in order) | Per‑step compensation |
|----|---------------------------|------------------------|
| `upsert` | 1. `snapshot.stage` [snapshot] — if the target already exists, capture its pre‑image (primary row + all index entries) into the WAL entry; for a pure insert, stage a sentinel "absent" marker → 2. `primary.upsert_cow` [idem] — copy‑on‑write; new version lives at `(target_id, version=N+1)` with `active: false`; the old `active: true` row at version N is untouched → 3. `vector.upsert(version=N+1)` [idem] → 4. `fts.upsert(version=N+1)` [idem] → 5. `edges.upsert(version=N+1)` [idem] → 6. `primary.activate` — single SQLite transaction: `UPDATE rows SET active = (version = N+1) WHERE target_id = :id; INSERT INTO consent_journal (…) VALUES (…);` The row‑pointer swap and the consent journal row commit atomically in the same DB transaction. This is the linearization point for readers. → 7. `consent_log_materializer` — background writer tails the `consent_journal` table and appends each row to `.cairn/consent.log` using crash‑safe `fsync(file)` + monotonic rowid as the last‑appended cursor; the file is a faithful **async materialization** of the DB journal, not the source of truth. If the daemon dies mid‑append, the next start replays from the last‑appended cursor — no duplicates, no gaps. | on abort **before step 6**: drop the `(version=N+1, active=false)` row + its indexes; old version `N` (active=true) is never touched; compensation is a pure delete of staged rows. On abort **at step 6**: the SQLite transaction itself rolls back; no partial state. After step 6: the consent row is durable in the DB; if step 7 lags or crashes, the file is caught up at next materializer tick — recovery invariant is "DB journal rows are the truth; `.cairn/consent.log` is eventually consistent with the journal." |
| `delete` / `forget_record` / `forget_session` | **Phase A — fast logical tombstone commit (sets the reader‑visible outcome, chunked to keep SQLite write windows short):** 1. `snapshot.stage` [snapshot] — serialize full record + all index entries per child into the WAL entry (streamed; for a session with N children, the stage is itself chunked at `forget_chunk = 1024` records per SQLite write so total transaction size is bounded) → 2. `session.fence.open` — insert a row into the `reader_fence` table with `(session_id, op_id, state='tombstoning')`; every subsequent read plan joins on this table and filters out any row whose `session_id` has an open fence, whether or not its own tombstone mark has landed yet → 3. `primary.mark_tombstone` — in `forget_chunk`‑sized transactions, mark each child record tombstoned; on the last chunk only, close the fence inside the same transaction by flipping `reader_fence` to `state='closed'` and appending to `consent_journal`. From this transaction onward, readers neither see the session's children directly nor fall through the fence. **Phase B — asynchronous physical purge GC (separate idempotent WAL child op per record):** 4. `vector.drain` → 5. `fts.drain` → 6. `edges.drain` → 7. `primary.purge` — each runs as its own child op; all retriable; none can re‑introduce content because the reader fence is already closed at Phase A end. | on abort **before the fence‑close chunk of step 3**: drop all tombstones written in earlier chunks, delete the `reader_fence` row; readers revert to seeing the session. On abort **after the fence‑close chunk**: Phase A is durable; Phase B children are retried idempotently. If a Phase B child exhausts retries, that record is flagged `PURGE_PENDING` in `lint` with operator escalation — readers still don't see it because the fence is closed. Bound Phase A duration by `forget_chunk` (default 1024) × per‑row write cost; backpressure signal exposed to callers as `estimated_phase_a_ms`. |
| `promote` | 1. `snapshot.stage` → 2. `policy.verify_receipt` → 3. `primary.update_tier` → 4. `rebac.add_relation` → 5. `consent_journal.append(promote)` — commits atomically with steps 3 + 4 in one SQLite transaction; the async materializer tails the journal into `.cairn/consent.log` | on abort before step 3: no‑op. After step 3: reverse tier update using `[snapshot]`; revoke rebac relation added in step 4. The consent journal row commits with the state change — any abort marker is a subsequent journal row. |
| `expire` | 1. `snapshot.stage` → 2. `primary.mark_expired` → 3. `vector.drain` → 4. `fts.drain` → 5. `edges.drain` → 6. `consent_journal.append(expire)` — atomic with step 2 in one SQLite transaction | identical rollback rules as `delete` Phase A, but step 2 is `mark_expired` not `mark_tombstone` — expiration can be reversed by future writes (un‑expire via `upsert` of a later version) until a subsequent `forget` runs. |
| `evolve` | per‑candidate steps from §11.3 canary rollout; each candidate is its own child op with its own WAL entry and its own compensation | parent op records `child_op_ids`; parent COMMIT requires all children COMMITTED; any child ABORT triggers parent ABORT which compensates all earlier children via their own rollback steps |

**Drain completion criteria (deletes / expirations only):** a step is "drained" when the corresponding index emits a checkpoint whose sequence number is past the tombstone sequence number. Until drained, `search` / `retrieve` run an auxiliary tombstone filter so stale results never surface. The drain fence is what makes delete atomicity observable — the moment the Phase A transaction commits, every reader query is guaranteed to miss the record.

**Read fence for upsert (prevents phantom hits from staged version N+1 before activation).** `search` / `retrieve` plans join against the primary row's `active` column (the `primary.activate` step in §5.6 flips `active: true` on the new version and `active: false` on the old one inside the same SQLite transaction as the consent journal row). Vector / FTS / edge indexes are written under `version=N+1` during steps 3–5 but **carry the version number**; the read plan filters on `active == true` at the primary join, so results for inactive versions are dropped even if the auxiliary index briefly lists them. If step 6 aborts, the staged indexes are compensated away; because they were never visible to readers (the primary pointer still says `version=N` is active), there is no observable window.

**Retry policy.** Each idempotent step has exponential backoff (max 3 attempts, 100 ms/400 ms/1600 ms). Non‑idempotent / non‑redoable steps (primary.purge, snapshot.stage) run at most once. After final failure the op is ABORTED and compensations run; `retryable: false` surfaces to the caller.

**Boot‑time recovery.** On every `cairn daemon start`:

1. Read `wal_ops` + `wal_steps` from `.cairn/cairn.db`; rebuild an in‑memory map of ops by `operation_id` with their latest marker (`ISSUED | PREPARED | step:N:done | COMMITTED | ABORTED`). No file scan — the DB is the sole source of truth.
2. Build a dependency DAG from the `dependencies` field of every un‑terminal op; topologically sort. Ops whose deps aren't terminal wait.
3. **TTL applies to new external requests, not to WAL recovery.** The `expires_at` field rejects fresh `ingest/forget/promote` calls past the cutoff; **recovery of an already‑PREPARED op runs regardless of TTL** — once PREPARED, the operation is durably committed to either finish or abort with full compensation.
4. For each op in dependency‑safe order, resume at `step:(last_done + 1)` using its operation‑specific step graph; already‑applied idempotent steps are no‑ops via the idempotency key.
5. Phase B physical‑purge children of a COMMITTED `delete`/`forget_*` op are retried idempotently — they have no reader‑visible effect (readers see the tombstone), so partial purge on crash is safe. Children that exhaust retries get flagged `PURGE_PENDING` in `lint`.
6. Successful recovery writes `RECOVERED <op>` next to `COMMIT`; failed Phase A recovery writes `ABORTED <op>` with reason and runs compensations from the staged pre‑image. Phase A is always reversible because its commit is a single atomic SQLite transaction — either every side effect applied or none did.

Persisting per‑step completion markers (`step:N:done`) is what makes step 3 above safe: recovery never "replays the fan‑out" blindly — it resumes from the exact last known good step and honors operation‑specific rollback rules.

**Concurrent‑writer safety (§10.1 ordering).** WAL deps + locks implement the single‑writer constraint: `ConsolidationWorkflow > LightSleep > REMSleep > DeepDream`. A lower‑priority op that hits a locked entity queues its WAL entry with `dependencies: [<higher‑priority‑op>]` and waits via the dependency DAG — no priority inversion, no write loss. Recovery replay walks the same DAG, so crash recovery respects the same precedence.

**What the WAL is *not*:** it is not a replication log for federation (that's a separate `change_feed` stream layered on top), and it is not a distributed consensus log (single machine; federation's hub zone runs its own Nexus replication underneath). It is a local crash‑safety + idempotency + atomicity primitive.

**Backed by.** Sandbox profile stores WAL on the same SQLite file (WAL journaling mode — `PRAGMA journal_mode=WAL;` — composed with Cairn's higher‑level op log). Hub profile delegates underlying durability to PostgreSQL WAL; Cairn's op log layers on top for the app‑level idempotency + compensation semantics SQLite/PostgreSQL WAL don't provide.

**Where this is used:**

| Consumer | WAL guarantee it relies on |
|----------|-----------------------------|
| US2 session reload | every turn committed durably; replay of an interrupted write resurrects the turn without gaps |
| US8 session delete | all child records vanish atomically; no search hit survives `forget --session` |
| US6 archive | move‑to‑cold is one op with its own idempotency key; interrupted archive doesn't leave half‑cold records |
| §10.1 single‑writer ordering | dependencies field enforces deterministic precedence under contention |
| §11.3 evolution rollout | canary → full rollout is one multi‑step op; rollback uses the WAL's compensating ops |

---

## 6. Taxonomy

### 6.1 MemoryKind — 19 values

`user`, `feedback`, `project`, `reference`, `fact`, `belief`, `opinion`, `event`, `entity`, `workflow`, `rule`, `strategy_success`, `strategy_failure`, `trace`, `reasoning`, `playbook`, `sensor_observation`, `user_signal`, `knowledge_gap`.

- **`trace`** captures *what happened* (tool calls, tool results, timeline).
- **`reasoning`** captures *why the agent chose what it did* — decision rationale, alternatives considered, heuristics applied. Stored as memory content, not just trajectory bytes.
- **`knowledge_gap`** captures what the agent *could not answer* — drives eval dataset generation and targeted lint fixes.
- **`strategy_success` / `strategy_failure`** — Cairn learns from **both**. Failure trajectories are first‑class; they feed evolution just as strongly as successes.

### 6.2 MemoryClass — 4 values

`episodic` · `semantic` · `procedural` · `graph`.

### 6.3 MemoryVisibility — 6 tiers

`private` → `session` → `project` → `team` → `org` → `public`. Promotion between tiers always requires an entry in `.cairn/consent.log`.

### 6.3.a Factual stores vs conversational memory

Not every record is a conversation. Code changelists, RFCs, specs, tickets, P&Ls, CLs, and structured data files are **factual** — retrieved differently from conversational memories.

| Axis | Conversational (`trace`, `event`, `feedback`, `user`, `reasoning`) | Factual (`fact`, `entity`, `reference`, `workflow`, `rule`) |
|------|-------|---------|
| Retrieval weighting | recency‑heavy; salience from user signals | authority‑heavy; salience from source rank (e.g., merged CL > open CL) |
| Staleness | decays naturally after days / weeks | only stale when the underlying source changes |
| Identity | content‑hash + session | stable external ID (CL number, ticket ID, doc URI) |
| Merge policy | preserve both and let consolidation compress | authoritative replace on source update |
| Visibility default | `private` | inherits from source (often `team`/`org`) |

Cairn's `Ranker` pure function reads the kind to pick the right weighting; `Consolidator` branches on the same. A factual store (e.g., a code‑changelist mirror) is just a large set of `fact_*.md` records under a dedicated sub‑tree; retrieval treats them differently from the mixed‑kind working memory.

### 6.4 ConfidenceBand + Evidence Vector

Confidence is a single scalar; **Evidence** is the multi‑factor vector that drives promotion and decay decisions. A record must clear both.

- **ConfidenceBand** (scalar):
  - `> 0.9` — eligible for promotion if evidence also clears
  - `[0.3, 0.9]` — normal recall
  - `< 0.3` — uncertain; suppressed unless explicitly requested
  - Updates: REINFORCE +0.1, WEAKEN −0.1, CONTRADICT → 0.2 — atomic counters, no read‑modify‑write races

- **Evidence vector** (four components, each threshold‑configurable per `MemoryKind` in `.cairn/config.yaml`):

  | Component | Default gate | Meaning |
  |-----------|--------------|---------|
  | `recall_count` | ≥ 3 | times this record has been returned by a Read path (shows it's actually useful) |
  | `score` | ≥ 0.7 | best retrieval score across recalls (shows it's a strong hit, not a lucky match) |
  | `unique_queries` | ≥ 2 | number of distinct queries that surfaced this record (shows generality) |
  | `recency_half_life_days` | 14 | exponential decay horizon; older evidence weighs less |

  Promotion, expiration, and LightSleep/REMSleep/DeepDream scheduling all read the evidence vector, not just confidence. Same pattern as OpenClaw's deep‑dreaming gates.

### 6.5 Provenance (mandatory on every record)

`{source_sensor, created_at, llm_id_if_any, originating_agent_id, source_hash, consent_ref}` — always present. Never optional.

---

## 6.a Multi‑Modal Memory

Not all memory is text. Cairn's `ingest` verb already accepts non‑text payloads; §6.a is the architecture that makes them first‑class.

- **Multi‑modal sensors.** Video (frame capture + temporal index), audio (transcription + speaker‑diarized segments), image (scene + object embeddings), and binary structured streams (sensor telemetry, packet captures). Each lands in `sources/<modality>/` with provenance; none are mutated.
- **Record stores the caption, not the bytes.** A `sensor_observation` record for a video clip stores: timecode range, auto‑caption, extracted entities, scene summary, and a URI reference to the raw clip in `sources/`. Retrieval matches on the text surface; playback opens the raw clip.
- **Temporal index.** Multi‑modal records share a `time_range: {start, end}` field; a dedicated `TemporalIndex` plugin (implements the `MemoryStore` cross‑cutting trait) answers queries like *"what happened between 14:00 and 16:00 on camera 4?"* across any modality.
- **Cross‑modal correlation.** A `Consolidator` variant joins records with overlapping `time_range` + shared `entities` into a single composite record under `wiki/synthesis/`. Use case: a transcript segment + the screen capture at the same timestamp + the commit that followed → one synthesis page.
- **Embedding model per modality.** `LLMProvider` is extended with a `multimodal_embed(blob, kind) → vector` capability; providers declare which modalities they support. Cairn routes by modality; unsupported modalities fall back to caption‑only indexing.
- **Cost control.** Dense video frame embedding is disabled by default; enable per source (`sources/<id>/config.yaml: dense_embed: true`) so a specific camera / channel can opt in without blanket cost.

## 7. Hot Memory — the Always‑Loaded Prefix

Every harness turn starts with a hot‑memory assembly:

- Bounded **200 lines / 25 KB**.
- Composed from `purpose.md` + `index.md` + pinned `user`/`feedback` memories + highest‑salience `project` memories + active `playbook` + recent `user_signal`s.
- Assembled by the `HotMemoryAssembler` pure function.
- Cached per‑agent in the hot tier.
- Re‑assembled on Dream (nightly), on high‑salience write, and on `SessionStart`.
- Surfaced via MCP `assemble_hot` so non‑Koi harnesses consume the exact same prefix.

**Tiered token budget:**

| Tier | What | Cost |
|------|------|------|
| Always | hot‑memory prefix + harness config | ~2 KB |
| On‑demand | semantic / FTS / graph hits for the current turn | targeted |
| Triggered | classification + validation hooks | ~100 + ~200 tokens |
| Rare | full file reads | only when explicitly asked |

---

## 7.1 Auto‑Built User Profile

`assemble_hot` includes a synthesized profile that grows automatically from every turn, without the user maintaining it.

Three sections, refreshed on `DreamWorkflow` runs:

- **summary** — current snapshot of the user: role, goals, active projects, preferred style. ~300 words.
- **historical_summary** — narrative of what's happened and been resolved. Append‑only in spirit; old entries compress, never vanish.
- **key_facts** — structured fields: `devices`, `software`, `preferences`, `current_issues`, `addressed_issues`, `recurring_issues`, `known_entities`.

Each field is derived from `user_*.md` + `feedback_*.md` + `entity_*.md` + `strategy_*_*.md` records. A `UserProfileSynthesizer` pure function produces the frontmatter + markdown body; `HotMemoryAssembler` includes the profile summary in the top of the hot prefix. The profile has its own evidence gates — a `current_issue` is only listed after it appears in two turns on different days.

## 8. MCP Surface — Versioned Verb Set

**Contract version.** `cairn.mcp.v1` — the entire verb set below is frozen under this name; a breaking change yields `cairn.mcp.v2` and both versions run side by side during deprecation. The contract version, verb list, and per‑verb schema are generated from the single IDL (§13.5); wire‑compat tests fail CI on drift. Clients declare the version they implement via capability negotiation at handshake; Cairn refuses unknown verbs rather than silently dropping them.

### 8.0 Core verbs (always present in `cairn.mcp.v1`)

| # | Verb | What it does | Auth requirement |
|---|------|--------------|-------------------|
| 1 | `ingest` | push an observation (text / image / video / tool call / screen frame / web clip) | signed actor chain; rate‑limited per‑agent (§4.2) |
| 2 | `search` | BM25 + ANN + graph hybrid across scope | rebac‑gated; results filtered per visibility tier |
| 3 | `retrieve` | get a specific memory by id (and related edges) | rebac‑gated; unverified chain → `trust: "unverified"` flag unless `allow_unverified: true` |
| 4 | `summarize` | multi‑memory rollup; optional `persist: true` files the synthesis as a new `reference` or `strategy_success` memory with provenance | rebac‑gated on sources; `persist` requires write capability |
| 5 | `assemble_hot` | return the always‑loaded prefix for this agent/session | rebac‑gated on sources |
| 6 | `capture_trace` | persist a reasoning trajectory for later ACE distillation | signed actor chain |
| 7 | `lint` | health check — contradictions, orphans, stale claims, missing concept pages, data gaps; returns a structured report and optionally writes `lint-report.md` | read‑only; `write_report: true` requires write capability |
| 8 | `forget` | delete record, session, or scoped set. `mode` is capability‑gated: `record` is always present in `cairn.mcp.v1`; `session` requires the `cairn.mcp.v1.forget.session` capability (advertised in v0.2+ runtimes only); `scope` requires `cairn.mcp.v1.forget.scope` (v0.3+). A runtime that does not advertise a capability must reject calls with that `mode` rather than silently succeeding. Transactional under §5.6 WAL. | signed principal (human) with `Forget` capability for the target tier |

`forget` is the single delete surface — the CLI `cairn forget …` is a thin wrapper calling this verb. There is no undocumented delete path. Clients must inspect `handshake.capabilities` to discover which `mode` values this runtime supports; CI wire‑compat tests fail if a v0.1 runtime advertises a mode it cannot execute.

**Citations mode.** Every read verb (`search`, `retrieve`, `summarize`, `assemble_hot`) accepts a `citations: "on" | "compact" | "off"` flag, resolved from `.cairn/config.yaml` by default. `on` appends `Source: <path#line>` to each recalled snippet; `compact` appends only a single citation per record; `off` returns content without paths. Turn compact or off in harnesses whose UI shouldn't expose file paths to end users.

### 8.0.a Extension namespaces (opt‑in, capability‑gated)

Optional verbs live in named extensions registered at startup and advertised via capability negotiation. Clients that don't request an extension never see its verbs; Cairn rejects calls to extensions the caller didn't opt into.

| Extension | Adds verbs | Enabled by | Auth requirement |
|-----------|-----------|------------|-------------------|
| `cairn.aggregate.v1` | `agent_summary` · `agent_search` · `agent_insights` (§10.0) | `.cairn/config.yaml` → `agent.enable_aggregate: true` | rebac‑gated, results are anonymized aggregates only |
| `cairn.admin.v1` | `snapshot` · `restore` · `replay_wal` | operator role | hardware‑key countersigned principal |
| `cairn.federation.v1` | `propose_share` · `accept_share` · `revoke_share` | enterprise deployments only | signed `ShareLinkGrant` |

Extensions extend the surface; they do not reinterpret core verbs. A verb ID belongs to exactly one namespace for the life of the contract version.

### 8.0.b Every verb declares the same envelope

All verbs — core and extension — share a single request/response envelope so policy enforcement and auth are uniform:

```json
// Request
{
  "contract": "cairn.mcp.v1",
  "verb": "forget",
  "signed_intent": { /* signed payload envelope §4.2 */ },
  "args": { "mode": "session", "session_id": "..." }
}

// Response
{
  "contract": "cairn.mcp.v1",
  "verb": "forget",
  "operation_id": "01HQZ...",       // matches the WAL op
  "status": "committed | aborted | rejected",
  "data": { ... },
  "policy_trace": [ { "gate": "forget_capability", "result": "pass" }, ... ]
}
```

`policy_trace` is always present on mutating verbs so auditors see which gates ran and how they decided — not just the final outcome.

MCP is the **only** public entry point. Everything else — CLI commands, hooks, library calls — routes through the core or extension verbs internally. A CLI like `cairn forget --session <id>` is syntactic sugar over `verb: "forget", args: {...}`.

---

## 8.1 Session Lifecycle — Auto‑Discovery + Auto‑Create

All eight core MCP verbs accept an optional `session_id`. When absent, Cairn applies this policy:

1. **Find** the user's most recent active session for this `agent_id` (within a configurable idle window, default 24 h).
2. **If found** — reuse it; append turns to it.
3. **If not found** — create a new session with `title: ""` (populated later by the first `DreamWorkflow` pass) and metadata from the caller.
4. Return the resolved `session_id` in every response.

This mirrors the "just call `ingest` — I don't want to manage sessions" pattern production memory services use. Harnesses that *do* track sessions pass `session_id` explicitly and opt out of auto‑discovery.

Sessions carry metadata (`channel`, `priority`, `tags`), emit a `session_ended` event when the idle window elapses, and are searchable via the `search` verb with `scope: "sessions"` — the same way records are searchable.

## 9. Sensors and User Signals

### 9.1 Sensors — two families, all opt‑in per‑sensor

**No UI required.** Every sensor enables via config (`.cairn/config.yaml`) or CLI flag (`cairn sensor enable <name>`). Sensors run as background daemons under `cairn daemon start` — works on headless servers, SSH sessions, and CI runners. The desktop GUI (§13) is purely optional: it exposes the same toggles but is never required to turn a sensor on or off.

**Local sensors** — run on the same machine as Cairn, emit events into the pipeline as they happen:

| Sensor | What it captures | Privacy |
|--------|------------------|---------|
| Hook sensor | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `Stop` — harness‑agnostic (CC / Codex / Gemini) | harness‑scoped |
| IDE sensor | file edits, diagnostics, tests run, language server events | opt‑in per project |
| Terminal sensor | captured commands + outputs | opt‑in, secret‑scrubbed |
| Clipboard sensor | clipboard snapshots | opt‑in |
| Screen sensor | frames via OS‑native capture APIs | opt‑in, per‑app allow‑list, password fields blurred |
| Neuroskill sensor | structured agent tool‑call traces emitted by the harness itself | always on when harness cooperates |

**Source sensors** — pull from external systems on a schedule or on `ingest` command. Each is a separate L2 adapter package; install only what you need. All require explicit auth + consent:

| Sensor | What it ingests | Typical use |
|--------|-----------------|-------------|
| Slack sensor | channel messages, threads, DMs, user profiles (scope: declared channels only) | meeting recaps, decision logs, people profiles |
| Email sensor | inbox messages + threads + attachments (via IMAP or provider API) | correspondence context, action items |
| Calendar sensor | meetings, attendees, notes fields | who‑met‑whom graph, agenda prep |
| GitHub / GitLab sensor | PRs, issues, comments, commits, discussions | code review context, decision history |
| Notion sensor | pages, databases, comments (via Notion connector / API) | team wikis, CRMs, task databases |
| Obsidian / vault sensor | adjacent markdown vault with wikilinks | import an existing Obsidian second brain |
| Document sensor | PDF, markdown, DOCX, Confluence exports, plain text | knowledge base ingestion |
| Transcript sensor | meeting transcripts (Zoom, Meet, local recording) | 1:1 history, decision capture |
| Web sensor | `cairn clip <url>` — fetch + Readability + markdown | article clipping, research |
| RSS / Atom sensor | feed polling | long‑running research loops |
| Harness‑memory import | `cairn import --from <chatgpt|claude-memory|notion|obsidian>` one‑shot migration | leave another memory system without losing context |

**All source sensors emit through the same write path** (§5.2). They are not a parallel pipeline — they are just different starting points for `Capture`. A Slack message and a screen frame are both `raw events` once they enter `Extract`.

**Ingestion rate limits and budget.** Every source sensor declares a per‑scope budget (`max_items_per_hour`, `max_bytes_per_day`). Cairn's Filter stage enforces these. Exceeding budget routes to `discard(budget_exceeded)` and surfaces in the next `lint` report — Cairn never silently drops under budget pressure.

### 9.2 User signals

`UserSignalDetector` derives signals from the sensor stream: typing speed, correction rate, re‑prompt count, feedback verbosity, rejection rate. Signals are stored as `user_signal` memories and feed the `UserModel` that influences `HotMemoryAssembler`.

### 9.3 The five‑hook lifecycle

| Hook | When | What Cairn does |
|------|------|-----------------|
| `SessionStart` | startup / resume | `assemble_hot` builds the prefix; semantic re‑index runs in background |
| `UserPromptSubmit` | every message | lightweight classifier emits routing hints |
| `PostToolUse` | after `.md` write | validate frontmatter, wikilinks, orphan status |
| `PreCompact` | before context compaction | snapshot the transcript to `raw/trace_*.md` for later ACE distillation |
| `Stop` | end of session | trigger end‑of‑session Dream pass + orphan check |

Hooks are plain scripts executed via `bunx cairn hook <name>`. A single Cairn binary wires identically into CC's `.claude/settings.json`, Codex's `.codex/hooks.json`, and Gemini's `.gemini/settings.json`.

---

## 10. Continuous Learning — Eight Durable Workflows

**Orchestrator truth table (by version).** Every durability and replay claim in this section applies to whichever `WorkflowOrchestrator` plugin the deployment has selected. Both default and optional adapters satisfy the same `WorkflowOrchestrator` contract (§4, §4.1); swapping is a config change.

| Version | Default orchestrator | Optional adapters | Guarantees covered |
|---------|-----------------------|-------------------|---------------------|
| v0.1 | `tokio` + SQLite job table (in‑process, single binary, zero services) | none exposed yet | crash‑safe resume, exponential retry, single‑writer queue per key, step‑level idempotency via `operation_id` |
| v0.2 | `tokio` + SQLite (unchanged default) | TypeScript Temporal worker sidecar (official TS SDK, GA) via HTTP/gRPC kick | same as v0.1 plus cross‑process replay, Temporal UI for observability, long‑lived timer workflows |
| v0.3+ | `tokio` + SQLite (unchanged default) | Rust Temporal worker using `temporalio-sdk` + `temporalio-client` if GA, else TS sidecar | same plus multi‑node failover; Temporal becomes preferred path when Rust SDK ships GA |

This section's prose describes workflow *behavior* (Dream, Reflection, Consolidation, etc.) that the orchestrator schedules — it does not rely on Temporal‑specific features. "Temporal" in prose below is shorthand for "the durable `WorkflowOrchestrator`", which at v0.1 is the tokio+SQLite default.

### 10.0 One memory's lifecycle — from capture to cold

A single record moves through these stages over its lifetime. Every transition is a workflow, every gate is auditable, every step is reversible until `forget` is called.

```
  CAPTURE           WORKING MEMORY          PUBLIC ARTIFACT            ARCHIVE / FORGET
 ────────────      ───────────────────     ────────────────────       ──────────────────────

 sensor event      raw/user_*.md           wiki/entities/*.md          cold/session_*.tgz
 hook event        raw/feedback_*.md       wiki/summaries/*.md         (Nexus snapshot
 MCP ingest        raw/trace_*.md          skills/*.md                  bundles, object
      │            raw/turn_*.md            │                           storage)
      ▼            (private,                │                                   ▲
  ┌───────────┐    LLM‑owned)               │                                   │
  │  Extract  │         │                   │                                   │
  │  Filter   │         │                   │                                   │
  │  Classify │         │                   │                                   │
  │  Scope    │         │                   │                                   │
  │  Match    │         │                   │                                   │
  │  Rank     │         │                   │                                   │
  │  FlushPlan│         │                   │                                   │
  │  Apply    │─── WAL ─┤                   │                                   │
  │  (§5.6)   │         │                   │                                   │
  └───────────┘         │                   │                                   │
                        │                   │                                   │
                        │  confidence ≥ 0.9 │                                   │
                        │  evidence gates   │                                   │
                        │  truth signals    │                                   │
                        │  review gate      │                                   │
                        │  (if shared tier) │                                   │
                        ├──► PromotionWorkflow ─────────────────►               │
                        │                   │                                   │
                        │                   │  idle > 30 days +                 │
                        │                   │  recall_count = 0                 │
                        │                   │                                   │
                        │                   ├──► ExpirationWorkflow ────────────┤
                        │                   │                                   │
                        │   recall_count=0, │                                   │
                        │   confidence<0.3, │                                   │
                        │   idle > 90d      │                                   │
                        ├──► ExpirationWorkflow ─────────────────────────────── ┤
                        │                   │                                   │
                        │                   │   new trace contradicts           │
                        │                   │   existing claim                  │
                        │                   │                                   │
                        │   ◄─── ConflictDAG ─── ConsolidationWorkflow          │
                        │   (keep both, mark                                    │
                        │    disputed)                                          │
                        │                                                       │
                        │   stale source / new version                          │
                        ├──► StalenessScanner ─── ReflectionWorkflow            │
                        │                                                       │
                        │                                                       │
                        │                                                       │
                        ▼                                                       ▼
              ┌─────────────────────┐                         ┌──────────────────────┐
              │ forget --record <id>│                         │ retrieve(rehydrate:  │
              │ or                  │                         │ true) pulls cold     │
              │ forget --session<id>│                         │ bundle back to warm  │
              │ zeros embeddings,   │                         │ in < 3 s (§15 gate)  │
              │ drops indexes,      │                         │                      │
              │ writes consent.log  │                         └──────────────────────┘
              └─────────────────────┘
```

**Tiers are where the data lives, not what kind it is.** A `fact` record can be in hot SQLite, warm (evicted from LRU but still in SQLite), or cold (packed into a snapshot bundle). Metadata always stays hot so `search` still finds cold records — only the body needs rehydration.

**Workflow table below lists cadences and triggers. The diagram above is the map.**

Durable. If the host dies, they resume on the next start. No cron to forget.

**Orchestrator.** Default is a Rust‑native `tokio` + SQLite job runner — crash‑safe, single binary, zero services. Large deployments can swap in a **Temporal** adapter. Two Temporal paths, pick by maturity appetite:

- **Rust Temporal worker** using `temporalio-sdk` + `temporalio-client` (crates.io, currently prerelease/prototype built on the stable `temporalio-sdk-core`). Single‑language, single binary. Becomes the preferred path once the Rust SDK ships GA.
- **TypeScript Temporal worker sidecar** — Rust core enqueues kicks over HTTP/gRPC; a thin TS worker (official Temporal TS SDK, GA) runs the workflows. Safer today; extra process to operate.

| Workflow | Cadence | What it does |
|----------|---------|--------------|
| `DreamWorkflow` | **three tiers** (see §10.1) | orient → gather → consolidate → prune |
| `ReflectionWorkflow` | on turn end | active nudges — "you already learned X; consider it" |
| `ConsolidationWorkflow` | per‑entity on write | merge duplicates, update confidence + evidence vector, update graph edges |
| `PromotionWorkflow` | continuous | `episodic → procedural`; gated on the full evidence vector (§6.4): `recall_count ≥ 3 AND score ≥ 0.7 AND unique_queries ≥ 2 AND confidence > 0.9` (all thresholds configurable per kind); targets include `skills/`, `wiki/`, `purpose.md`, harness config files, with **public‑artifact review gate** when visibility crosses private→team |
| `PropagationWorkflow` | on user consent | `private → team → org`; requires explicit assent; writes to `consent.log` |
| `ExpirationWorkflow` | hourly | tiered decay + multi‑factor salience |
| `EvaluationWorkflow` | nightly + on PR | orphan detection, conflict DAG, staleness scan, benchmark suite; generates eval datasets from trajectories (synthetic + replay from `raw/trace_*.md`) |
| `EvolutionWorkflow` | on schedule + on signal | self‑evolve skills, prompts, tool descriptions — §11 |

### 10.0 Cross‑User Aggregate Memory (agent‑level)

When a single `agent_id` serves many users, each user's private memory stays private — but **anonymized aggregates** become useful ("what do my users keep asking about?"). Cairn exposes this through a dedicated read surface, off by default.

- **Toggle per agent**: `.cairn/config.yaml` → `agent.enable_aggregate: true`.
- **What's aggregated**: `common_topics`, `common_issues` (with `frequency` + `typical_resolution`), `usage_patterns.top_categories`. Built by an `AggregateSynthesizer` pure function from public‑artifact records across users, never from private working memory.
- **Three aggregate read verbs** exposed as the `cairn.aggregate.v1` extension (§8.0.a) when the toggle is on, alongside the eight core verbs:
  - `agent_summary()` → current aggregate snapshot
  - `agent_search(query)` → cross‑user semantic search (anonymized)
  - `agent_insights(query)` → natural‑language Q&A across all users
- **No individual records leak.** Aggregation is by `PropagationPolicy`; results include counts + examples, never identifiers.
- **Latency expectation**: aggregate is rebuilt on `DeepDream` cadence; `has_aggregate: false` is returned until the first pass completes.

### 10.1 Three‑tier dreaming

`DreamWorkflow` is not one cadence — it's three, each with a different depth and trigger. Same pattern OpenClaw converged on (`light sleep` / `REM sleep` / `deep dreaming`):

| Tier | Cadence | What runs | Reads | Writes |
|------|---------|-----------|-------|--------|
| **Light sleep** | every `Stop` hook + every N turns | cheap passes: orphan detection, duplicate detection, index maintenance | current session + last 24 h | idx updates, conflict markers |
| **REM sleep** | hourly or on high‑salience write | mid‑depth: consolidate per‑entity, update graph edges, active reflection nudges | last 7 days | consolidated records, `ReflectionWorkflow` kicks |
| **Deep dreaming** | nightly or cron | full sweep: evidence‑gated promotion, skill emission, conflict DAG resolution, staleness scan, cross‑session pattern synthesis | entire vault | promotions, new `skills/`, new `wiki/synthesis/` pages, `lint-report.md` |

Each tier is a FlushPlan producer (§5.5) — the plan is serialized before apply, so a deep‑dream run is reviewable and replayable.

---

## 11. Self‑Evolution — the Evolution Workflow

Memory without evolution stagnates. `EvolutionWorkflow` takes existing artifacts (skills, prompts, tool descriptions) and produces measurably better versions by reading execution traces and proposing targeted mutations. No GPU training; everything runs via the `LLMProvider`.

### 11.1 Evolvable artifacts

| Phase | Target | Location |
|-------|--------|----------|
| 1 | Skill files | `skills/<skill>.md` |
| 2 | Tool descriptions | tool registry metadata |
| 3 | System prompt fragments | `wiki/prompts/*.md` |
| 4 | Playbooks | `raw/playbook_*.md` |
| 5 | Harness config files | `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` |

### 11.2 Flow

```
[Current artifact] ──► [Eval dataset build]           (synthetic + trace replay from raw/trace_*.md + raw/reasoning_*.md)
       │                      │
       │                      ▼
       │              [Variant generator]              (reflective prompt mutation — reads WHY things failed,
       │                      │                        not just THAT they failed)
       │                      ▼
       │              [Candidate variants]             (N per iteration)
       │                      │
       │                      ▼
       │              [Evaluate against dataset]
       │                      │
       └──► [Constraint gates] ◄──────────────────────
                │   tests pass · size limits · semantic preservation · caching compat · confidence non‑regression
                ▼
         [Best variant] ──► [Promotion step]
                              │
                              ▼
                     (review gate — autonomous or human) ──► replace artifact + append to consent.log
```

### 11.3 Constraint gates (version‑scoped promotion predicate)

Every artifact promoted via `EvolutionWorkflow` or created via Skillify (§11.b) goes through the **same single promotion predicate** — the predicate's gate set is version‑scoped to match the v0.1 / v0.2 / v0.3+ capability matrix (§18.c):

| Version | Required gates | Skillify output status if remaining gates absent |
|---------|-----------------|---------------------------------------------------|
| v0.1 | gates 1–6 | `live` is permitted once 1–6 pass. Skills that also need shared‑tier promotion, adversarial held‑out, or canary rollout must wait for v0.3+. |
| v0.2 | gates 1–7 (adds held‑out adversarial) | `live` permitted once 1–7 pass. |
| v0.3+ | gates 1–9 | full predicate; no alternate path to `live`. |

There is no "bypass" — a skill that cannot satisfy the predicate for the current version stays in `candidate` status, runs in dry‑run mode, and is surfaced in `lint`. CI enforces the version‑appropriate gate subset in `cairn promote --check`.

1. **Test suite** — any behavioral test the artifact has (golden queries, contract tests, replay cassettes) must pass 100%.
2. **Size limits** — skills ≤ 15 KB, tool descriptions ≤ 500 chars, hot‑memory prefix ≤ 25 KB / 200 lines.
3. **Semantic preservation** — the variant must score ≥ baseline on a similarity check against the original artifact's declared purpose (prevents drift).
4. **Caching compatibility** — no mid‑turn mutations; variants only swap in at `SessionStart` boundaries.
5. **Confidence non‑regression** — the evolved artifact's measured outcome confidence must not decrease across the eval dataset.
6. **Review gate** — `.cairn/config.yaml` declares `autonomous | human_review`; `human_review` writes a PR‑style diff to `.cairn/evolution/<artifact>.diff` and waits for approval.
7. **Held‑out adversarial dataset** — in addition to the main eval set, the artifact must pass a frozen held‑out set of cases that stress its failure modes. The held‑out set is never seen during authoring and is rotated each quarter.
8. **Canary rollout with rollback** — the artifact is first enabled for a small percentage of traffic (default 5 %); the canary must match or beat baseline on key SLOs for `canary_window` (default 24 h) before full rollout. Any regression automatically rolls back via the WAL op's compensating steps.
9. **Shared‑tier gate** — if the artifact touches a shared‑tier surface (team / org / public), a fresh `ConsentReceipt` signed by a principal with promotion capability for that tier is required at promote time (re‑verified at apply time per §4.2).

CI enforces all nine via `cairn promote --check` before any `wal_ops.state` can flip to `COMMITTED` for a promotion op.

### 11.4 Eval dataset sources

- **Synthetic** — `LLMProvider` generates scenarios from the artifact's declared purpose.
- **Trajectory replay** — `raw/trace_*.md` + `raw/reasoning_*.md` replayed against the artifact; success and failure trajectories both contribute.
- **Knowledge gaps** — `raw/knowledge_gap_*.md` entries become targeted eval items (the artifact must now answer what it previously could not).
- **User feedback** — `raw/feedback_*.md` entries with corrective signal.

### 11.5 Memory‑aware test‑time scaling

Evolution and recall are bidirectional: `EvolutionWorkflow` improves the artifacts that `assemble_hot` + `search` rely on; richer recall during a turn produces stronger traces, which in turn feed the next evolution cycle. The more turns Cairn serves, the better its artifacts get — without additional model training.

### 11.6 Capture triggers — what causes Cairn to memorize

Capture is not naive logging. It fires on these explicit signals (recorded as the `reason` frontmatter field on the resulting memory):

| Trigger | Resulting memory |
|---------|------------------|
| User correction (explicit "no, do X instead") | `feedback` |
| Tool failure / error trace | `strategy_failure` |
| Novel tool sequence that succeeded | `strategy_success` + candidate `playbook` |
| Agent said "I don't know" / retrieval returned nothing | `knowledge_gap` |
| Novel entity / fact / rule encountered | `entity` / `fact` / `rule` |
| User stated a preference or constraint | `user` |
| Session boundary (`PreCompact`, `Stop`) | `trace` + `reasoning` |
| Sensor event passed policy gate | `sensor_observation` |
| Derived user‑behavior signal | `user_signal` |

Triggers outside this set default to `discard(low_salience)` — §5.2 enumerates discard reasons.

---

## 11.a Graph of Skills — Dependency‑Aware Structural Retrieval

Skills are not a flat pile. They form a **directed acyclic dependency graph** — `ship-a-pr` depends on `run-tests` depends on `lint-the-diff`. Retrieving a skill that has unmet prerequisites is worse than useless, so Cairn surfaces the DAG explicitly.

- **Declared dependencies.** Every `skills/*.md` frontmatter carries `requires: [<skill_id>, …]` and `provides: [<capability>, …]`. `SkillEmitter` infers these from the trajectory that produced the skill; `EvolutionWorkflow` can refine them.
- **Graph is a first‑class store.** `MemoryStore`'s `graph` class holds `(skill) --requires--> (skill)` edges. A `SkillGraphResolver` pure function answers "what's the ordered prerequisite chain for skill X?" in one traversal.
- **Retrieval walks the graph, not just the flat store.** The `search` verb with `kind: playbook | strategy_success` returns hits *and* their prerequisite closures, so the agent sees the full activation context in one call.
- **Evolution respects the graph.** `EvolutionWorkflow` only mutates a skill if its declared `provides` set stays stable (any regression would break dependents). Dependents are listed in the constraint‑gate report.
- **Unmet‑prereq memory.** When a turn fails because a prerequisite is missing, Cairn writes a `knowledge_gap` record with `missing_skill: <id>` — so subsequent evolution has a directed target.
- **Public skill catalogs.** When `wiki/skills/` is shared cross‑user (via PropagationWorkflow), the dependency graph is shared with it; consumers pull the closure, not the leaf.

This is what makes skills *compound* — `strategy_success` stays strategy‑scoped, but its dependency closure lets the agent assemble bigger plans turn‑after‑turn.

## 12. Deployment Tiers — Same Interfaces, Different Adapters

| Tier | Who it's for | Adapters | Cloud? |
|------|--------------|----------|--------|
| **Embedded** | library mode inside a harness | Nexus `sandbox` profile sidecar (SQLite + BM25S + `sqlite-vec` semantic when embedding key available; BM25S keyword fallback otherwise) + in‑process LLM + `tokio` job runner | none |
| **Local** | laptop, single user, researcher, air‑gap | same as Embedded + optional federation to a peer Nexus | none |
| **Cloud** | team / enterprise | Nexus `sandbox` per client **federated to** a shared Nexus `full` hub (PostgreSQL + Dragonfly + Zoekt + txtai) + any OpenAI‑compatible LLM + optional Temporal | yes |

Switching tiers is a change in `.cairn/config.yaml`. The vault on disk, the MCP surface, the CLI, the hooks — all unchanged.

## 11.b Skillify — turning every failure into a permanent skill with tests

The Evolution Workflow (§11) can mutate prompts and tool descriptions, but most failures don't need a model change — they need a **procedural fix** that makes the bug structurally impossible to recur. Skillify is the loop that promotes a one‑off failure into a tested, durable skill.

**The core move: split latent vs. deterministic work.** An agent that does timezone math in its head, grep by LLM reasoning, or API calls for data it already has on disk is doing deterministic work in latent space. The fix is not a better prompt — it is a **deterministic script** the agent is *forced* to call, plus a `skill_*.md` contract that tells the agent when the script replaces judgment. The agent itself writes the script; the skill then constrains the agent to use it.

**The 10‑step checklist (enforced by `cairn lint --skill`):**

Every promotion from failure to durable skill must complete all ten before `EvolutionWorkflow` marks it `live`:

| # | Artifact | Purpose |
|---|----------|---------|
| 1 | `skill_*.md` | The contract: name, triggers, rules, decision tree. Latent‑space procedure the model follows. |
| 2 | Deterministic script (`scripts/<skill>.*`) | The code the skill forces the agent to call. Zero LLM, bounded runtime. Agent authors the first draft from the failure trace. |
| 3 | Unit tests | Pure‑function coverage of the deterministic script. Fixture‑driven. |
| 4 | Integration tests | Same script against real endpoints / real data; catches fixture‑too‑clean bugs. |
| 5 | LLM evals | Rubric‑based checks — did the agent call the script, or try to reason its way around it? Caught by `LLM‑as‑judge` cases in the eval harness. |
| 6 | Resolver trigger | Entry in the `skills` catalog (Nexus `catalog` brick, §4.2) routing intent → skill. |
| 7 | Resolver eval | For a set of labelled intents, does the Classifier actually pick the right skill? Two failure modes tested: false negative (skill doesn't fire) and false positive (wrong skill fires). |
| 8 | `check-resolvable` + DRY audit | Walks resolver → skill → script and flags (a) skills not reachable from any trigger and (b) overlapping triggers. |
| 9 | E2E smoke test | Full pipeline: prompt → resolver → skill → script → expected output. Runs in CI. |
| 10 | Filing rules | Where records the skill writes should land (`wiki/entities/…`, `wiki/summaries/…`, etc.). Validated by `lint` against the vault schema. |

A skill that fails any of the ten is stuck at `candidate` status and cannot be promoted; `EvolutionWorkflow` surfaces the gap in the next lint report.

**"Skillify" as a one‑word promotion.** In daily use, the user drops a single directive — `skillify this` — after a successful ad‑hoc procedure. The harness captures the conversation, extracts the decision tree, generates all ten artifacts, and runs them through the normal evolution constraint gates (§11.3) before going live. No manual spec writing, no ticket — the working prototype becomes durable infrastructure in one message.

```
User: "great! so we should actually remember this — skillify it"

       │
       ▼
  [1. Extract skill spec from conversation trace]
  [2. Generate deterministic script from tool‑call sequence]
  [3. Author unit tests from observed inputs/outputs]
  [4. Wire resolver trigger + eval]
  [5. Run the full §11.3 promotion predicate (gates 1-9) + 10-step Skillify checklist]
  [6. On pass: PromotionWorkflow marks skill live]
```

**The three failure modes skillify prevents** (every untested skill system eventually hits all three):

| Failure mode | What goes wrong | Which audit catches it |
|--------------|-----------------|-------------------------|
| Duplicate skills | Agent creates `deploy-k8s` Monday, `kubernetes-deploy` Thursday; both exist, both match similar phrases, ambiguous routing fires the wrong one | DRY audit on `lane` field + resolver‑eval false‑positive test |
| Silent upstream rot | Skill works perfectly when written; six weeks later the external API shape changes; skill quietly returns garbage until a human spots it | Daily integration tests + LLM evals (step 5 + 6 of the 10‑step) |
| Orphan / dark skills | Skill exists on disk but no resolver trigger references it; eats index tokens; never runs; rots | `check-resolvable` on every skill change + weekly |

**Daily health check (`cairn lint --daily`).** Runs every 10‑step artifact's tests, resolver‑evals, DRY audit, check‑resolvable, and the filing‑rules audit every 24 h. Any failure flips a `cairn health` badge from green to red, emits a `knowledge_gap` record, and surfaces in the next `lint-report.md`. "Silent rot" becomes impossible: a skill can't drift for six weeks without the daily check going red.

**`lane` frontmatter field — the DRY primitive.** Every `skill_*.md` declares:

```yaml
---
name: calendar-recall
lane: calendar.historical                 # domain.subdomain, unique within domain
triggers: ["find my trip to …", "when did I go to …", "old calendar entry …"]
uses: scripts/calendar-recall.mjs
files_to: wiki/entities/                  # where records this skill writes land
---
```

The `lane` field is the DRY audit's primary key: within a domain (e.g., `calendar.*`), two skills must not share a subdomain. Overlap → audit fails; the human either merges the skills or disambiguates with a narrower lane. Four calendar skills can coexist (`calendar.historical`, `calendar.upcoming`, `calendar.realtime`, `calendar.conflict-check`); a fifth stepping on another's lane is rejected before it ships. `files_to` + `uses` are parsed by the filing‑rules audit and unreachable‑tool audit respectively.

**Cross‑skill hygiene (the audits that keep skills honest):**

| Audit | What it catches | How it runs |
|-------|-----------------|-------------|
| `check-resolvable` | "Dark" skills with no resolver trigger; scripts referenced by a skill whose file is missing; overlapping triggers that route ambiguously | `cairn lint --resolver`; runs weekly + on every skill change |
| DRY audit | Two skills that do sort‑of the same thing in the same domain — the "calendar-check vs calendar-recall vs google-calendar" pattern | Parses every skill's `lane` declaration in frontmatter; fails on overlap within a domain |
| Unreachable‑tool audit | Scripts with no callers (skill was deleted but script stayed) | Compares `scripts/` tree against every skill's `uses:` list |
| Filing‑rules audit | Skills that write records to the wrong sub‑tree (`wiki/entities/` vs `wiki/summaries/`) | `PostToolUse` hook validates each write against the skill's `files_to:` declaration |

**SkillPacks — portable bundles.** A `SkillPack` is a directory of related skills + scripts + tests + resolver entries that can be installed as a unit. `cairn skillpack install <pack>` pulls the pack, runs the full ten‑step CI against it, and registers triggers with the local resolver. Unistalling is a clean revert (resolver entries removed, skills moved to `archive/`, nothing dangling). Packs are **versioned** and **signed** (same envelope as §4.2 + §13.5.d plugin manifest) so supply‑chain attacks on a pack fail at install time.

**Why this is more than "agent memory + eval harness":** most frameworks give you testing tools without a workflow. Skillify is the workflow: every failure gets a test; every test runs daily; the agent's judgment improves permanently. The loop converges because deterministic scripts bounded the latent space, and latent space authored the deterministic scripts. Skills become the structural memory that prevents the same class of mistake from happening twice.

**Relationship to §11 Self‑Evolution:**

- `EvolutionWorkflow` mutates *existing* skills within §11.3 constraint gates.
- Skillify *creates* new skills from observed failures (or successes promoted by `skillify`).
- Both go through the same single §11.3 promotion predicate (gates 1–9: tests, size, semantic preservation, caching compat, confidence non‑regression, review gate, held‑out adversarial, canary rollout, shared‑tier gate) — skillified skills are not exempt.
- `check-resolvable` + DRY audit are `ReflectionWorkflow` jobs (§10); they feed the lint report every `DeepDream` cadence.

**Prior art acknowledged.** Hermes Agent's `skill_manage` tool shows the right half of this loop: the agent itself authors skills after completing tasks. Cairn takes that further by requiring the ten artifacts and the audits before a skill is considered durable; creation without tests produces silent rot, and the audits are the difference between "a directory full of markdown" and "a substrate the agent can rely on."

---

## 12.a Distribution Model — Beyond Single‑User

Obsidian's vault lives on one laptop; "sync" is a paid plugin or a manual `git` dance. Cairn is **distributed by design** — the same vault format scales from one developer to an entire organization through six concrete mechanisms, all in the doc above but consolidated here:

| # | Mechanism | Role | Section |
|---|-----------|------|---------|
| 1 | **6‑tier visibility** — `private` → `session` → `project` → `team` → `org` → `public` | Every record carries a visibility tier; retrieval and propagation respect it | §6.3 |
| 2 | **Consent‑gated propagation** — `PropagationWorkflow` moves a record up a tier only with explicit user assent, logged in `consent.log` | Team / org sharing without agents leaking private working memory | §10 |
| 3 | **Grant‑based share links** — time‑bound, revocable grants for cross‑agent and cross‑user access | One user shares a specific session or record set with a teammate or another agent, with expiry | §10 (`share_link` brick) |
| 4 | **Federation** — laptop `sandbox` federates `search` queries to a remote `full` hub over HTTP; graceful local fallback on hub unreachable | Per‑user local + shared team hub: each user owns their private vault, team knowledge lives in the hub | §3.0, §12 |
| 5 | **Cross‑user aggregate memory** — `agent_*` verbs expose anonymized aggregates (`common_topics`, `common_issues`, `usage_patterns`) across many users of the same agent | Learn from the whole population without touching individual records | §10.0 |
| 6 | **`.nexus` bundle + git vault** — the vault is a git repo; `.nexus` bundles are native portable packages; Cairn import/export delegates to Nexus `portability` brick | Offline transfer, fork‑and‑merge, auditable history — all with zero custom sync code | §3.0, §16 |

### Four real distribution topologies

| Topology | Who | How Cairn is deployed |
|----------|-----|------------------------|
| **Single user, single machine** | individual dev | sandbox embedded; vault lives in `~/.cairn/`; git optional |
| **Single user, many machines** | individual across laptop + phone + server | sandbox per machine, all federating to the same cloud `full` hub; writes replicate; private tier stays on each machine |
| **Small team, shared knowledge** | 2–20 people | one shared `full` hub; each user keeps a local sandbox that federates to it; team‑tier records propagate through the hub; `share_link` grants cross agents per request |
| **Org‑wide, many agents, many users** | 100+ users × many agent identities | hub per region / business unit; `agent.enable_aggregate: true` on multi‑user agents so operators see anonymized `common_issues` without touching individual vaults; propagation policy tightens per tier (`org` requires two human approvals; `public` requires three) |

### What Obsidian plus sync still doesn't give you

- **Typed propagation** — Obsidian Sync replicates every file; Cairn propagates *by visibility tier and evidence* (a record reaches team only when it's been recalled N times by the private user and they grant propagation). No full mirror by default.
- **Multi‑user aggregates** — Obsidian has no concept of "all users of my help‑desk agent struggle with X." Cairn's §10.0 produces exactly that, anonymized.
- **Per‑record ACL** — Obsidian ACLs at folder level via file system; Cairn enforces `rebac` + `access_manifest` per record, crossing the visibility tier with who‑can‑see.
- **Forget‑me at the population level** — Obsidian can delete one user's vault; Cairn deletes a user's contribution across team/org aggregates with a single pass (because every record has per‑user salt and provenance).
- **Federated semantic search** — Obsidian search is local or cloud‑indexed‑at‑cost; Cairn's sandbox federates queries to the hub and transparently stamps `semantic_degraded=true` on fallback — the agent always knows whether the result set is complete.

### What stays local always

- The **raw sources** for any user remain on that user's machine unless they explicitly promote via `PropagationWorkflow`.
- The **screen / clipboard / terminal sensor output** never leaves the originating machine unless the user enables `visibility: team` for the specific sensor.
- The **consent log** is append‑only and **never** propagates — audit stays where the action happened.

### How a team actually onboards

1. Ops provisions a Cairn `full` hub (one Nexus `full` profile instance).
2. Each user `cairn init --federate-to <hub>` on their laptop — gets a local sandbox federated to the hub.
3. Everyone works locally; team‑tier records propagate on explicit consent; aggregate views surface through `agent_*` verbs.
4. No "Obsidian Sync vs. git vs. Syncthing" debate. One hub, one protocol, one visibility model.

Cairn is local‑*first* but distributed‑*ready* — scaling from laptop to organization is a config change, not a rewrite.

---

## 13. UI / UX

### 13.1 Three skins, one vault format

| Skin | Stack | When |
|------|-------|------|
| **Headless / CLI** | Bun + Ink TUI | servers, CI, SSH, air‑gap |
| **Desktop GUI** (optional) | **Electron shell + Rust core (sidecar) + React + Vite + shadcn/ui + Tailwind + Zustand + TipTap + sigma.js + graphology + Louvain** | laptop, per‑user browsing |
| **Embedded** | no UI, library only | inside another harness |

### 13.2 Why Electron + Rust + TipTap (primary desktop stack)

- **Rust core** owns everything hot‑path: `MemoryStore` I/O, embedding, ANN, squash, hot‑memory assembly, and the `WorkflowOrchestrator` (tokio + SQLite default; Temporal adapter optional in v0.2+). Ships as a single static binary that Electron spawns as a sidecar. Exposes MCP over stdio to the renderer.
- **Electron shell** gives a consistent Chromium runtime across macOS / Windows / Linux — rendering parity matters for the graph view and the editor, and the same webview is already the target of every reference editor (Obsidian, VS Code, Notion, Linear). No surprise WebKit / WebView2 divergence.
- **TipTap (ProseMirror)** for memory editing — wikilink autocomplete, slash commands, inline frontmatter, collaborative‑ready even though Cairn is single‑user by default. Markdown in / markdown out through TipTap's markdown extensions.
- **IPC boundary** is MCP. The Rust core speaks the same eight core verbs (plus declared extensions) to the Electron renderer as it does to any external harness. One transport, one schema. The GUI is not a special client.
- **Bundle shape.** Rust core ~15–25 MB static binary; Electron + renderer ~140 MB. Cost is accepted in exchange for runtime consistency and ecosystem fit.

An **alternative slim skin** stays available for users who want a small download or air‑gap with minimal surface: Tauri 2 shell over the same Rust core, swap TipTap for Milkdown. Same vault, same MCP. Decision recorded in `.cairn/config.yaml` under `ui.shell = electron | tauri`.

### 13.3 Commands (thin wrappers over MCP)

```
cairn init                       scaffold vault + config
cairn bootstrap                  20‑min first‑session interview → purpose.md + seed memories
cairn ingest <file|url|-->       ingest a source
cairn search <query>             search
cairn retrieve <id>              retrieve
cairn summarize <query>          summarize (optional --persist)
cairn assemble-hot               print the hot prefix
cairn trace <file>               capture a trajectory
cairn lint                       health check; writes .cairn/lint-report.md
cairn standup                    pretty print of assemble-hot + recent log entries
cairn mcp                        stdio MCP server
cairn serve                      HTTP + SSE server
cairn ui                         open desktop GUI (Electron by default; Tauri when configured)
cairn sensor <name> enable       interactive consent prompt
cairn export                     tar of the vault
cairn import --from <provider>   one‑shot migration: chatgpt | claude-memory | notion | obsidian
cairn snapshot                   weekly archive into .cairn/snapshots/YYYY-MM-DD/ (git‑independent)
```

### 13.4 Desktop GUI — what ships in the Electron shell

- Vault browser (tree + tabs), wikilink autocomplete, backlink panel.
- Graph view (sigma.js + Louvain community detection) — hubs, orphans, clusters.
- Inline **TipTap** editor for memory bodies — markdown serialization, slash commands, frontmatter panel, diff view.
- Dream / Lint / Eval report viewer.
- Sensor toggle panel + consent log viewer.
- Deployment tier switcher.

### 13.5 Language split — where Rust vs. where TypeScript

| Concern | Language | Reason |
|---------|----------|--------|
| MemoryStore client (calls into Nexus sandbox sidecar over HTTP / MCP) | Rust | hot path; connection pooling; retry; circuit breaker. The store **itself** lives in the Nexus sidecar (Python) |
| Squash, rank, scope resolve, classify | Rust | pure functions over bytes; benefits from no runtime |
| Durable job runner (default) | Rust | `tokio` + SQLite‑backed job table; crash‑safe; single binary, no external service |
| Temporal worker (optional cloud) | Rust *or* TypeScript | Rust via `temporalio-sdk` / `temporalio-client` (prerelease, on crates.io) when users accept prerelease; TS sidecar with the GA Temporal TS SDK when they don't |
| Pipeline orchestration + MCP server | Rust | single binary for the core |
| CLI (Ink TUI, slash commands, dev loop) | TypeScript / Bun | ecosystem, fast iteration, bunx distribution |
| Electron shell / renderer | TypeScript + React | Electron is Node; renderer is web |
| Hook scripts | TypeScript | same as every harness's scripting ecosystem |
| Cairn internal libs consumed by harnesses | TypeScript | L0/L1/L2 package pattern stays TS so harnesses can import in‑process |

The Rust core is **a single binary** shipped with both the CLI and the GUI; TypeScript packages on the harness side talk to it via MCP. A harness never links against the Rust core — it always crosses the MCP boundary.

### 13.5.a Obsidian (or any markdown editor) as the frontend

Cairn's vault is Obsidian‑compatible by construction — flat markdown, YAML frontmatter, `[[wikilinks]]`, graph view friendly. Users who already live in Obsidian, Logseq, VS Code, iA Writer, or plain vi can **skip Cairn's shell entirely**:

- Run Cairn **headless** — `cairn mcp` provides the memory brain; the Nexus sandbox provides storage + search.
- Point Obsidian at the vault directory — reading, browsing, and hand‑edits work natively.
- Cairn's workflows continue to maintain the vault in the background; the user sees edits propagate in Obsidian's live reload.
- The desktop GUI skins (Electron + TipTap, Tauri + Milkdown) are **optional** — included for users who want everything in one app, not required for everyone.

**What you lose by skipping the Cairn GUI and using Obsidian instead:**
- Sensor toggle UI (use `cairn sensor <name> enable` from terminal)
- Consent log viewer (inspect `.cairn/consent.log` directly or via `cairn consent log`)
- Deployment tier switcher (edit `.cairn/config.yaml`)
- Evolution diff viewer (review `.cairn/evolution/*.diff` in any diff tool)

**What you keep**: everything else — the vault itself, Obsidian's editor, graph view, plugins (Dataview, Marp, Web Clipper), and Obsidian Sync / git for file distribution. Cairn's workflows, MCP surface, and memory semantics run regardless of which editor the human uses.

**Explicit non‑competition with Obsidian.** Cairn is the memory brain; Obsidian (or any editor) is a viewport. Picking one doesn't foreclose the other — mix freely.

### 13.5.b Cairn vs. Obsidian + Claude

The closest naive alternative is "point Claude at an Obsidian vault" (the Karpathy / Defileo pattern). That's a great starting point; here's what Cairn adds on top of it:

| Obsidian + Claude gives you | Cairn adds |
|-----------------------------|------------|
| Markdown + `[[wikilinks]]` + graph view | Typed 19‑kind taxonomy + YAML frontmatter + confidence + evidence vector |
| Claude reads whole vault each turn | Hot‑memory prefix bounded to 25 KB + on‑demand semantic search via `sqlite-vec` + scope resolution |
| Manual maintenance | Durable workflows: Dream / Reflect / Consolidate / Promote / Evolve / Expire / Evaluate |
| Single user / single machine | 6‑tier visibility, consent receipts, federation, cross‑user aggregates, forget‑me at population scale |
| Obsidian Sync (paid) or git (DIY) | Typed propagation policy built in (not a full mirror) |
| No evaluation story | Golden queries + multi‑session coherence + CI regression gates |
| No self‑improvement | `EvolutionWorkflow` over skills / prompts / tool descriptions with constraint gates + held‑out adversarial datasets |
| Nothing stops prompt‑injection in recalled memory | Filter pipeline with PII redaction, prompt‑injection fence, threat regex |
| You own the maintenance | The agent owns the maintenance |

### 13.5.c Backend ↔ frontend bridge — what projects, what doesn't

Cairn's backend carries state plain markdown can't express: Nexus `version` tuples, snapshot timelines, WAL `operation_id`s, confidence bands, evidence vectors, `ConsentReceipt`s, cross‑user aggregates. A projection layer decides what surfaces in the frontend and how — without this layer, a third‑party editor (Obsidian, Logseq, VS Code) would see only the note body.

**Three projection mechanisms (all optional; pick what the frontend can render):**

| Mechanism | What it projects | Frontend renders via |
|-----------|------------------|----------------------|
| Frontmatter injection | `version`, `last_modified`, `confidence`, `evidence_vector`, `consent_tier`, `promoted_at`, `kind`, `source_hash` | Obsidian Properties panel / Dataview; VS Code YAML preview; Logseq front matter plugin |
| Sidecar files | `<note>.timeline.md` (version log + diffs), `<note>.evidence.md` (query stats, retrieval log), `<note>.consent.md` (receipt trail) | Any editor that opens markdown — generated read‑only by `cairn render` or `PostToolUse` hook |
| Companion plugin (optional) | Live confidence gauge, graph‑of‑skills view, cross‑user overlay, real‑time Dream progress, evidence sparkline | Thin Obsidian / VS Code plugin talks to `cairn daemon` over `localhost:<port>` HTTP — skipping this plugin leaves Cairn fully usable |

**What never projects to the frontend** — stays backend‑only, surfaced via CLI or plugin if needed:

- Signed `ConsentReceipt` payload + Ed25519 signature — verified server‑side; frontend sees a `consent_verified: true` boolean only
- WAL `operation_id` ULIDs + single‑writer lock state — internal
- Temporal workflow IDs — exposed via `cairn trace <id>` CLI
- Raw embedding vectors — projected as `similarity` score only
- Nexus share‑link tokens — never written into any markdown; held in keychain/secret store

**Sync direction (backend is authoritative):**

- Backend → frontend: Cairn writes frontmatter and sidecar files on every `Apply`. File‑watcher daemon keeps them fresh when workflows mutate state out‑of‑band (Dream pass, Promotion, Evolution).
- Frontend → backend: editor saves to `.md` → file‑watcher sensor reads frontmatter `version` → Cairn runs optimistic version check **plus** field‑level mutability rules (below) **plus** the signed‑intent envelope (§8.0.b) → accept + bump version, or reject + write conflict marker + surface in next `lint`.
- Never in‑place mutation of Nexus state from the frontend; all edits funnel through the write path (§5.2) so ACL, filter, and consent gates fire. A frontend adapter that tries to bypass this path fails the conformance tests (below) and is refused at load.

**Field‑level mutability — backend enforces, not the frontend:**

Frontend edits can only mutate user‑content fields. Policy‑sensitive fields are **read‑only from any frontend**; attempts to change them are silently reset to the backend value and flagged in `lint`.

| Field class | Example fields | Frontend can change? |
|-------------|----------------|-----------------------|
| User content | body, `tags`, wikilinks | yes |
| Metadata (informational) | `last_read_at`, local sort key | yes |
| Classification | `kind`, `confidence`, `evidence_vector` | no — recomputed by Classifier / Ranker |
| Identity / provenance | `actor_chain`, `signature`, `key_version`, `operation_id` | no — backend‑only, any change rejects the whole edit |
| Visibility / consent | `consent_tier`, `consent_receipt_ref`, `visibility`, `share_grants` | no — changes must come through the `promote` or `forget` verbs with a fresh signed `ConsentReceipt` |
| Version / audit | `version`, `promoted_at`, `produced_by` | no — backend owned |

**Adapters are untrusted.** The `FrontendAdapter` trait deliberately does not sign edits — plugins are library code running alongside untrusted editors (Obsidian community plugin, VS Code extension). The authoritative check happens on the backend when the reconcile call arrives: signed‑intent envelope present? signer holds the required capability? target_hash matches the server's current state? field diff stays within mutable columns? Anything less than all four → reject.

**Signed‑intent minting flow for file‑originated edits.** Raw markdown editors (vim, nano, plain VS Code without plugin, Obsidian with no companion plugin) cannot produce signatures themselves. The `cairn daemon` process — which runs on the same machine as the editor under the same OS user and holds the user's identity keypair in the platform keychain — mints the intent on the editor's behalf, **but only when a user‑presence claim is also present**. This defends against same‑user local compromise: a malicious process running as the logged‑in user can write to the vault directory, but cannot satisfy the user‑presence gate without stealing an authenticated session token.

**User‑presence claim (mandatory; never auto‑granted to a file write).** Before the daemon mints a file‑originated intent, the editor session must hold a fresh **EditorSessionToken** — short‑lived (default 8 h idle, 24 h absolute), bound to a specific editor process (PID + start time + editor binary path) and to a specific vault root. Tokens are granted only through one of:

1. `cairn editor login` — interactive CLI prompt that requires the user to approve via keychain biometric / OS secure prompt; returns a token scoped to the current shell + vault.
2. A connected companion plugin whose trust root is a **signed plugin manifest**, not a single user approval. On install, the daemon fetches the manifest (`plugin.cairn.yaml`) and verifies:
   - `publisher_identity` signed by a publisher key registered on the Cairn plugin index (or, for self‑hosted deployments, an operator‑approved root).
   - `binary_hash` (sha256 over every plugin file) matches the installed binary.
   - `capabilities_requested` is a strict subset of what this user's policy allows.
   - `manifest_signature` verifies over the full YAML. Any field change (including capabilities) requires **re‑attestation** — the user is prompted again whenever the publisher pushes a new manifest or the binary hash changes.
   At runtime, the plugin signs each handshake challenge with its manifest‑bound key. `binary_hash` verification uses an **attestation‑epoch model**, not a per‑handshake recompute — but every handshake still verifies against the current epoch, closing the TOCTOU window:
   - Each plugin session carries an **attestation epoch** — a monotonic counter that increments on every verified attestation. The current epoch + expected `binary_hash` are held in memory and sealed behind a short‑lived file‑descriptor to the plugin binary, opened at attestation time and used for every subsequent read to defeat rename/swap attacks.
   - On platforms that support it (Linux ≥ 5.4 with fs‑verity, macOS App Store binaries with code signatures, Windows Authenticode), Cairn verifies the platform attestation first — filesystem‑level integrity is the strongest bind. Where fs‑verity is not available, the epoch is bound to `(device, inode, mtime, size, sha256)` so a replace via different mount / namespace / bind‑mount breaks the inode match and the epoch is invalidated.
   - **Active re‑measurement on every handshake.** Even with the sealed fd, the daemon re‑stats the plugin file on every handshake (microsecond cost) and compares `(device, inode, mtime, size)` against the epoch's bound tuple. Any mismatch → suspend minting, force re‑attestation. Full `binary_hash` recompute runs on every watcher event plus a periodic tick (default 60 s) — a defense‑in‑depth second layer for environments where the watcher is unreliable (containers without `fanotify`, network filesystems, etc.).
   - Every handshake must present the current epoch; a handshake that presents a stale epoch is rejected. This binds each handshake to a specific, still‑verified plugin binary without recomputing the hash per request.
   - The daemon establishes an OS file‑watcher (`fsevents` on macOS, `inotify` on Linux, `ReadDirectoryChangesW` on Windows) on the plugin binary. Any `modify / rename / replace` / watcher‑overflow / missed‑event signal → **immediate suspension of intent minting for that plugin**, the epoch is invalidated, and pending requests queued on the plugin return `PluginSuspended`. Re‑attestation must complete before minting resumes.
   - **Fail‑closed on watcher uncertainty.** Watcher overflows, missed events, or watcher restart are treated the same as detected changes: revoke the epoch, force re‑attestation. We would rather disrupt a plugin session than mint intents on a plugin whose integrity we can't currently assert.
   - **Atomic upgrade protocol.** When a manifest or binary is updated, the daemon enters `UPGRADING` state: the old epoch is frozen (continues serving reads from already‑queued requests up to `upgrade_grace`, default 5 s, **but mints no new intents**), the new binary + manifest + binary_hash are verified, the user is re‑prompted if capabilities changed, and on approval a new epoch replaces the old. On rejection, the old epoch is revoked and the new binary is quarantined. At no point does the daemon mint an intent under a stale or unverified epoch.
   Per‑plugin intent minting is audit‑logged to `consent.log`; operators can run `cairn plugin revoke <id>` for immediate revocation.
3. The Cairn desktop GUI which runs inside its own trust boundary — tokens minted there carry a `gui_trusted: true` claim and can only mint intents for edits that originated through the GUI's own event bus, not from arbitrary filesystem writes.

A file write on its own — even from the correct OS user — **never** produces a valid intent. The file‑watcher pairs every detected edit with the active EditorSessionToken from the associated editor process (looked up by filesystem lock / VS Code integration channel / Obsidian IPC). If no token is attached, the edit is **quarantined by default** (below); the user must either attach a session (via `cairn editor attach <pid>`) or discard the edit.

With that precondition:

```
  editor saves file.md  ───►  file‑watcher sensor (part of daemon, §9.1)
                                  │
                                  ▼
                         read file_hash = sha256(new content)
                         read fs_metadata = (inode, mtime, ctime, os_uid, fs_path)
                         read prior_version = frontmatter.version (if present)
                                  │
                                  ▼
                         DaemonIntentMinter                          ◄── policy: os_uid
                         — issues SignedIntent{                          must match the
                             operation_id: ULID                          logged‑in user;
                             target_hash: hash(target_id, file_hash),    fs_path must live
                             scope: { tenant, workspace, record_id },    under the vault
                             bound_to: { file_hash, fs_path, os_uid },   root.
                             expires_at: now + 60s,                      Failing any check
                             signature: ed25519 over all fields          → quarantine
                           }                                              (below).
                                  │
                                  ▼
                         reconcile(ctx=IdentityContext{
                             principal = human bound to os_uid,
                             signed_intent = <the minted intent>,
                             ...
                         }, edit=field_diff)
```

The minted intent is **short‑lived** (60 s default), **single‑use** (consumed by the replay ledger §4.2 on apply), and **bound** to the exact file hash the editor produced — a process that tampers with the file between save and reconcile invalidates the intent because `target_hash` changes.

**Quarantine for unsigned or invalid file‑originated edits.** If the file‑watcher sees a `.md` mutation but cannot mint a valid intent (wrong OS user, file outside vault, daemon not running, keychain locked), it **does not apply the edit**. Instead:

1. The edit is copied into `.cairn/quarantine/<timestamp>-<record_id>.md` with a sibling `.rejected` file explaining why.
2. The original vault file is rolled back to the last backend‑known content (via the most recent snapshot from §5.6).
3. The next `lint` report surfaces the quarantine; the user resolves via `cairn quarantine accept <id>` (which *does* require an interactive `cairn identity approve` fresh signature) or `cairn quarantine discard <id>`.

**Conformance tests (every FrontendAdapter must pass):**

1. Reject edits that mutate immutable fields (§13.5.c table) — even through the daemon‑minted flow.
2. Reject reused `operation_id` / `nonce` within TTL.
3. Reject edits whose `file_hash` no longer matches at apply time (tamper‑in‑flight).
4. Quarantine and roll back edits from an OS user the daemon does not recognize.
5. Honor optimistic version check — on mismatch, produce a conflict marker without touching backend state.

Adapters that fail any of these cannot be registered.

**Feature‑parity matrix (what each frontend can show):**

| Backend feature | Obsidian (default) | Obsidian + plugin | Cairn desktop GUI | Raw `vim` / VS Code |
|-----------------|---------------------|---------------------|---------------------|----------------------|
| Note body + wikilinks | yes | yes | yes | yes |
| Kind / confidence / tier (frontmatter) | yes (Properties) | yes | yes | yes |
| Version number | yes (Properties) | yes | yes | yes |
| Version timeline with diffs | via `.timeline.md` sidecar | inline gutter | inline panel | via sidecar |
| Evidence vector | via `.evidence.md` sidecar | inline sparkline | inline gauge | via sidecar |
| Graph of Skills (dependency DAG) | graph view (partial) | full interactive | full interactive | no |
| Cross‑user aggregate overlay | no | yes | yes | no |
| Live Dream progress | no | yes (WebSocket) | yes | no |
| ConsentReceipt verification badge | no | yes | yes | no |
| `cairn recall` inline | no | yes (palette command) | yes (command bar) | via CLI |

**Projection policy is configurable.** `.cairn/config.yaml` has a `projection` block controlling what lands in frontmatter vs. sidecar vs. plugin‑only — tight projection for minimal editors, rich projection for full‑featured ones. Keeps the `.md` files readable in any tool while giving power users the full backend surface when they install the plugin.

### 13.5.d `FrontendAdapter` contract — one interface, many frontends

The three projection mechanisms (frontmatter / sidecar / plugin) are building blocks. The thing that decides which to use for a given frontend is a `FrontendAdapter` plugin — same interface‑programming pattern as the `MemoryStore` / `LLMProvider` / `WorkflowOrchestrator` contracts (§4, §4.1). Cairn core doesn't know or care which frontend is running; it calls the adapter's methods.

**Contract shape (Rust trait; TS mirror auto‑generated from the same IDL as §13.5):**

```rust
pub trait FrontendAdapter: Send + Sync {
    /// Declare what this frontend can render — drives the projection policy.
    fn capabilities(&self) -> FrontendCapabilities;

    /// Project backend state into whatever the frontend consumes
    /// (markdown file + frontmatter, sidecar files, WebSocket frames, ...).
    fn project(&self, id: &MemoryId, state: &BackendState) -> Result<Projection>;

    /// Reverse direction — translate a frontend edit into a reconcile request.
    /// The adapter is UNTRUSTED library code; it cannot apply the edit directly.
    /// It must produce a `ReconcileRequest` carrying the caller's `IdentityContext`
    /// + signed intent envelope (§8.0.b); the backend then re-verifies, applies
    /// field-level mutability rules (§13.5.c), runs optimistic version check,
    /// and either commits or returns one of the typed rejection reasons below.
    fn reconcile(
        &self,
        ctx: IdentityContext,          // who is asking (tenant, principal, agent)
        edit: FrontendEdit,            // raw diff observed on disk / from plugin
    ) -> Result<ReconcileRequest, AdapterError>;

    /// Optional live channel for frontends that support it (plugin, desktop GUI).
    fn subscribe(&self, events: EventStream) -> Option<Subscription> { None }

    /// Optional teardown hook for graceful shutdown.
    fn shutdown(&self) {}
}

pub struct FrontendCapabilities {
    pub frontmatter: bool,
    pub sidecar_files: bool,
    pub live_plugin: bool,
    pub graph_view: bool,
    pub max_frontmatter_fields: usize,
}

pub struct IdentityContext {
    pub tenant: TenantId,
    pub principal: HumanIdentity,      // resolved by IdentityProvider plugin
    pub agent: Option<AgentIdentity>,  // present if the edit originated in an agent tool
    pub signed_intent: SignedIntent,   // §8.0.b envelope: operation_id, nonce,
                                       //  target_hash, scope, expires_at, signature
}

pub struct ReconcileRequest {
    pub target_id: MemoryId,
    pub expected_version: u64,         // optimistic version (mismatch → Conflict)
    pub field_diff: FieldDiff,         // only mutable columns per §13.5.c table;
                                       //  policy-sensitive diffs rejected before
                                       //  they reach the MemoryStore
    pub ctx: IdentityContext,
}

pub enum ReconcileError {
    Conflict { current_version: u64 },
    UnsignedIntent,
    ExpiredIntent,
    ReplayDetected,
    PolicyDenied { gate: String, reason: String },
    ImmutableFieldChanged { field: String },
    InsufficientCapability { required: Capability },
}
```

**Built‑in adapters (each ships as its own L2 package; install only what you use):**

| Adapter | Use case | Mechanisms it uses |
|---------|----------|---------------------|
| `@cairn/frontend-obsidian` | Obsidian vault | frontmatter + sidecar; live plugin if installed |
| `@cairn/frontend-vscode` | VS Code markdown editor | frontmatter + sidecar; extension optional |
| `@cairn/frontend-logseq` | Logseq daily notes / outlining | frontmatter + block IDs; outline‑aware sidecar |
| `@cairn/frontend-raw` | Plain markdown (vim, emacs, nano) | frontmatter only; CLI for everything else |
| `@cairn/frontend-cairn-desktop` | Cairn's own Electron GUI | internal event bus; no sidecar files |
| `@cairn/frontend-headless` | Servers / CI / MCP‑only callers | no projection; MCP surface only |

**Why this is the right shape:**

- **New frontend = new adapter, zero core changes.** Someone wants Typora support? Write `@cairn/frontend-typora`, publish, install. Nothing inside `cairn-core` moves.
- **Capability‑driven projection.** Adapter declares what it can render; Cairn's projection policy reads `capabilities()` and picks the richest subset. A minimal editor gets frontmatter; a full plugin gets live events.
- **Contract parity with the rest of the kernel.** `FrontendAdapter` sits next to `MemoryStore`, `LLMProvider`, `WorkflowOrchestrator`, `SensorIngress`, `MCPServer` as a first‑class contract. Same registration, same capability tiering (§4.1), same fail‑closed default.
- **Multiple adapters can run at once.** User runs `@cairn/frontend-obsidian` on their laptop and `@cairn/frontend-vscode` on their work machine against the same backend. Cairn fans projections to every registered adapter.
- **Testable in isolation.** Each adapter has its own test suite; core ships a conformance harness (same pattern as `MemoryStore` conformance tests) — every adapter must pass the same round‑trip + conflict‑resolution cases.

This keeps Cairn headless‑by‑default and frontend‑agnostic in the strongest sense: the core doesn't import Obsidian, doesn't import Electron, doesn't import VS Code APIs. It just calls `adapter.project(...)` and trusts the adapter to know its frontend.

### 13.6 Non‑goals for UI

- Not an Obsidian clone; not a Notion clone.
- No built‑in project management.
- No AI chat window — the harness is the chat window; Cairn is the memory.

---

## 14. Privacy and Consent

- **Local‑first default.** First run writes only to disk.
- **Per‑sensor opt‑in.** Screen, clipboard, web clip, terminal — each requires explicit enable with a consent prompt.
- **Pre‑persist redaction.** PII detection and masking before a record hits disk; secrets never reach the vault.
- **Per‑user salt.** Pseudonymized keys; forget‑me is a hash‑set drop, not a scan.
- **Append‑only `consent.log`.** Every share / promote / propagate writes a line. Never edited. Never deleted.
- **Exportable.** The vault *is* the export; `cairn export` is a `tar` of markdown.
- **Deny by default.** On any policy or ReBAC check failure — deny.
- **Propagation requires user assent.** Agents can *request* promotion; only users *grant* it.

---

## 15. Evaluation

Every new contract, new taxonomy, new workflow, or new adapter ships with an evaluation.

- **Golden queries.** A small curated query set returns deterministic expected memories / rankings.
- **Multi‑session coherence.** Long‑horizon tests spanning 5 / 10 / 50 sessions verify recall, conflict resolution, staleness handling.
- **Orphan / conflict / staleness metrics.** Surfaced by `EvaluationWorkflow`; regressions fail CI.
- **Latency SLO.** p95 turn latency with hot‑assembly + write < 50 ms; p99 < 100 ms.
- **Privacy SLOs (two‑phase, per §5.6 delete):**
  - **Reader‑invisible latency:** a 1 M‑record `forget-me` call returns with Phase A committed (tombstones + reader_fence closed) in **< 1 s p95**. After this point `search` / `retrieve` can never surface the targeted records.
  - **Physical purge completion:** the async Phase B children complete (embeddings zeroed, index regions purged) in **< 30 s p95** for 1 M records. `PURGE_PENDING` flagged in `lint` with operator alert if a child exhausts retries — readers are still shielded by the fence, but compliance requires attention.
- **Replay.** Cassette‑based replay of real harness turns — no LLM, no network — validates every middleware, hook, and workflow.

---

## 16. Distribution and Packaging

- `bunx cairn` — zero‑install ephemeral CLI; bundled with the Rust core binary for the host platform.
- `npm i -g cairn` — global CLI install.
- **DMG / MSI / AppImage / deb** for the Electron desktop shell; a slim Tauri build is available for air‑gap / bandwidth‑constrained users.
- `cairn mcp` — stdio MCP server (Rust core) that any harness registers in its MCP config.
- Koi integrates via a thin L2 package that bridges the harness's internal middleware to Cairn MCP.

**Monorepo shape (polyglot: Rust core + TypeScript shell + Electron renderer).** Everything outside `cairn-core` is a plugin using the registration path from §4.1 — no internal shortcuts. Third‑party plugins live in their own repos and are listed in `.cairn/config.yaml` exactly like the bundled ones.


```
cairn/
├── crates/
│   ├── cairn-core             Rust — L0 types, pure functions, MCP server
│   ├── cairn-jobs             Rust — default orchestrator (`tokio` + SQLite job table)
│   ├── cairn-jobs-temporal    Rust — optional Temporal adapter via `temporalio-sdk` / `temporalio-client` (prerelease)
│   ├── cairn-store-nexus      Rust — MemoryStore HTTP/MCP client into a Nexus `sandbox` sidecar (default)
│   ├── cairn-nexus-supervisor Rust — spawns + health‑checks + restarts the Python Nexus sidecar
│   ├── cairn-llm-openai       Rust — OpenAI‑compatible LLMProvider
│   ├── cairn-sensors-local    Rust — hook, IDE, terminal, clipboard, screen, neuroskill
│   └── cairn-sensors-source   Rust — Slack, email, calendar, GitHub, document, transcript, web, RSS
├── packages/                  TypeScript — harness‑facing + CLI + optional Temporal bridge
│   ├── cairn-core             L0 — TS types mirroring the Rust core types
│   ├── cairn-mcp-client       L1 — stdio client talking to the Rust MCP server
│   ├── cairn-temporal-worker  L2 — optional Temporal TS worker sidecar (safe path until the Rust SDK goes GA)
│   ├── cairn-koi-bridge       L2 — thin adapter exposing Cairn to Koi's middleware
│   ├── cairn-cli              L2 — Ink TUI + slash commands
│   ├── cairn-hooks            L2 — harness hook scripts (CC / Codex / Gemini)
│   └── cairn                  L3 — meta‑package; one install, sensible defaults
├── apps/
│   ├── desktop-electron       Electron + React + TipTap + sigma.js — primary GUI
│   ├── desktop-tauri          Tauri + React + Milkdown — slim GUI alternative
│   └── docs                   public docs site
```

---

## 16.a Replacing Existing Memory Systems

Cairn can slot into four widely‑used agent stacks — each with a concrete import path and a runtime bridge. The import is one command; the bridge is Cairn registered as an MCP server on the host.

### OpenClaw (`openclaw/openclaw`)

The closest existing reference implementation. Memory lives in `extensions/memory-core` + `packages/memory-host-sdk` with QMD hybrid search, three‑tier dreaming, evidence‑gated promotion, flush‑plan, and public‑artifact separation — all patterns Cairn's design already adopts.

- **Migration**: `cairn import --from openclaw` ingests `MEMORY.md` + `memory/*.md` + `SOUL.md` + indexed session transcripts; preserves concept‑vocabulary tags as kind hints.
- **Runtime**: OpenClaw's plugin SDK accepts external memory providers. Register `cairn mcp` as the provider; OpenClaw's `memory_search` / `memory_get` become thin proxies to Cairn's `search` / `retrieve`.
- **Cairn wins**: harness‑agnostic (OpenClaw owns 20+ chat channels; Cairn memory now usable from non‑OpenClaw harnesses too), 19‑kind typed taxonomy, 6‑tier visibility, `EvolutionWorkflow`, immutable `sources/`, Nexus substrate (less OpenClaw storage engine to maintain).

### Hermes Agent (`NousResearch/hermes-agent`)

Forked from OpenClaw; adds a plugin‑pickable external‑provider slot (one of `hindsight` / `mem0` / `honcho` / `byterover` / `holographic` / `openviking` / `retaindb` / `supermemory`) alongside a builtin `MEMORY.md` + `USER.md` + `SOUL.md`.

- **Migration**: `cairn import --from hermes-agent` reads `~/.hermes/memories/{MEMORY,USER}.md` + `SOUL.md` + `~/.hermes/skills/*`; entry delimiter `§` is preserved as record boundaries.
- **Runtime**: Hermes already supports exactly one external memory provider. Register `cairn mcp` as that provider; builtin can stay on as read‑through during migration, then be disabled.
- **Cairn wins**: one store instead of two (no "builtin + external" schism), typed kinds instead of free text with `§`, one durable learning loop instead of "pick a plugin", `sources/` layer preserves originals that Hermes discards after distillation.

### Rowboat (`rowboatlabs/rowboat`)

Electron app with an Obsidian‑compatible knowledge graph at `WorkDir/knowledge/`. Typed note templates (`People` / `Organizations` / `Projects`), built‑in source agents for Gmail / Calendar / Fireflies, mtime + content‑hash change detection.

- **Migration**: `cairn import --from rowboat` ingests `WorkDir/knowledge/**/*.md` preserving `[[wikilinks]]`, `agent_notes_state.json`, and note‑type metadata; People/Organizations/Projects templates land under `wiki/entities/{people,orgs,projects}/`.
- **Runtime**: Rowboat keeps its Electron UI, Gmail OAuth, Deepgram voice, and source‑sync agents; replaces its in‑process knowledge graph service with calls to `cairn mcp`. Its source‑sync agents emit `ingest` verbs instead of writing the vault directly.
- **Cairn wins**: typed 19‑kind taxonomy vs informal note types, confidence + staleness tracking, `lint` / conflict DAG / orphan detection, `EvolutionWorkflow`, 6‑tier visibility + `share_link` for team memory (Rowboat is single‑user today), Cairn vault readable by any harness — not tied to the Rowboat app.

### OpenCode (`anomalyco/opencode`)

Effect‑ts coding agent with **no persistent memory layer**. "Memory" = `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` discovered in order + session history in SQLite + a structured compaction summary (`Goal` / `Constraints` / `Progress` / `Decisions`) with `PRUNE_PROTECTED_TOOLS`.

- **Migration**: `cairn import --from opencode` reads `AGENTS.md` + `CLAUDE.md` + last N compaction summaries; seeds `purpose.md` + initial `user` / `rule` / `project` / `strategy_*` records.
- **Runtime**: OpenCode keeps its Effect runtime, session DB, compaction state machine, and `PRUNE_PROTECTED_TOOLS` intact. Register `cairn mcp` as an MCP server; OpenCode's `PreCompact` hook routes the structured summary into Cairn as typed records; `SessionStart` pulls the hot prefix from Cairn via `assemble_hot`.
- **Cairn wins**: adds the cross‑session persistent memory OpenCode lacks without disturbing the compaction flow. Skills become portable (OpenCode's `PRUNE_PROTECTED_TOOLS = ["skill"]` maps to `pinned: true` in Cairn). Structured summary template is preserved via Cairn's `project` + `rule` + `strategy_success` kinds.

### Common pattern

All four migrations share the same three steps:

1. **Import once** — `cairn import --from <system>` produces a Cairn vault with provenance links back to the source system's files.
2. **Dual‑run briefly** — both the legacy memory and Cairn stay active; reads prefer Cairn; writes fan to both. Lets you validate parity on real turns.
3. **Cut over** — legacy becomes a one‑way export target for audit; Cairn is the source of truth.

Nothing in these migrations requires the legacy system to change. Cairn runs as an MCP server — every one of these stacks already speaks MCP or has a plugin slot that does.

---

## 17. Non‑Goals (what Cairn will never be)

- Not a harness. No agent loop, no tool execution, no opinionated LLM adapter beyond `LLMProvider`.
- Not a scheduler of last resort. Cairn runs a `WorkflowOrchestrator` (the default v0.1 implementation is `tokio` + a SQLite job table, crash‑safe, single binary, zero external services); Temporal is an optional swap‑in adapter for deployments that already operate it. Durability + idempotency guarantees apply to both; see §10 for the per‑version orchestrator truth table.
- Not a vector DB. Nexus `sandbox` profile (SQLite + `sqlite-vec` + `litellm` embeddings) provides the default vector path via its `search` brick.
- Not a UI framework. The desktop GUI is optional and purposely small.
- Not an IAM engine. `MemoryVisibility` is a tag; enterprise IAM lives elsewhere.
- Not an application. No built‑in "brag doc", no "review brief", no "standup template" — those are user‑space templates that sit on top of Cairn's primitives.

---

## 18. Success Criteria

1. **Adoption.** Three independent harnesses speak Cairn MCP in v0.1; ten by v1.0.
2. **Standalone proof.** `bunx cairn` on a fresh laptop, no network, works end‑to‑end.
3. **Latency.** p95 harness turn with Cairn MCP hot‑assembly < 50 ms.
4. **Privacy.** `forget-me` on a 1M‑record vault: reader‑invisible within 1 s p95 (Phase A tombstones + fence closed), physical purge within 30 s p95 (Phase B); append‑only consent log survives GDPR review.
5. **Evaluation.** Golden queries + multi‑session coherence + orphan / conflict / staleness metrics all regression‑tested in CI.
6. **Local‑first.** Zero code changes to move from embedded → local → cloud; only `.cairn/config.yaml`.
7. **Maintenance is a command.** Weekly `cairn lint` + continuous Temporal workflows keep the vault healthy without manual cleanup.

---

## 18.a Progressive Adoption — three ways to use Cairn

Users don't have to commit to the full stack on day one. Cairn is designed to be useful at three levels of commitment, each a superset of the last.

| Level | Commitment | What you get | When |
|-------|------------|--------------|------|
| **L1 — Zero‑config in your harness** | 30 seconds | `cairn mcp` registered as an MCP server in CC / Codex / Gemini. Eight core verbs available (§8). "Tell it directly" — say *"remember that I prefer X"* in chat and Cairn captures a `user` or `feedback` memory. `cairn export` for portable memory. | you want better in‑chat memory today |
| **L2 — File‑based vault on disk** | 5 minutes | `cairn init` scaffolds the vault. `purpose.md` + `.cairn/config.yaml` + harness schema files (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) are your schema layer. `raw/` is your Memory.md / Preferences / Corrections / Patterns / Decisions — one file per record. Git gives you history and archive for free. `cairn snapshot` writes an extra weekly snapshot into `.cairn/snapshots/YYYY-MM-DD/`. | you want a persistent, portable, editable memory |
| **L3 — Second brain with continuous learning** | 1–2 hours | Add source sensors (Slack, email, GitHub, web clips). Temporal runs Dream / Reflect / Promote / Evolve on its own. Desktop GUI (Electron + TipTap + graph) for browsing. Workflow on every turn: Capture → Extract → Filter → Classify → Store → Consolidate. | you want a compounding, self‑evolving knowledge wiki |

**Same vault moves up the ladder.** Nothing you did at L1 gets thrown away when you advance; L2 imports the L1 memories, L3 starts consolidating them. Same MCP, same files, same schema.

**"Tell it directly" capture triggers** (§11.6) are how L1 works without any config:

| You say | Cairn writes |
|---------|--------------|
| "remember that I prefer X" | `user_*.md` (preference) |
| "remember: never do Y" | `rule_*.md` (invariant) |
| "correction: it's actually Z" | `feedback_*.md` (correction) |
| "this is how we did it — it worked" | `strategy_success_*.md` + candidate `playbook_*.md` |
| "forget that I mentioned W" | routes to the `forget` verb (§8.0 core verb 8) with `mode: "record"`, targeting the matching record(s). Same signed‑intent envelope (§8.0.b), same §5.6 WAL `delete` state machine, same irreversible semantics. This is the only erase path — there is no parallel "expiration marker" flow for user‑requested deletes. |

**Migration in.** `cairn import` ingests existing memory exports from ChatGPT, Claude's built‑in Memory page, Notion databases, Obsidian vaults, or plain markdown folders. Each import becomes `sources/` entries with provenance intact.

---

## 18.b Consumer Blueprint — what a team gets when they adopt Cairn

Adopting Cairn is not "read the docs and figure it out." Every consuming team receives a concrete, repeatable starter package that turns the framework into their deployment in hours, not weeks:

| Artifact | What it is | Where it lives |
|----------|------------|----------------|
| **Config template** | `.cairn/config.yaml` seeded for the team's domain — enabled kinds, sensor mix, evidence thresholds, visibility tiers, hot‑memory recipe | `templates/<domain>/config.yaml` |
| **Schema starter** | `purpose.md` + `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` skeletons with the team's objectives, constraints, vocabulary | `templates/<domain>/schema/` |
| **Integration crate** | Thin L2 package bridging the team's harness to `cairn mcp` — one file, `~100 LOC`, reviewed before use | `integrations/<harness>/` |
| **Eval suite** | Golden queries + multi‑session scenarios + domain‑specific benchmarks; run on every PR | `evals/<domain>/` |
| **Migration recipe** | Step‑by‑step: import existing memory, dual‑run, cut over (§16.a for common systems; custom recipe otherwise) | `docs/migrate-<from>.md` |
| **Runbook** | Operator guide: sensor opt‑in flow, privacy posture, consent log review, forget‑me drills | `docs/runbook-<domain>.md` |

**First four hours:**

1. `cairn init --template <domain>` — scaffolds the vault + schema + config
2. Register `cairn mcp` in the harness
3. `cairn import --from <legacy>` (if applicable)
4. Run the eval suite; verify golden queries pass against the imported data

**First month:**

- Dual‑run against legacy; validate parity
- Enable source sensors progressively
- First `DeepDream` pass; review `lint-report.md`
- Cut over to Cairn as source of truth

**Team outputs:**

- Their vault (`<team>/cairn-vault/`) — git‑backed, portable, `.nexus`‑bundle exportable
- Their eval suite — reruns in CI, catches regressions
- Their `EvolutionWorkflow` history — every skill mutation is an auditable PR‑style diff
- Aggregate insights (when `agent.enable_aggregate: true`) — anonymized view of where users struggle most

Templates ship with Cairn; the four top domains (`personal`, `engineering`, `research`, `support`) have first‑class templates, and teams fork to create their own.

## 18.c User Story Coverage — mapping to spec sections

Every user story below maps to existing Cairn sections. Where a story asked for something not yet explicit, the gap is closed in this subsection and in the referenced sections.

### P0 stories

**US1 — Store every turn in sequence (agent).**
- Turn = a first‑class record: `MemoryKind = trace`, stored under `episodic/YYYY/MM/DD/<session_id>/turn_<n>.md` with frontmatter `{session_id, turn_id, user_msg_ref, agent_msg_ref, tool_calls[]}`. `tool_calls[]` references child `trace` records so tool payloads are retrievable independently (US5).
- Ordering: `turn_id` is a monotonic int per session; `retrieve(session_id, limit: K, order: desc)` returns the last K turns in constant‑index time (SQLite primary key on `(session_id, turn_id)`).
- Latency: all `retrieve` reads hit the sandbox profile's single SQLite file — **p50 < 5 ms, p99 < 25 ms** on warm cache for K ≤ 100; the §15 Evaluation budget enforces this per release.
- Sections: §3 Vault Layout, §5.1 Read path, §6.1 MemoryKind, §8.1 Session lifecycle, §15 Evaluation.

**US2 — Reload an entire past session (agent).**
- `retrieve(session_id)` returns the full turn sequence; `raw/trace_<session_id>.md` keeps the full transcript append‑only and is never compacted.
- Durability: every write goes through §5.6 WAL + two‑phase commit; the session file plus its turn records move atomically.
- Archived sessions: after `idle > archive_after_days` (default 30), `ExpirationWorkflow` migrates cold turns into a Nexus `snapshot` bundle (`cold/session_<id>.tgz`); metadata (title, summary, turn count, actors, ConsentReceipts) stays in the primary SQLite index so `search` still finds the session. `retrieve(session_id, rehydrate: true)` transparently unpacks the cold bundle. **Rehydration latency budget: p95 ≤ 3 s** for sessions ≤ 10 MB; enforced in §15.
- Sections: §3 Vault Layout, §5.6 WAL, §10 Workflows (Expiration), §8.1 Session lifecycle.

**US3 — Remember user memories (agent).**
- `MemoryKind = user | feedback`; §7.1 `AutoUserProfile` aggregates them into a synthesized profile loaded by `assemble_hot` every turn.
- Cross‑session persistence: records live under `entities/users/<user_id>/` — not scoped to a session, so they survive indefinitely.
- Scope filter: §4.2 `AgentIdentity` + `HumanIdentity` give a `(user_id, agent_id)` key on every record; `retrieve(scope: { user: "...", agent: "..." })` filters to that pair.
- Sections: §6.1, §4.2, §7.1, §6.3 Visibility tiers.

### P1 stories

**US4 — Rolling summaries of long threads (agent).**
- `ConsolidationWorkflow` (§10) runs the rolling summary pass on a cadence declared in `.cairn/config.yaml`:
  ```yaml
  consolidation:
    rolling_summary:
      every_n_turns: 10      # cadence — configurable per agent
      window_size_turns: 50  # how much history each summary covers
      emit_kind: reasoning   # what kind the summary becomes
      fields: [entities, intent, outcome]
  ```
  Triggered on every `PostToolUse`/`Stop` hook that crosses the `every_n_turns` boundary. Default 10 turns matches the story's acceptance criterion.
- Each summary is a `reasoning` record with `entities_extracted[]`, `user_intent`, `outcome_status`, back‑links to the source turns.
- `assemble_hot` picks the latest summary plus the last K raw turns — loads key context without reading hundreds of turns.
- Sections: §10 Workflows (Consolidation), §7 Hot Memory, §6.1 MemoryKind.

**US5 — Store tool calls and results with turns (agent).**
- Each tool call and each tool result is its own `trace` record linked to the parent turn via `parent_turn_id`. The Hook sensor (§9.1) emits one event per `PostToolUse`; `Extract` stage turns it into a child `trace` record with `{name, args, result, duration_ms, exit_code}`.
- Retrievable independently: `retrieve(turn_id, include: ["tool_calls"])` or `search(kind: "trace", tool: "<name>")`.
- Sections: §6.1 MemoryKind (`trace`), §9.1 Sensors (Hook sensor, Neuroskill sensor), §5.2 Write path.

### P2 stories

**US6 — Automatically archive inactive sessions (SRE).**
- `ExpirationWorkflow` transitions records through tiers: **hot** (active sessions, SQLite primary) → **warm** (idle 7+ days, still in SQLite but evicted from LRU) → **cold** (idle 30+ days, moved into Nexus `snapshot` bundles on object storage).
- Metadata stays hot: session title, summary, actor chain, turn count, ConsentReceipts, search‑index terms — all remain in the primary index so `search` hits a cold session at the same latency as a warm one.
- Hydration: `retrieve(session_id)` on a cold session triggers `rehydrate` which unpacks the snapshot and restores to warm for the next hour. **Budget ≤ 3 s p95 for ≤ 10 MB sessions** (§15 regression gate).
- SRE observability: §15 includes per‑tier latency histograms, archive/hydration counts, and storage‑cost metrics exported via OpenTelemetry.
- Sections: §3.0 Storage topology, §10 Workflows (Expiration), §15 Evaluation.

### P3 stories

**US7 — Search across prior conversations and memories (SRE + Developer).**
- MCP `search` verb (§8) supports both keyword (BM25S via Nexus `search` brick) and semantic (`sqlite-vec` ANN via `litellm` embeddings) — mode selected by `search(mode: "keyword" | "semantic" | "hybrid")`.
- Results: every hit returns `{record_id, snippet, timestamp, session_id, score, actor_chain}` so SRE audits and developer reuse both have full provenance.
- RBAC: `rebac` brick (§4.2) enforces tenant + role + visibility at query time; results the caller can't read are dropped at the MemoryStore layer, never surfaced. Caller sees the filter count (`results_hidden: N`) without seeing the hidden records themselves.
- Sections: §8 MCP Surface, §5.1 Read path, §4.2 Identity + rebac, §6.3 Visibility.

**US8 — Delete a specific session and memories (Customer + SRE).**
- **Record‑level delete ships in v0.1.** `cairn forget --record <id>` — or the MCP verb `forget` with `mode: "record"` — runs the full §5.6 `delete` Phase A (logical tombstone + index drains committed atomically) plus Phase B physical purge. Irretrievable: `search` and `retrieve` return `not_found` as soon as Phase A commits.
- **Session‑level delete ships in v0.2.** `cairn forget --session <id>` (MCP `forget` with `mode: "session"`) is advertised only by v0.2+ runtimes via `handshake.capabilities` (see §8 verb 8 row). v0.1 clients receive `CapabilityUnavailable` if they attempt a session mode. Session delete adds the chunked fan‑out, `reader_fence` closure in the last chunk's transaction, and exclusive session lock (§5.6 delete row + lock compatibility matrix).
- Immutable audit (both modes): every delete writes an entry to the `consent_journal` table inside `.cairn/cairn.db` atomically with the state change; the `consent_log_materializer` then appends it to `.cairn/consent.log` asynchronously. The deletion itself is auditable forever; the *content* deleted is unrecoverable after Phase B purge.
- Record vs. session delete semantics are identical per child; the only difference is the transaction boundary (one record vs. a chunked fan‑out under exclusive session lock).
- Sections: §14 Privacy and Consent, §10 Workflows (forget‑me fan‑out), §5.6 WAL.

### Personas — explicit coverage

| Persona | Primary goal | Cairn surface that serves it |
|---------|--------------|--------------------------------|
| **Agent (Service Account)** | fast R/W for chat context | MCP verbs (§8), sub‑5 ms retrieve from local SQLite, hot‑memory prefix always < 25 KB (§7) |
| **SRE (Maintainer)** | observability, archival, compliance | `/health`, OpenTelemetry metrics per workflow (§15), tier‑migration + hydration dashboards, `consent.log` audit, forget‑me workflow, `cairn lint` CI gate |
| **Agent Developer** | APIs for entity memory, search, summaries | Five contracts (§4), plugin architecture (§4.1), conformance tests, CLI + SDK bindings (§13), golden‑query regression harness (§15) |

### Coverage summary

| Story | Priority | Covered | Sections |
|-------|----------|---------|----------|
| US1 turn sequence | P0 | v0.1 | §3, §5.1, §6.1, §8.1, §15 |
| US2 session reload | P0 | v0.1 active / v0.2 cold rehydrate | §3, §5.6 (`upsert`), §10, §8.1 |
| US3 user memories | P0 | v0.1 | §4.2, §6.1, §7.1, §6.3 |
| US4 rolling summaries | P1 | v0.1 (rolling path); full in v0.2 | §10, §7, §6.1 |
| US5 tool calls with turns | P1 | v0.1 | §6.1, §9.1, §5.2 |
| US6 archive inactive sessions | P2 | v0.2 | §3.0, §10, §15 |
| US7 search | P3 | v0.1 (keyword+semantic+hybrid); v0.2 cross‑tenant federation | §8, §5.1, §4.2, §6.3 |
| US8 session delete | P3 | v0.1 `forget_record` / v0.2 `forget_session` | §14, §10, §5.6 |

**Coverage vs. sequencing (§19) — single source of truth:** The capability matrix below drives both this section and §19; a CI lint fails the build if §8, §18.c, and §19 disagree on what ships when.

| Capability | v0.1 ships | v0.2 ships |
|------------|------------|-------------|
| Core MCP verbs 1–8 (`ingest`/`search`/`retrieve`/`summarize`/`assemble_hot`/`capture_trace`/`lint`/`forget`) | yes — all 8 | unchanged |
| `search` modes | keyword + semantic + hybrid | adds cross‑tenant federation queries |
| Session reload | active‑session (US2 core) | + cold‑storage rehydration (US6) |
| `forget` modes | `record` (US8 core) | + `session` fan‑out with drain fences |
| `ConsolidationWorkflow` | rolling‑summary pass only (US4 core) | + Reflection/REM/Deep tiers |
| SRE observability (OTel dashboards, tier‑migration metrics, rehydration gates) | basic lint + health | full SRE surface |
| Extension namespaces | none required for P0/P1 | `cairn.aggregate.v1` |

**Therefore:** P0 (US1–US3), US4 rolling‑summary, US5, US7 basic search, and US8 record‑level forget all land in v0.1. US6 cold‑rehydration, US8 session fan‑out, and the full reflection/evolution surface land in v0.2.

## 19. Sequencing

**v0.1 — Minimum substrate.** Covers US1, US2 active‑session reload, US3, US4 rolling‑summary path, US5, US7 basic search, and US8 record‑level delete (see §18.c capability matrix for the authoritative mapping).
Headless only. Nexus local backend. Eight core MCP verbs (`ingest`, `search`, `retrieve`, `summarize`, `assemble_hot`, `capture_trace`, `lint`, `forget`) with the full §8.0.b envelope; `forget` advertises `mode: "record"` capability only. `DreamWorkflow` + `ExpirationWorkflow` + `EvaluationWorkflow` + `ConsolidationWorkflow` (rolling‑summary path only). §5.6 WAL with `upsert`, `forget_record`, and `expire` state machines. Five hooks. Vault on disk. `cairn bootstrap`.

**Reference consumer for v0.1: Claude Code.** Chosen because (a) it is the first harness with a stable hook surface in shipping form, (b) Cairn's five hooks map 1:1 to CC's native events, (c) the primary maintainer already uses CC daily so dogfood signal is immediate, and (d) the CC MCP registration format is a documented reference every other harness (Codex, Gemini) can adapt. Codex integration ships in v0.2 as the second consumer.

v0.1 acceptance ⇒ all §18.c P0 + P1 stories pass their golden‑query suites against Claude Code, and the CI wire‑compat matrix confirms `cairn.mcp.v1` verb set + declared capabilities match the runtime.

**v0.2 — Continuous learning + SRE surface.** Covers US6, US7, US8 session‑wide delete, and full US4 reflection layer.
Add `ReflectionWorkflow`, `SkillEmitter`, full `ConsolidationWorkflow` (Dream/REM/Deep tiers). §5.6 WAL gains `forget_session` (with drain fences) and `promote` state machines. SRE observability: OpenTelemetry + tier‑migration dashboards + rehydration latency gates (§15). Second consumer wired. Tauri GUI alpha.

**v0.3 — Propagation + collective.**
Add `PromotionWorkflow`, `PropagationWorkflow`, consent‑gated team/org share, `cairn.federation.v1` extension. Full sensor suite. `evolve` WAL state machine with canary rollout.

**v0.4 — Evaluation and polish.**
Multi‑session coherence benchmarks. Replay cassettes. Documentation freeze. Beta distribution channels.

**v1.0 — Production.**
SLAs hit. Three harnesses shipped. Desktop GUI on three OSes. Semver commitment on MCP surface (`cairn.mcp.v1` frozen).

---

## 20. Open Questions

1. Governance: single‑repo vs. monorepo organization; maintainer model.
2. Default LLM for local tier: ship Ollama bootstrap, or require user install?
3. Desktop GUI: ship in v0.2 or defer to v0.3?
4. Skill distillation format: adopt an existing spec, or define Cairn‑native?
5. Propagation transport: direct `MemoryStore` write, or a thin publish/subscribe layer?
6. Screen sensor: separate opt‑in build, or always‑present‑but‑off‑by‑default toggle?

---

## Appendix — Glossary

- **Cairn** — name of this framework; a pile of stones marking a trail. Memory = trail markers for future agents.
- **Memex** — Vannevar Bush's 1945 vision of a personal curated knowledge store with associative trails.
- **Hot memory** — the always‑loaded prefix injected on every turn (bounded 200 lines / 25 KB).
- **Dream** — nightly consolidation pass (orient → gather → consolidate → prune).
- **ACE** — trajectory→playbook distillation loop; turns reasoning traces into reusable procedural skills.
- **MCP** — Model Context Protocol; the harness‑facing tool contract.
- **Nexus** — the filesystem & context plane that Cairn uses as its default backend.
- **Presidio** — PII detection / redaction used pre‑persist.
- **Temporal** — durable workflow engine for the seven background loops.
- **Lint** — health check over the vault (contradictions, orphans, staleness, data gaps).

---

*End of brief.*
