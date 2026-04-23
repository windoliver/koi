# Cairn — Standalone Harness‑Agnostic Agent Memory Framework

> **Status:** Design brief — architecture + needs (no code)
> **Date:** 2026‑04‑22

---

> *"Vannevar Bush described the Memex in 1945 — a personal curated knowledge store where the connections between documents are as valuable as the documents themselves. The part he couldn't solve was who does the maintenance."*
>
> **Cairn is that piece.** The agent does the maintenance — continuously, durably, off the request path.

---

## 0. Priority legend — how to read this doc

Every capability in Cairn is tagged P0 / P1 / P2 / P3. Readers skimming for "what do I build first" should read only P0 sections; each subsequent tier is a superset that adds power without breaking the lower tier's contract.

```
  Priority ─ ships in ─ what it means ─────────────────────── example capabilities
  ─────────────────────────────────────────────────────────────────────────────────
  [P0]  v0.1  "Ship-blocking minimum Cairn"                    8 MCP verbs · 5 hooks
                zero network · zero Python · zero services      SQLite + FTS5 + sqlite-vec
                Rust binary + SQLite + markdown + local models  candle local embeddings
                must cover US1-US5, US7 all 3 modes, US8 rec    keyword+semantic+hybrid
                every P0 path works on a fresh laptop offline   voice (sherpa-onnx)
                local sensors bundled: hooks/IDE/term/clip       screen (screenpipe subproc)
                voice / screen / recording-to-text              recording-to-text pipeline
                                                                 WAL upsert+forget

  [P1]  v0.2  "Core but deferrable"                             Nexus sandbox sidecar
                adds Python sidecar: BM25S, cloud embeddings,    richer search backends
                multi-modal parsers, vision captions             US6 cold rehydration
                US6 archive, US8 session delete, reflection      session-wide forget
                SRE observability                                ReflectionWorkflow
                                                                 Electron GUI alpha

  [P2]  v0.3  "Power + multi-user"                              federation → hub
                teams, orgs, aggregates, full sensor suite       PropagationWorkflow
                                                                 EvolutionWorkflow
                                                                 AgentDreamWorker
                                                                 AgentExtractorWorker
                                                                 canary rollout

  [P3]  v1.0  "Polish + production SLAs"                        3 harnesses shipped
                desktop GUI on 3 OSes                            MCP v1 frozen
                replay cassettes · coherence benchmarks          cross-tenant search
                                                                 semver commitment
```

**The contract surface is stable at P0.** MCP verb set, vault layout invariants, record schema, WAL state machines — all defined at P0 and never broken by higher tiers. What changes between tiers is which **backends, workers, and workflows** are active; the wire format, file format, and audit trail never change.

**Rule of thumb:** if a feature requires a **Python sidecar or a cloud credential**, it is at least P1. **P0 is pure Rust + pure SQLite + markdown + an `LLMProvider` of the operator's choice.** An `LLMProvider` at P0 can be any local model (Ollama, llama.cpp, vLLM) or any OpenAI-compatible endpoint — the operator configures it at `cairn init` time. **No LLM call leaves the laptop unless the operator configured a cloud endpoint.**

**P0 degrades cleanly when no LLM is configured** — `LLMExtractor` and `LLMDreamWorker` report `llm_unavailable` at startup; the `RegexExtractor` fallback chain still captures hook events + "tell it directly" triggers; rolling-summary `ConsolidationWorkflow` skips with a `consolidation_deferred` status in `lint-report.md`. The vault keeps accepting writes; only LLM-backed enrichment pauses. This is intentional: P0 guarantees the substrate works on a fresh offline laptop; LLM-backed extraction is an optional enrichment, not a structural dependency.

| Concept | P0 position | P1+ upgrade path |
|---------|-------------|-------------------|
| Storage | single SQLite file with built‑in FTS5 **+ `sqlite-vec` extension (statically linked) + pure‑Rust embedding runtime (`candle` with a bundled small model, downloaded on first run, ~25 MB)** | Nexus sandbox adds BM25S + richer parsers + cloud embedding providers (OpenAI / Cohere / Voyage) → Nexus full hub (Postgres + pgvector via federation) |
| Search | **all three modes available**: `mode: "keyword"` (FTS5), `mode: "semantic"` (sqlite-vec + local `candle` embeddings), `mode: "hybrid"` (local blend). No cloud, no Python, no embedding key. A deployment that opts out of the embedding model (`search.local_embeddings: false` in config) serves only `keyword` and rejects `semantic` / `hybrid` with `CapabilityUnavailable`. | Adds BM25S lexical scoring; adds cloud embedding providers via `litellm`; `semantic_degraded=true` only on transient provider outages. Adds cross-tenant federation (P2). |
| Extract | `RegexExtractor` always on (zero-LLM); `LLMExtractor` runs iff an `LLMProvider` is configured — gracefully skipped otherwise | `AgentExtractorWorker` with tool loop (P2, §5.2.a) |
| Dream | `LLMDreamWorker` runs iff an `LLMProvider` is configured; rolling summaries pause cleanly when not | `HybridDreamWorker` prune+summary (P1); `AgentDreamWorker` tool loop (P2, §10.2) |
| Identity | single‑actor `author` key — Ed25519 keypair in platform keychain | full `actor_chain` delegation + countersignatures (P2) |
| Visibility | `private` + `session` tiers only | + `project`/`team`/`org`/`public` via PropagationWorkflow (P2) |
| Orchestrator | `tokio` + SQLite job table | Temporal adapter (P1 opt‑in); DBOS / Inngest / Hatchet (P2) |
| Sensors | 5 hooks (`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Stop`) | IDE + clipboard + screen (opt‑in) + Slack/email/GitHub (P2) |
| Frontend | raw `wiki/` markdown in any editor | Obsidian / VS Code / Logseq adapters (P1); Tauri GUI (P1 alpha, P3 GA) |
| Consolidation | rolling‑summary pass only | Light Sleep / REM Sleep / Deep Dreaming (P1–P2) |
| Forget | record‑level (`forget --record`) | session‑level fan‑out + reader fence (P1) |

Throughout the rest of the doc, selected section headings carry `[P0]` / `[P1]` / `[P2]` / `[P3]` tags where the priority is non‑obvious. Unmarked sections are P0 unless context makes otherwise clear.

---

## 1. Thesis [P0]

**Cairn** is a stand‑alone, harness‑agnostic agent memory framework. It gives any agent loop — local or cloud, open‑source or proprietary — a shared substrate for per‑turn extraction, nightly consolidation, trajectory→playbook learning, hot‑memory prefix injection, typed taxonomy, consent‑gated propagation, and a privacy‑first local default. Its external contract is **eight verbs** (`ingest`, `search`, `retrieve`, `summarize`, `assemble_hot`, `capture_trace`, `lint`, `forget`) exposed through **four isomorphic surfaces**: the `cairn` CLI (ground truth — `cairn ingest …` / `cairn search …`), an MCP adapter that wraps the CLI for harnesses speaking MCP, a Rust SDK for in‑process embedding, and a shippable **Cairn skill** (SKILL.md + bash tool) for harnesses that don't want to run an MCP server. Opt‑in extension namespaces add aggregates / admin / federation (§8).

**The P0 backend is a single SQLite file.** One `.cairn/cairn.db` with SQLite's built‑in FTS5 for keyword search and markdown under `wiki/` for the human surface. No Python sidecar, no network, no embedding key, no external services. This is what ships in v0.1 and what every P0 path exercises on a fresh laptop offline.

**Scale‑up is a P1 decision, not a rewrite.** When you want semantic search, the **Nexus `sandbox` profile** adds a Python sidecar (BM25S + `sqlite-vec` + `litellm` embeddings) behind the same `MemoryStore` contract — config change, not code change. When you want a shared team hub, sandbox instances federate to a Nexus `full` hub zone (Postgres + pgvector + Dragonfly) over HTTP. The `MemoryStore` contract is still swappable if a team already runs a different store. The Rust binary installs with `brew install cairn` or `cargo install cairn`, ~15 MB, no runtime deps.

### 1.a What the end user actually does (KISS)

The rest of this doc is architecture. From the user's seat, Cairn is five things:

```
1. Install once          brew install cairn   |   cargo install cairn
                         (Rust static binary — ~15 MB, no runtime deps)
                         then:    cairn init                       (30 seconds)

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
2. **One contract, four surfaces.** Eight verbs, exposed as CLI (ground truth), MCP (protocol wrapper), SDK (in‑process), and skill (SKILL.md + bash). All four surfaces invoke the same eight Rust functions under `src/verbs/`. Hooks, library calls, internal agents — all route through the same verbs. **The CLI is primary**; MCP is a 300‑LOC adapter.
3. **Schema is YAML frontmatter.** No migrations. Add or disable `MemoryKind`s in `.cairn/config.yaml`; the pipeline follows.
4. **Plugins, not forks.** Every non‑trivial component is behind a typed contract; swapping is a config line. The default plugins and third‑party plugins use the same registration path.
5. **Local‑first, cloud‑optional.** The `cairn` Rust static binary works on a fresh laptop with zero credentials. Cloud is opt‑in per sensor and per write path.
6. **Failures become skills.** Skillify (§11.b) turns any observed failure into a tested, durable skill. The agent gets better from use, not from retraining.
7. **No hidden state.** Every mutation goes through the WAL (§5.6); every promotion goes through the nine‑gate predicate (§11.3); every consent decision lands in the append‑only journal (§14).

These are the load‑bearing invariants — everything else in this doc is consequence.

---

## 2. Design Principles (non‑negotiable) [P0]

**The principles as dependency layers — lower layers constrain higher ones:**

```
   ┌───────────────────────────────────────────────────────────────────────┐
   │  15. Plugin architecture                                              │
   │  14. Sources immutable · records LLM-owned · schema co-evolved        │  ← user-visible
   │  13. Compiled once, kept current                                      │    guarantees
   │  12. Folders group by purpose · links group by meaning                │
   │  11. summarize(persist:true) files itself back                        │
   │  10. A note without links is a bug                                    │
   └───────────────────────────────────────────────────────────────────────┘
                                    ▲
   ┌───────────────────────────────────────────────────────────────────────┐
   │   9. Procedural code owns env · agent owns content                    │
   │   8. Four surfaces, same verbs (§8)                                   │  ← operational
   │   7. Privacy by construction (Presidio + consent log + per-user salt) │    invariants
   │   6. Continuous learning off the request path                         │
   └───────────────────────────────────────────────────────────────────────┘
                                    ▲
   ┌───────────────────────────────────────────────────────────────────────┐
   │   5. Narrow typed contracts (7 interfaces, 15 pure functions)         │
   │   4. Local-first, cloud-optional                                      │  ← foundation
   │   3. Stand-alone (one Rust binary, zero creds)                        │
   │   2. Smallest viable backend; scale by adding layers                  │
   │   1. Harness-agnostic                                                 │
   └───────────────────────────────────────────────────────────────────────┘
```

Every higher-layer promise depends on a lower-layer promise. "Plugin architecture" (15) only makes sense because "narrow typed contracts" (5) defines what a plugin plugs into. "Privacy by construction" (7) only works because the backend is "stand-alone" (3) — a remote-only backend can't make the privacy promise. **Break a foundation principle and every principle above it weakens.**

1. **Harness‑agnostic.** Works with any agent loop that can either speak MCP **or** run a bash tool (via the Cairn skill §18.d) — which is every mainstream harness shipping today.
2. **Default to the smallest viable backend; scale by adding layers, not by swapping.** P0 default is a single SQLite file with FTS5 — zero external services. P1 upgrades the same vault to Nexus `sandbox` (adds Python sidecar + BM25S + `sqlite-vec` + embeddings) behind the same `MemoryStore` contract. P2 federates sandbox → Nexus `full` hub over HTTP. No code change in Cairn at any tier; the contract is still swappable for teams with an existing store, but Cairn does not "multi‑backend for multi‑backend's sake".
3. **Stand‑alone.** A single Rust static binary (`brew install cairn` or `cargo install cairn`) on a fresh laptop with zero cloud credentials works end‑to‑end.
4. **Local‑first, cloud‑optional.** The vault lives on disk. Cloud is opt‑in per sensor, per write path.
5. **Narrow typed contracts.** Seven real interfaces (five P0 + `FrontendAdapter` at P1 + `AgentProvider` at P2). Fifteen pure functions. Everything else is composition.
6. **Continuous learning off the request path.** A durable `WorkflowOrchestrator` runs Dream / Reflect / Promote / Consolidate / Propagate / Expire / Evaluate in the background. Default v0.1 implementation is `tokio` + a SQLite job table; Temporal is an optional adapter. Harness latency is untouched in either case.
7. **Privacy by construction.** Presidio pre‑persist, per‑user salt, append‑only consent log, no implicit share.
8. **The eight verbs are the contract; the CLI is the ground truth.** MCP, SDK, and the Cairn skill are all thin wrappers over the same eight Rust functions under `src/verbs/`. If a harness can run a subprocess, a bash command, or a JSON-RPC client, it speaks Cairn.
9. **Procedural code owns the environment. The agent owns content.** Deterministic hooks + workflows do classification, validation, indexing, and lifecycle. Content decisions (what to write, where to file, what to link) stay with the agent.
10. **A note without links is a bug.** Orphan detection is a first‑class metric.
11. **Good answers file themselves back.** `summarize(persist: true)` turns a synthesis into a new memory with provenance.
12. **Folders group by purpose. Links group by meaning.** A memory lives in one file; it links to many.
13. **Compiled once, kept current.** Knowledge is compiled into the vault once, then maintained — not re‑derived from raw sources on every query. The maintenance is the LLM's job; the curation is the human's.
14. **Sources are immutable; records are LLM‑owned; schema is co‑evolved.** Three layers, strict roles. Humans never edit records; LLMs never edit sources; both evolve the schema together.
15. **Plugin architecture, interface programming.** Every non‑trivial component is behind a typed contract. Default implementations sit alongside third‑party plugins with **no special privileges** — the same registry, the same loader, the same public traits. Cairn's L0 core has zero dependencies on any storage, LLM provider, workflow engine, sensor, or UI shell. Swapping a plugin is a config change, not a code fork.

---

## 3. Vault Layout (the on‑disk surface) [P0]

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

### 3.0 Storage topology — layered, P0 SQLite-only, P1 Nexus added

**Cairn's storage is additive, not replaceable.** P0 is one SQLite file. P1 adds a Nexus sidecar **alongside** it (not instead of it). P2 federates the Nexus sidecar to a hub. The Cairn-owned SQLite file never goes away; higher tiers layer on top.

```
  P0  (all you need for v0.1)                 P1  (add when you want semantic search)
  ──────────────────────────────────          ──────────────────────────────────────────
   cairn Rust binary                           cairn Rust binary
     │                                          │              │
     ▼                                          ▼              ▼
   .cairn/cairn.db  ◄── single SQLite file;    .cairn/cairn.db  Nexus sandbox (Python)
     · WAL state machine                         (unchanged —    │
     · Replay ledger                              still Cairn-    ▼
     · Consent journal                            owned control  nexus-data/  (internals — Cairn
     · Locks + reader fences                      plane)                        does not depend on
     · Records store (FTS5 index                                               the internal layout)
       on body; JSON frontmatter                                · BM25S lexical index
       as indexed columns)                                      · sqlite-vec ANN (embeddings
                                                                  via litellm — OPENAI_API_KEY
                                                                  or any provider)
                                                                · content-addressable blob
                                                                  storage (cas/)
                                                                · metadata store (ReDB)
                                                                · skills/ + zones/ auxiliary

   cairn Rust binary speaks to               Cairn calls only the Nexus `search`, `filesystem`,
   SQLite directly via rusqlite —            and related bricks over HTTP+MCP. It never opens
   zero network, zero sidecar.               files inside nexus-data/ directly.


  P2  (add when you share across users/machines)
  ─────────────────────────────────────────────────────────────────────
   cairn Rust binary                       ┌──► Nexus full hub (shared)
     │              │                      │     · PostgreSQL + pgvector
     ▼              ▼                      │     · Dragonfly (cache)
   .cairn/cairn.db  Nexus sandbox  ────────┤     · Nexus `search` brick
     (unchanged —    (unchanged —          │       (federated BM25 + ANN)
      still P0        still P1             └──   over HTTPS + mTLS
      control         local memory)
      plane)

                                           Federation queries: sandbox delegates
                                           search when scope requires team/org/public;
                                           graceful local fallback if hub unreachable.
```

**Storage layer by priority — a single authoritative table:**

| Layer | Priority | Owned by | On-disk location | What it holds | When active |
|-------|----------|----------|-------------------|----------------|-------------|
| Cairn control plane + **record store** + **local semantic index** | **P0** (always) | Rust core (direct `rusqlite` + statically-linked `sqlite-vec` C extension + pure-Rust `candle` runtime) | `.cairn/cairn.db` (one SQLite file) + `.cairn/models/` (downloaded embedding model, ~25 MB on first run) | **record bodies + frontmatter + FTS5 + edges + `sqlite-vec` ANN over locally-embedded vectors** (authoritative at every tier), WAL state, replay ledger, consent journal, locks, reader fences | every tier |
| Nexus sandbox **indexes** (derived projection) | **P1** (opt-in) | Nexus Python sidecar (never touched by Rust) | `nexus-data/` directory tree (Nexus-internal layout) | derived-only: BM25S lexical index, `sqlite-vec` ANN vectors, ReDB metastore, CAS blobs (content-addressed mirror of `records.body`). **Never the source of truth** — any `nexus-data/` state can be deleted and rebuilt from `.cairn/cairn.db` by `cairn reindex --from-db`. | when `store.kind: nexus-sandbox` |
| Nexus full hub **federation** (derived projection) | **P2** (opt-in) | remote Nexus hub | Postgres + pgvector + Dragonfly (service-managed) | derived-only: cross-vault search index for shared-tier records; aggregate indexes. Original records still live in each vault's `.cairn/cairn.db`. | when federation enabled |

**Authority rule at every tier: `.cairn/cairn.db` is the sole authority for record bodies, frontmatter, edges, and WAL state.** Every Nexus table (sandbox or hub) is a derived index built from it, idempotently rebuildable via `cairn reindex --from-db`. This is the same relationship markdown has to the DB: repairable projection, never source of truth. Linearization is always defined by `.cairn/cairn.db`'s commit order — at P1 the idempotency-keyed Nexus apply endpoint makes the projection eventually consistent with that order, never vice versa.

**What goes where, at each tier:**

| Data | P0 (SQLite only) | P1 (+ Nexus sandbox) | P2 (+ hub federation) |
|------|-------------------|------------------------|-------------------------|
| Record bodies (markdown + frontmatter) | **`.cairn/cairn.db` records table is authoritative** (`body`, `frontmatter_json`, `body_hash` columns). The `wiki/` + `raw/` markdown tree is a **repairable projection** of the DB, regenerated on demand via `cairn export --markdown` or automatically by the `markdown_projector` background job on every WAL commit. A missing or stale markdown file never corrupts the vault; `cairn lint --fix-markdown` rebuilds the tree from DB. | **same authority** — `.cairn/cairn.db` still owns record bodies. Nexus only mirrors them into CAS (`nexus-data/cas/`) as a derived content-addressed projection for the search brick to read; `cairn reindex --from-db` rebuilds Nexus's CAS mirror from the authoritative DB. | **same authority** — each vault's `.cairn/cairn.db` still owns record bodies. Hub Postgres holds a derived projection for shared-tier federation queries; on federation divergence, `cairn reindex --push-to-hub` replays from each vault's DB. |
| Full-text search | SQLite FTS5 on body column (authoritative keyword index) | **BM25S** via Nexus `search` brick as an **additional** scorer alongside FTS5 (derived from DB); FTS5 remains authoritative | BM25S on sandbox + federated BM25 on hub; results merged. All tiers derivable from each vault's DB. |
| Semantic search | **`sqlite-vec` over pure-Rust `candle` embeddings** (default model: `bge-small-en-v1.5` or `all-MiniLM-L6-v2`, ~25 MB, downloaded on first run into `.cairn/models/`). Zero network after fetch, zero Python, single-process. Advertises `cairn.mcp.v1.search.semantic` by default. Can be disabled via `search.local_embeddings: false` — then keyword only, semantic/hybrid rejected with `CapabilityUnavailable`. | Same `sqlite-vec` index; Nexus adds the option to swap the embedding provider to `litellm` (OpenAI / Cohere / Voyage / Ollama) for richer vectors than the local small model. Vectors keyed by `record_id` and rebuilt from DB on reindex. | local `sqlite-vec` + pgvector on hub; results merged |
| WAL / locks / consent journal | `.cairn/cairn.db` tables (authoritative linearization point for every tier) | **unchanged — still `.cairn/cairn.db`** (never moves to Nexus). All Nexus side-effects are keyed by `operation_id` and replayable from the WAL. | **unchanged** — each node has its own local control plane; hub never holds WAL state |
| Raft / consensus | none (single-writer SQLite) | `nexus-data/root/raft/raft.redb` (Nexus-internal, only for Nexus's own sandbox peers — **not** for Cairn's WAL linearization) | hub-side only for cross-tenant coordination; still does not own record state |
| Secrets / embeddings / raw PII | never persisted — stripped at Filter stage | same | same |

### Records-in-SQLite at P0 — what the FTS5-native layout looks like

At P0, Cairn stores records as rows in `.cairn/cairn.db` — the **authoritative** source. The markdown files under `wiki/` and `raw/` are a **repairable projection** of the DB: a background job regenerates them on every WAL commit, and `cairn lint --fix-markdown` rebuilds the entire tree from DB when (a) files are deleted by the user, (b) files diverge from DB (e.g., after manual edits), or (c) on a fresh machine after import. This flip matters for crash semantics: SQLite's atomic commit covers all authoritative state; markdown divergence is never a correctness issue, only a UX annoyance that `lint --fix-markdown` resolves. Query latency stays under 5 ms for typical reads because it's one `SELECT` against one local SQLite file with WAL mode enabled.

**For users who edit markdown directly** — treat Cairn like any projection-based system. Either (a) edit in the desktop GUI / CLI so changes route through the verbs, or (b) edit the markdown file, then run `cairn ingest --resync <path>` to re-extract the DB row. Out-of-band edits that bypass ingest are visible in the filesystem but not to `search` or `retrieve` until resynced. `lint` flags any drift between DB rows and their markdown projections.

```sql
-- P0 records table (inside .cairn/cairn.db — no separate file, no separate process).
-- Versioned COW model matching §5.6 WAL: a record is a sequence of (target_id, version)
-- rows. Exactly one row per target_id is "active" at any moment; upsert stages version=N+1
-- as inactive, then the pointer-swap step in §5.6 flips active inside the same transaction.
CREATE TABLE records (
  record_id   TEXT PRIMARY KEY,         -- DETERMINISTIC per-version id: record_id = BLAKE3(target_id || '#' || version);
                                        -- recovery re-runs of primary.upsert_cow produce the same record_id, so
                                        -- ON CONFLICT(record_id) DO NOTHING makes step 2 idempotent without a write.
  target_id   TEXT NOT NULL,            -- stable logical identity — every version of the same record shares this
  version     INTEGER NOT NULL,         -- monotonic per target_id; version 1 is first create
  path        TEXT NOT NULL,            -- e.g., wiki/entities/people/alice.md — not unique across versions
  kind        TEXT NOT NULL,            -- one of 19 MemoryKinds
  class       TEXT NOT NULL,            -- episodic | semantic | procedural | graph
  visibility  TEXT NOT NULL,            -- private | session | project | team | org | public
  scope       TEXT NOT NULL,            -- JSON tuple (tenant, workspace, ...)
  actor_chain TEXT NOT NULL,            -- JSON array of signed actors
  body        TEXT NOT NULL,            -- authoritative body for this version (markdown)
  body_hash   TEXT NOT NULL,            -- sha256 of body
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0,  -- 1 for the currently-visible version, 0 for staged or superseded
  tombstoned  INTEGER NOT NULL DEFAULT 0,  -- set by forget_record / forget_session on EVERY version of the target
                                           -- (not just active) so superseded versions cannot resurrect content
  is_static   INTEGER NOT NULL DEFAULT 0,  -- 1 = permanent trait (name, hometown, birth date), exempt from the expirer;
                                           -- 0 = dynamic fact (current project, device, blocker) subject to decay.
                                           -- Defaults: `user` / `fact` / `entity` kinds → 1; `event` / `signal` /
                                           -- `trace` / `reasoning` → 0; other kinds inherit the ExtractorWorker's
                                           -- verdict. AutoUserProfile (§7.1) uses this to split static vs dynamic.
  UNIQUE (target_id, version)           -- second idempotency key: a retry cannot stage version N+1 twice
);

-- Exactly one active row per target_id at any moment (enforced by partial unique index).
CREATE UNIQUE INDEX records_active_target_idx
  ON records(target_id) WHERE active = 1;
-- Path lookup + freshness filter: every materialized query joins on active = 1 AND tombstoned = 0.
CREATE        INDEX records_path_idx       ON records(path)       WHERE active = 1 AND tombstoned = 0;
CREATE        INDEX records_kind_idx       ON records(kind)       WHERE active = 1 AND tombstoned = 0;
CREATE        INDEX records_visibility_idx ON records(visibility) WHERE active = 1 AND tombstoned = 0;
CREATE        INDEX records_scope_idx      ON records(scope)      WHERE active = 1 AND tombstoned = 0;

-- SQLite FTS5 virtual table — the P0 keyword search surface. Uses external-content mode so
-- its rowid is the records.rowid, which gives structural idempotency: an FTS5 retry against
-- the same records row overwrites the index entry in place rather than producing a duplicate.
-- Readers filter FTS hits against records WHERE active = 1 AND tombstoned = 0 (§5.1 read path).
CREATE VIRTUAL TABLE records_fts USING fts5(
  body,                                 -- the markdown body, indexed
  content='records',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
-- Keep the FTS index in sync with records; these triggers also make fts upsert idempotent on retry.
CREATE TRIGGER records_fts_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER records_fts_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER records_fts_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO records_fts(rowid, body) VALUES (new.rowid, new.body);
END;

-- Graph edges (links, backlinks, requires/provides, entity relationships, fact lineage). Keyed
-- by per-version deterministic record_id so a pointer-swap atomically replaces the edge set
-- along with the body. Cairn blesses three fact-lineage edge kinds that ConflictDAG (§10) and
-- the ranker read directly: `updates` (new fact supersedes old; old becomes not-latest),
-- `extends` (new fact adds detail to old; both remain latest), `derives` (new fact inferred
-- from one or more existing facts; source facts remain latest). Combined with the `is_latest`
-- computed view below, `retrieve(kind=fact, latest_only=true)` returns exactly the currently-
-- true facts without walking the whole edge DAG at read time.
CREATE TABLE edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,             -- link | backlink | requires | provides | updates | extends | derives | <custom>
  weight REAL,
  PRIMARY KEY (src, dst, kind)
);

-- `is_latest` is derived, not stored: a record version is "latest" when no `updates` edge
-- points to it. ConflictDAG (§10) emits `updates` edges whenever Consolidation classifies
-- a fresh fact as a supersession; the ranker and `retrieve(latest_only=true)` join on this
-- view instead of walking edges per query.
CREATE VIEW records_latest AS
  SELECT r.*
    FROM records r
   WHERE r.active = 1
     AND r.tombstoned = 0
     AND NOT EXISTS (
       SELECT 1 FROM edges e
        WHERE e.kind = 'updates' AND e.dst = r.record_id
     );
```

Plus the control-plane tables (same file, same transaction scope):

```sql
-- WAL state machine (§5.6)
CREATE TABLE wal_ops    (operation_id TEXT PK, state TEXT, envelope JSONB, …);
CREATE TABLE wal_steps  (operation_id TEXT, step_ord INT, state TEXT, PK(operation_id, step_ord));

-- Replay ledger (§4.2)
CREATE TABLE used                   (operation_id TEXT, nonce BLOB, issuer TEXT, sequence INT, committed_at INT, UNIQUE(operation_id, nonce));
CREATE TABLE issuer_seq             (issuer TEXT PK, high_water INT);
CREATE TABLE outstanding_challenges (issuer TEXT, challenge BLOB, expires_at INT, PK(issuer, challenge));

-- Concurrency control (§5.6, §10.1) — epoch counter is the fencing primitive, not wall-clock;
-- per-holder rows with boot_id + BOOTTIME-ns deadlines make leases durable across daemon restarts.
CREATE TABLE locks        (scope_kind TEXT, scope_key TEXT, mode TEXT, holder_count INT, epoch INT, waiters BLOB, last_heartbeat_at INT, PK(scope_kind, scope_key));
CREATE TABLE lock_holders (scope_kind TEXT, scope_key TEXT, holder_id TEXT, acquired_epoch INT, boot_id TEXT, reclaim_deadline INT, PK(scope_kind, scope_key, holder_id));
CREATE TABLE reader_fence (scope_kind TEXT NOT NULL, scope_key TEXT NOT NULL, op_id TEXT NOT NULL, state TEXT NOT NULL, opened_at INT NOT NULL, PRIMARY KEY (scope_kind, scope_key));

-- Audit
CREATE TABLE consent_journal (row_id INTEGER PK AUTOINCREMENT, op_id TEXT, actor TEXT, kind TEXT, payload JSONB, committed_at INT);
```

**All in one SQLite file.** At P0 every mutation is one local `BEGIN IMMEDIATE; … COMMIT;` that atomically couples the records update, the WAL row, and the consent journal row. No cross-process coordination, no HTTP, no Python. SQLite's own durability is the durability guarantee.

### Atomicity model — P0 is single-transaction, P1+ is durable-messaging

**At P0 there is exactly one SQLite file and one writer process (the Cairn Rust binary).** The WAL state machine `ISSUED → PREPARED → COMMITTED / ABORTED / REJECTED` (§5.6) still exists at P0 — it is the audit / replay ledger — but **all state transitions plus every side-effect land in one `BEGIN IMMEDIATE; … COMMIT;`**. That single SQLite transaction atomically:

1. advances `wal_ops.state` from the prior state to the new state (`ISSUED → PREPARED` or `PREPARED → COMMITTED`)
2. upserts the record row (or tombstones, or expires)
3. upserts the FTS5 row
4. upserts the edges rows
5. consumes the replay ledger entry
6. appends the `consent_journal` row
7. updates per-holder lock rows (`lock_holders.reclaim_deadline`, etc.)

Because every transition commits together with its side-effects, there are no "PREPARED but not COMMITTED" rows at rest — SQLite's atomic commit either applies all of steps 1-7 or none of them. **No distributed two-phase commit, no compensation actions, no partial-state recovery.** The only recovery path is SQLite's own WAL-mode crash recovery: either the commit landed and the WAL op is `COMMITTED`, or it didn't and the op is still `ISSUED` (replayed as a fresh attempt). §5.6's `PREPARED → ABORTED` compensation path and §19's step-marker flow are **P1+ only** — they materialize exactly when side effects cross the SQLite boundary into Nexus, because only then can a mid-flight failure leave inconsistent state.

**The WAL states at P0 are audit markers, not a distributed protocol.** Tools like `cairn admin replay-wal` use them to reconstruct what happened; the FSM diagram in §5.6 still applies, but transitions `PREPARED → ABORTED` and `PREPARED → COMMITTED` are both *implemented as part of the same SQLite transaction that made the side-effect visible*, not as separate round-trips.

**At P1 (Nexus sandbox active)** Cairn uses a durable-messaging pattern across two storage systems — `.cairn/cairn.db` (Cairn-owned SQLite) and `nexus-data/` (Nexus-owned, multi-file, opaque to Cairn):

1. Rust core commits a local SQLite transaction in `.cairn/cairn.db` that atomically writes the WAL `PREPARE` row + consumes the replay ledger entry. **No `consent_journal` row at PREPARE time** — consent is linearized with the state transition.
2. Rust calls the Nexus HTTP apply endpoint, keyed by `operation_id`. Nexus performs its own durable writes to `nexus-data/` (cas write + index updates + ReDB metastore update); all of this is internal to Nexus.
3. On HTTP success, Rust commits a second local transaction in `.cairn/cairn.db` that atomically flips `wal_ops.state = 'COMMITTED'` **and** appends the `consent_journal` row.

Crash windows:
- Crash between (1) and (2): recovery replays step (2) with the same `operation_id` (idempotent at the Nexus endpoint).
- Crash between (2) and (3): recovery probes Nexus for that `operation_id`; if Nexus has already applied, step (3) runs and couples `COMMITTED` + consent journal atomically.

**The idempotency key is the linearization primitive across processes.** This is weaker than distributed 2PC and we call it out rather than pretend otherwise. SQLite provides atomicity inside Cairn; Nexus's internal durability (its own fsync discipline) provides atomicity inside Nexus; `operation_id` couples them.

### What Nexus contributes at P1+ (and what it doesn't)

Nexus is a Python sidecar composed of independent bricks. At P1 Cairn activates these:

| Brick | What Nexus does | Cairn-side usage |
|-------|------------------|-----------------|
| `filesystem` | file-system abstraction over a content-addressable store in `nexus-data/cas/` | Cairn's `wiki/` and `raw/` markdown are projected here for CAS addressing + share-link packaging |
| `search` | BM25S lexical index + `sqlite-vec` ANN + `litellm` embeddings (sandbox profile); federates to hub for cross-tenant queries | Cairn's `search` verb delegates semantic + hybrid modes to this brick |
| `rebac` | ReBAC relation graph for tenant / workspace / project scoping | enforces visibility tier filters at query time |
| `access_manifest` | declarative policy manifest (who can read what) | read by `rebac` per query |
| `snapshot` | filesystem-level snapshotting | `cairn snapshot` delegates; sequences with `.cairn/cairn.db` copy |
| `versioning` | operation-undo over the CAS | used by §5.6 WAL compensation actions |
| `portability` | `.nexus` bundle format | `cairn export` / `cairn import` delegate |
| `parsers` | PDF/DOCX/HTML/CSV/Parquet → markdown | source sensors delegate parsing |
| `catalog` | schema extraction for structured sources | feeds `entity_*.md` / `fact_*.md` |
| `share_link` | consent-gated time-bound grants | `PropagationWorkflow` generates these |
| `workspace` | Nexus workspace isolation | backs Cairn's vault registry (§3.3) |
| `mcp` | Nexus's own MCP surface | Cairn's verbs register alongside Nexus bricks |
| `workflows` | optional durable job queue | alternate `WorkflowOrchestrator` if you don't want tokio or Temporal |
| `discovery` | dynamic skill + playbook registration | used by `EvolutionWorkflow` |

**Bricks Cairn deliberately does not use** (out of scope): `ipc` (FS-as-IPC — we use CLI subprocess instead), `auth` / `identity` / `secrets` (harness upstream owns auth), `pay` / `sandbox` (brick) / `mount` / `upload` (billing / FUSE / upload UI), `context_manifest` / `governance` / `task_manager` / `delegation` (overlap with features Cairn owns).

**No `memory` brick exists in Nexus today.** Cairn owns memory semantics (19 kinds, consolidation, promotion, evolution, hot-memory assembly, confidence bands, conflict DAG). If a future Nexus `memory` brick ships, Cairn's adapter can delegate.

### Operational notes

- **Backup at P0:** use `cairn snapshot --backup <path>` (never a raw `cp`), which (a) writes a consistent SQLite online backup of `.cairn/cairn.db` via the `sqlite3_backup_*` API, (b) copies the markdown projections in `wiki/` + `raw/`, (c) emits a fresh **backup registry entry** at `.cairn/backups/<backup_id>.json` recording the `{backup_id, created_at, target_ids_included: [...]}`. The registry is what makes forget-me privacy invariants extend across backups (see below). `sources/` is immutable input; see "Forget-me across backups and sources" below for the ingested-content purge path.
- **Backup at P1:** `cairn snapshot --backup <path>` additionally copies `nexus-data/` (derived projections rebuild from the DB on restore — the backup stays consistent with the authoritative SQLite file).
- **Forget-me across backups and sources (privacy invariant).** `forget_record` / `forget_session` Phase B's audit-grep invariant (§5.6) is **not** satisfied by a simple purge of the live vault — any backup or `sources/` file that contained the forgotten content is a resurrection path. Cairn handles both:
  - **Backups.** Every `cairn snapshot --backup` writes a backup registry entry; `forget` Phase B step `backup.replay_tombstones` scans the registry and for each listed backup runs a post-hoc `cairn snapshot --rewrite <backup_id> --drop-targets <target_id_list>` pass that produces a new redacted backup file and invalidates the old one (cryptographically shredded and listed in `.cairn/backups/shredded.log`). Restoring a backup **always** applies tombstone replay from the current consent log before reads are served — the restored vault picks up every `forget` committed since the backup was taken. Both mechanisms together ensure no backup restore can surface a forgotten target.
  - **`sources/` re-ingestion.** `sources/` holds the raw inputs (emails, transcripts, PDFs) as immutable provenance. If a forgotten `target_id` was derived from a source file, the source file is **not** deleted (it is outside Cairn's authority — the user or upstream system owns it), but the **link from the source to any Cairn memory is severed** and a `source_forget` entry is added to `consent_journal`. Any future re-ingestion that tries to re-derive memories from that source checks the `consent_journal` and skips any previously-forgotten targets (dedup by content-hash). Users who require stricter guarantees set `source.redact_on_forget: true` in `.cairn/config.yaml`, which deletes the source file contents (preserving only its hash + metadata) on `forget`. The default is `false` because sources are often shared with other tooling.
  - **Test.** §15 privacy suite adds a backup-restore-after-forget regression: take backup B, ingest content C, forget C, restore B, assert C never becomes reader-visible.
- **Semantic search availability — one rule (updated).** Semantic and hybrid search require an `embedding_provider`. The default at **P0 is the bundled pure-Rust `candle` runtime** loading a small local model (`bge-small-en-v1.5` or `all-MiniLM-L6-v2`, ~25 MB, downloaded to `.cairn/models/` on first run) — no API key, no network after fetch, no Python. **P1** Nexus sandbox adds the option to swap in `litellm` (OpenAI / Cohere / Voyage / local Ollama) when the user wants richer vectors. When an embedding provider is configured and reachable, `search mode: semantic | hybrid` returns enriched results. When the provider is unreachable mid-call, results are stamped `semantic_degraded=true` and FTS5 answers the query. Only when the user explicitly sets `search.local_embeddings: false` **and** has no P1+ provider does the runtime drop `cairn.mcp.v1.search.semantic` from `status.capabilities` and reject semantic calls with `CapabilityUnavailable`.
- **Process boundary at P1+:** Nexus is Python, Cairn core is Rust. They communicate over HTTP + MCP. `cairn-nexus-supervisor` spawns Nexus, tails logs, health-checks, restarts. A crashed Nexus never blocks Cairn — queries degrade to P0 behavior until Nexus recovers.
- **Federation, not re-platforming, scales at P2.** A sandbox on a laptop can federate `search` queries to a remote Nexus `full` hub (PostgreSQL + pgvector + Dragonfly). Hub unreachable → graceful fallback to local sandbox or (further) local FTS5; never a boot failure.

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
  kind: sqlite                # P0 default — sqlite | nexus-sandbox (P1) | nexus-full (P2) | postgres | custom:<name>
  # path: omitted for sqlite — uses .cairn/cairn.db (the single P0 SQLite file)
  # At P1:  kind: nexus-sandbox — Nexus sidecar adds nexus-data/ directory alongside .cairn/cairn.db
  # At P2:  kind: nexus-full   — federates to a remote Nexus hub (Postgres+pgvector)
llm:
  provider: openai-compatible
  base_url: https://…
workflows:
  orchestrator: temporal      # temporal | local
```

A new vault inherits the default config. Teams fork a config as a shareable template (e.g. `cairn init --template research`, `--template engineering`, `--template personal`).

### 3.2 Vault topology — who shares what

A **vault** is the unit of physical colocation + atomic durability: one filesystem tree + one `.cairn/cairn.db` (always — Rust control plane + P0 records store) + the markdown tree (`wiki/` · `raw/` · `sources/`) + one `consent.log` + optionally a Nexus `nexus-data/` directory at P1+. **Users, agents, and sessions are actors WITHIN a vault**, scoped by the identity model in §4.2 and the visibility tiers in §6.3. A vault is never per‑agent or per‑session; isolation across actors happens through scope tuples + rebac, not through separate files.

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

### 3.3 Many vaults per user — registry, switching, isolation

A single user rarely has one vault. Typical patterns: one `work` vault on a corporate laptop + one `personal` vault on the same machine + a transient `research-sprint` vault for a specific project + per‑client vaults for consultants. Cairn treats multiple vaults as first‑class: each is a self‑contained directory; none knows about the others; the user picks which is active per invocation.

**Vault = directory. That's the whole model.**

```
  ~/vaults/
    ├── work/              ← cairn init here (P0 layout shown)
    │   ├── .cairn/
    │   │   ├── cairn.db        ← the one SQLite file (records + WAL + consent)
    │   │   └── config.yaml
    │   ├── purpose.md
    │   ├── wiki/               ← markdown projection (rebuildable from DB)
    │   ├── raw/
    │   └── sources/
    │   (+ nexus-data/ appears here only after P1 is enabled)
    ├── personal/          ← cairn init here
    │   ├── .cairn/ ... same shape
    │   └── ...
    ├── research/
    └── client-acme/
```

**Vault registry** — a lightweight index so the CLI / GUI know which vaults exist without scanning the disk. Lives at `~/.config/cairn/vaults.toml` (Linux/macOS) or `%APPDATA%\cairn\vaults.toml` (Windows):

```toml
default = "work"

[[vault]]
name = "work"
path = "~/vaults/work"
label = "day job, kept off personal cloud"

[[vault]]
name = "personal"
path = "~/vaults/personal"
label = "side projects, OSS, reading"

[[vault]]
name = "research"
path = "~/vaults/research"
expires_at = "2026-07-01"   # transient vault; lint warns after
```

The registry is **a UX convenience, not a security boundary** — every vault's `.cairn/cairn.db` remains the authority for identity, consent, and WAL state within that vault. Deleting the registry never damages a vault.

**Picking the active vault — four ways, same precedence as most tools:**

| # | Mechanism | Wins over | Use when |
|---|-----------|-----------|-----------|
| 1 | `--vault <name\|path>` CLI flag | everything | scripts, CI, ad‑hoc one‑off |
| 2 | `CAIRN_VAULT=<name\|path>` env var | shell / registry default | per‑terminal context switching |
| 3 | `.cairn/` discovered by walking up from `$PWD` | registry default | running inside a project tree |
| 4 | `default = "…"` in `vaults.toml` | nothing (lowest) | outside any vault, no flag/env |

`cairn vault list` / `cairn vault switch <name>` / `cairn vault add <path>` / `cairn vault remove <name>` manage the registry.

**One invocation, one vault — per surface.** Every Cairn invocation binds to exactly one vault through `--vault <name>` (or `CAIRN_VAULT=<name>` env, or walk-up discovery). This is true for **every surface**, not just MCP:

```
  # CLI (ground truth, most common)
  cairn --vault work search "pgvector perf"
  cairn --vault personal ingest --kind user --body "..."

  # Skill (via the harness's bash tool)
  CAIRN_VAULT=work cairn search "..."              # one-off
  export CAIRN_VAULT=work                          # session-scoped

  # MCP (for harnesses that register MCP servers)
  # Each registered MCP server is bound to one vault:
  cairn-work        → cairn mcp --vault work
  cairn-personal    → cairn mcp --vault personal

  # SDK (in-process)
  cairn::init(VaultPath::by_name("work")?)
```

**The harness picks which vault to use per turn** — by user intent, project path, a `/switch` slash command, or a `CAIRN_VAULT` env var set at session start. **Cairn never merges across vaults server-side**, regardless of surface — doing so would violate the isolation property the user opted into by having separate vaults. A harness that wants cross-vault queries makes multiple independent calls and merges client-side (and inherits full responsibility for the visibility-tier implications).

**What crosses vaults, what doesn't:**

| Item | Crosses vaults? | Why |
|------|-----------------|-----|
| Memory records | no | a vault is the isolation unit; crossing would break tenant/rebac invariants |
| `search` queries | no by default | opt‑in via explicit multi‑vault federation (§12.a hub model) |
| Hot memory prefix | no | assembled from one active vault per turn |
| Ed25519 keypairs | no — **one keypair per vault per identity** | stored under that vault's row in the platform keychain; revoking one vault's key doesn't affect others |
| `consent.log` | no — each vault owns its own | per‑vault audit is the law |
| `skills/` content | optionally, via `cairn skillpack` | bundle‑level export/import, not transparent |
| Plugin installs | global by default | one Cairn binary, one plugin registry; active set filters per vault's `config.yaml` |

**When to make a new vault:**

- the data is in a different trust domain (work vs. personal) → **new vault**
- the data is in the same trust domain but a different project → **same vault, different `project:` scope**
- the data is transient (research sprint, contest, migration dry‑run) → **new vault with `expires_at`**
- the data needs to be shareable with a specific team → **same vault, share via `share_link` + `team` tier**

---

### 3.4 Folders are first‑class — nested, self‑describing, self‑summarizing [P0 basic · P1 summary]

Folders inside `wiki/` and `raw/` nest to arbitrary depth. Each folder — at any depth — can carry three optional sidecar files that make it self‑describing, navigable, and retrievable as a unit: `_index.md`, `_summary.md`, `_policy.yaml`. Cairn treats a folder with these sidecars as a **first‑class memory unit** — not just a directory.

**Example nested layout:**

```
  wiki/
    entities/                           ← folder can have sidecars at any depth
      _index.md                         ← auto-generated table of contents
      _summary.md                       ← LLM-generated rolling summary (P1)
      _policy.yaml                      ← allowed_kinds, visibility default, ...
      people/
        _index.md
        _summary.md
        _policy.yaml                    ← e.g., "only `entity` kind, visibility private by default"
        alice.md                        ← the actual records
        bob.md
        carol/                          ← a single entity can even be a folder
          _index.md                     ← when the entity has many sub-records
          profile.md
          interactions.md
          deltas/                       ← arbitrary sub-structure allowed
            2026-03.md
            2026-04.md
      projects/
        _index.md
        koi/
          _index.md
          _summary.md
          rfc-001.md
          rfc-002.md
      companies/
        _index.md
        acme.md
    summaries/
      _index.md
      weekly/
      monthly/
    skills/
      _index.md
      _policy.yaml                      ← only `playbook`/`strategy_success` allowed here
      deploy/
      debug/
      review/
```

**The three sidecar files — what each does:**

| File | Purpose | Who writes it | Updated when | Priority |
|------|---------|---------------|---------------|-----------|
| `_index.md` | machine‑readable table of contents for this folder — child paths, kinds, last‑modified, record count, backlinks | `PostToolUse` hook whenever a child record is written, renamed, or deleted | every write in the folder's subtree | **P0** — always maintained |
| `_summary.md` | LLM‑generated rolling summary of the folder's conceptual content — "what does this folder know?" suitable for `assemble_hot` | a new `FolderSummaryWorkflow` (off‑path, `tokio` orchestrator) | on consolidation cadence (default: every 24 h + after N new records) | **P1** — adds LLM cost |
| `_policy.yaml` | folder‑level config: allowed kinds, visibility default for new records, consolidation cadence override, owner agent | human or `cairn config` CLI; enforced by Filter stage (§5.2) | manually edited; read by every write into this folder | **P0** — enforced if present |

**Example `_index.md` (auto-generated):**

```markdown
---
folder: wiki/entities/people
kind: folder_index
updated_at: 2026-04-22T14:02:11Z
record_count: 42
subfolder_count: 3
---
# entities/people

## Records (42)
- [alice.md](alice.md) — entity · updated 2026-04-21 · 5 backlinks
- [bob.md](bob.md) — entity · updated 2026-04-19 · 3 backlinks
- ... (40 more)

## Subfolders (3)
- [carol/](carol/) — 8 records · last updated 2026-04-22
- [engineering/](engineering/) — 14 records · last updated 2026-04-20
- [leadership/](leadership/) — 6 records · last updated 2026-04-18

## Backlinks into this folder (17)
- [../projects/koi/rfc-001.md](../projects/koi/rfc-001.md)
- ... (16 more)
```

**Example `_summary.md` (P1, LLM-generated by FolderSummaryWorkflow):**

```markdown
---
folder: wiki/entities/people
kind: folder_summary
generated_at: 2026-04-22T03:00:00Z
generated_by: agt:cairn-librarian:v2
covers_records: 42
summary_tokens: 180
---
This folder holds personal and professional context for 42 people the user
has interacted with over the past 18 months. Largest cluster: 14 Koi team
engineers (see engineering/). Highest recall: alice (12 interactions,
primary collaborator on v2 rewrite). Recent additions focus on contractors
for the Cairn MCP integration work.

Dominant kinds: entity (40), reasoning (2).
Visibility distribution: private (38), session (3), project (1).
```

**Example `_policy.yaml`:**

```yaml
folder: wiki/entities/people
allowed_kinds: [entity, reasoning]       # Filter stage rejects writes of other kinds
visibility_default: private
consolidation_cadence: weekly            # overrides global default
owner_agent: agt:cairn-librarian:v2      # this agent owns summaries for this folder
retention_days: unlimited                # per-folder retention override
summary_max_tokens: 300                  # cap for _summary.md regeneration
```

**How retrieval uses these:**

| Use case | What happens |
|----------|--------------|
| `cairn search "people skills"` | search hits `_summary.md` files first (high density, pre‑digested); zero‑hit folders are skipped |
| `cairn retrieve --folder wiki/entities/people` | returns `_index.md` + `_summary.md` + direct children; lets an agent "browse" instead of "grep" |
| `assemble_hot` | can inject the `_summary.md` of the top‑scoped folder into the hot prefix (~200 tokens replaces ~2000 tokens of raw file list) |
| `cairn lint` | checks that every non‑empty folder has an `_index.md`; flags folders where `_summary.md` is > N days stale |
| agent navigation | an agent exploring the vault reads `_index.md` at each level instead of `ls`‑ing thousands of files — faster, cheaper, safer |

**How they're kept fresh — zero manual upkeep:**

```
  write to wiki/entities/people/alice.md
          │
          ▼
  PostToolUse hook (synchronous, <5 ms)
          │
          ├──► update wiki/entities/people/_index.md
          │    (append/update row for alice.md; bump updated_at)
          │
          ├──► update wiki/entities/_index.md           ← walks up to parent
          │    (recompute aggregates: record_count, last_update)
          │
          ├──► update wiki/_index.md                     ← and parent's parent
          │
          └──► enqueue FolderSummaryWorkflow job        (P1 only; async)
               (runs on cadence, regenerates _summary.md
                when new records exceed threshold)
```

**Folder-level operations become O(1):**

- "What's in `wiki/entities/people/`?" — read one file (`_index.md`), not 42
- "What does this folder know?" — read one file (`_summary.md`), not 42 × LLM pass
- "Forget everything under this folder" — `cairn forget --scope '{"path_prefix":"<path>"}'` maps to `forget` verb with `mode: "scope"` (§8 verb 8) and the `cairn.mcp.v1.forget.scope` capability advertised only in v0.3+ runtimes. Internally it iterates every child `target_id` under the prefix using the same per-record Phase A+B pipeline as `forget_session`, under one `reader_fence` keyed by `(scope_kind='folder', scope_key=<path>)`.
- "Copy this folder to a teammate" — the `cairn.federation.v1` extension's `propose_share` / `accept_share` verbs (§8.0.a) accept a `subject.path_prefix` field; Cairn bundles every record whose `path` starts with the prefix into a `.nexus` bundle along with its `_index.md` + `_summary.md` + edges, gated by `ShareLinkGrant`. Both are enterprise-only and capability-gated exactly like every other share operation; there is **no** separate `cairn share` CLI command.

**Folder vs. scope vs. tier — when to use which:**

| If you want to… | Use… |
|-----------------|-------|
| physically group related records in one place on disk | **a folder** |
| filter queries by project / entity / topic without moving files | **a scope** (in the record's frontmatter) |
| control who can read the records | **a visibility tier** (§6.3) |
| control what kinds can be written here | **a `_policy.yaml` in the folder** |
| share a group of records as a unit | **a folder + `cairn.federation.v1` extension `propose_share` with `subject.path_prefix`** (§8.0.a; v0.3+) |

Folders, scopes, and tiers are orthogonal — the same record can live in `wiki/entities/people/alice.md`, have scope `(team: infra, project: koi)`, and visibility `team`. Each axis does one thing.

### 3.4.a Prior art — what the Obsidian ecosystem did and what to reuse

Obsidian is the closest battle‑tested reference for "markdown vault with folder organization." Cairn has a **different constraint** (every write is pipeline‑driven, no human file editor) but several Obsidian patterns survive the translation. Three worth stealing; three worth avoiding.

**Three patterns to reuse:**

| # | Pattern | Source | How Cairn applies it |
|---|---------|--------|----------------------|
| 1 | **Filesystem‑event‑driven index regeneration** | [Waypoint](https://github.com/IdreesInc/Waypoint), [Zoottelkeeper](https://github.com/akosbalasko/zoottelkeeper-obsidian-plugin) — watch `create/rename/move/delete` events, rewrite the parent folder's index deterministically | Cairn's `PostToolUse` hook already does this — on every WAL‑committed write, walk up the parent chain and regenerate `_index.md`. No LLM needed; the structural index is a deterministic scan. **Keep `_summary.md` (semantic, LLM‑generated) separate so the cheap structural regen runs on every write, and the expensive semantic regen only runs on cadence.** |
| 2 | **Deepest‑match folder templates** | [Templater — Folder Templates](https://silentvoid13.github.io/Templater/settings.html) — walk up from the target path, first `_template.md` found wins | On every new‑record write, Cairn resolves the template by walking up from the target path. `wiki/entities/people/carol/interactions.md` → check `people/carol/_template.md`, then `people/_template.md`, then `entities/_template.md`, then `wiki/_template.md`, then root fallback. **Deepest match beats regex lists** — deterministic, diff‑friendly, and agents can reason about it by reading the folder tree. |
| 3 | **PARA‑style top‑level organization as a starter template** | [Tiago Forte's PARA](https://fortelabs.com/blog/para/) — Projects / Areas / Resources / Archives used widely in Obsidian | `cairn init --template para` scaffolds `wiki/projects/` · `wiki/areas/` · `wiki/resources/` · `wiki/archive/` each with a pre‑seeded `_policy.yaml`. Not prescribed, just a starter; teams overrride via `cairn init --template <domain>` (§18.b). |

**Three anti‑patterns to avoid:**

| # | Anti‑pattern | Why | Cairn's alternative |
|---|---------------|-----|---------------------|
| 1 | **Folder‑name‑equals‑file‑name coupling** (Obsidian folder notes: `people/people.md` IS the folder's hub note) | Renaming a folder silently breaks the hub note; Waypoint's own README warns about data loss. Two writers racing on one file clobber each other. | Cairn uses **sidecars** — `_index.md` + `_summary.md` + `_policy.yaml` inside each folder. Cairn owns the sidecars; human edits to other files in the folder never touch them. Folder rename is a simple `git mv`; sidecars move with the folder. We lose Obsidian's graph‑view freebie, but we gain atomic concurrency. |
| 2 | **Magic‑word in‑place rewriting** (`%% Begin Waypoint %% … %% End Waypoint %%` region inside a human‑authored note) | Concurrency trap: the agent, the user, and the hook can all target the same file; splicing into arbitrary markdown is fragile. | Cairn's sidecars are **entirely machine‑owned** and rewritten as atomic whole‑file replaces with `fsync`. The file has no user content to protect. Humans who want to annotate a folder write a separate `notes.md` — never touch `_index.md`. |
| 3 | **UI‑coupled organization** (Dataview query blocks, graph‑view landmarks, plugin‑runtime rendering) | Dataview code fences only render inside Obsidian; `grep`, `cat`, and `git diff` see raw syntax. Any downstream consumer (the agent, the MCP server, a CI checker, a human on a plane) gets unreadable markdown. | **Every Cairn record is pure markdown — parseable without a plugin runtime.** If enrichment is needed, it's baked into the `_summary.md` as plain prose during the workflow pass, not deferred to a renderer. Obsidian users who want Dataview queries can install their own plugin; Cairn never emits them. |

**Naming trade‑off we explicitly accepted.** Obsidian-land convention is `folder-name.md` inside `folder-name/` (the "folder note"). We deliberately chose `_index.md` + `_summary.md` + `_policy.yaml` because:

- sidecars don't rename when the folder renames;
- the `_` prefix sorts them to the top in every file listing (Obsidian + VS Code + raw `ls`);
- machine‑owned names are distinct from any human file the user might want to drop in;
- three separate files decouple cheap structural regen from expensive semantic regen.

Users who migrate from Obsidian can run `cairn import --from obsidian --folder-notes-as <sidecar|keep>` to either (a) absorb the folder‑note into Cairn's `_summary.md` or (b) leave it in place as a plain `<folder-name>.md` record — both work; `_index.md` is generated fresh either way.

---

## 4. Contracts — the Seven That Matter (five P0 + FrontendAdapter P1 + AgentProvider P2)

### 4.0 Overall architecture at a glance

```
                ┌───────────────────────────────────────────────┐
                │   HARNESSES  (CC · Codex · Gemini · custom)   │
                └─────────────────────┬─────────────────────────┘
                                      │  Four surfaces, same 8 verbs (§8.0):
                                      │    CLI (ground truth) · MCP · SDK · skill
                                      │  Verbs: ingest · search · retrieve · summarize
                                      │         · assemble_hot · capture_trace · lint · forget
                                      ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                          CAIRN CORE  (L0, Rust, zero runtime deps)             │
│                                                                                │
│   Seven contracts (traits)             Pipeline (pure functions)               │
│   ─────────────────────────            ──────────────────────────────          │
│   MemoryStore        [P0]◄┐            Extract · Filter · Classify · Scope     │
│   LLMProvider        [P0] │  dispatch  Match · Rank · Consolidate · Promote    │
│   WorkflowOrchestrator[P0]┼──────────► Expire · Assemble · Learn · Propagate   │
│   SensorIngress      [P0] │            Redact · Fence · Lint                   │
│   MCPServer          [P0]◄┘                                                    │
│   FrontendAdapter    [P1]     (opt-in — required when any editor / plugin /    │
│                               GUI edit surface is registered; enables safe     │
│                               reverse-edits via signed ReconcileRequest        │
│                               §13.5.c/d. Headless vaults do not need it.)      │
│   AgentProvider      [P2]     (opt-in — only active when an Agent-mode         │
│                               ExtractorWorker or DreamWorker is configured)    │
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
│          │   │          │    │            │   │            │   │            │
│ P0: pure │   │ (OpenAI- │    │ (tokio     │   │ (hook, IDE,│   │ (Obsidian, │
│  SQLite  │   │ compat.) │    │  default,  │   │  clipboard,│   │  VS Code,  │
│ P1: +    │   │          │    │  Temporal) │   │  screen,   │   │  Logseq,   │
│  Nexus   │   │          │    │            │   │  Slack,    │   │  desktop,  │
│  sandbox │   │          │    │            │   │  GitHub…)  │   │  headless) │
│ P2: +    │   │          │    │            │   │            │   │            │
│  federate│   │          │    │            │   │            │   │            │
└────┬─────┘   └──────────┘    └────────────┘   └─────┬──────┘   └─────┬──────┘
     │                                                │                │
     ▼                                                ▼                ▼
┌───────────────────────────────────────┐     ┌──────────────────┐ ┌────────────────┐
│  <vault>/ (on disk)                   │     │ external systems │ │ third‑party    │
│  ├── sources/    immut.               │     │ (Slack, email,   │ │ editor reads   │
│  ├── raw/        private              │     │  GitHub, Notion, │ │ .md + sidecar; │
│  ├── wiki/  skills/                   │     │  Calendar…)      │ │ optional plug‑ │
│  │           promoted                 │     │                  │ │ in for live UI │
│  ├── .cairn/                          │     └──────────────────┘ └────────────────┘
│  │   ├── cairn.db ◄── P0: records +   │
│  │   │              WAL + replay +    │
│  │   │              consent + locks   │
│  │   │              (ONE SQLite file) │
│  │   ├── config.yaml                  │
│  │   └── consent.log (async mirror)   │
│  └── nexus-data/ ◄── P1+ ONLY         │
│      ├── BM25S lexical index          │
│      ├── sqlite-vec ANN               │
│      ├── CAS blob store               │
│      └── ReDB metastore               │
│      (internal Nexus layout; opaque   │
│       to Cairn — HTTP+MCP only)       │
└───────────────────────────────────────┘
```

**Read this top-down.** Harnesses call one of four surfaces (CLI / MCP / SDK / skill — all wrapping the same eight Rust functions in `src/verbs/`). Core dispatches through pure-function pipelines using the seven contracts (five P0 + FrontendAdapter P1 + AgentProvider P2). Contracts are satisfied by plugins (swap any one via `.cairn/config.yaml`). Plugins touch the outside world: **at P0 only the one SQLite file + the markdown tree**; at P1 Nexus sandbox adds `nexus-data/` alongside AND frontend adapters (Tauri/Electron GUI alpha, Obsidian / VS Code / Logseq plugins) project the DB into editor surfaces via the safe reverse-edit path (§13.5.c/d); at P2 federation adds a remote hub and `AgentProvider` activates for agent-mode workers.

**Everything you'd plug in has a single socket.** Adding Postgres‑backed storage? Implement `MemoryStore`. Adding a Temporal Cloud workflow runner? Implement `WorkflowOrchestrator`. Adding Typora support? Implement `FrontendAdapter` (§13.5.d). No core changes, no forks.

Everything in Cairn is a pure function over data, except these seven interfaces.

| # | Contract | Priority | Purpose | Default implementation |
|---|----------|----------|---------|------------------------|
| 1 | `MemoryStore` | P0 | typed CRUD + ANN + FTS + graph over `MemoryRecord` | **P0 default = pure SQLite** (`.cairn/cairn.db`, FTS5 keyword search, no sidecar, ~15 MB binary, zero deps); **P1 default = Nexus `sandbox` profile** (Python sidecar — BM25S lexical index + `sqlite-vec` ANN + `litellm` embeddings + ReDB metastore + CAS blob store, all under `nexus-data/` alongside the unchanged `.cairn/cairn.db`; ~300–400 MB RSS, <5 s warm boot). **Scale‑up path = federation**, not adapter swap — sandbox instances delegate to a **Nexus `full`** hub zone (PostgreSQL + pgvector + Dragonfly) over HTTP. Every tier talks to its backend through the same `MemoryStore` trait; the P0→P1 jump is a config line (`store.kind: sqlite` → `store.kind: nexus-sandbox`), not a code change. |
| 2 | `LLMProvider` | P0 | one function — `complete(prompt, schema?) → text \| json` | OpenAI‑compatible (local Ollama, any cloud) |
| 3 | `WorkflowOrchestrator` | P0 | durable scheduling + execution for background loops | **Rust‑native default**: `tokio` + a SQLite‑backed job table (durable, crash‑safe, single binary, zero services). **Optional Temporal adapter**: `temporalio-sdk` + `temporalio-client` (both published on crates.io, currently prerelease) when GA; a TypeScript Temporal worker sidecar as the safe path today |
| 4 | `SensorIngress` | P0 | push raw observations into the pipeline | hook sensors (P0); IDE, clipboard, screen (opt‑in), web clip (P1); Slack/email/GitHub (P2) |
| 5 | `MCPServer` | P0 | harness‑facing tools | stdio + SSE; eight core verbs + opt‑in extensions (§8) |
| 6 | `AgentProvider` | **P2** | spawn a constrained sub‑agent for `AgentExtractor` (§5.2.a) / `AgentDreamWorker` (§10.2) / any future agent‑mode worker | **Default**: Cairn ships a minimal loop (`cairn-agent-core` crate) that takes an `AgentIdentity`, a tool allowlist, and a `cost_budget`; runs with `LLMProvider` for the model and `cairn` CLI subprocess calls for read-only tools (`search`, `retrieve`, `lint --dry`). **Optional adapters**: wire in `pi-mono`, a custom in-harness loop, or any external agent runtime by implementing `AgentProvider::spawn(identity, scope, budget) → AgentHandle`. Not required at P0 or P1 — the extractor chain and dream worker default to `llm` / `hybrid` modes which use `LLMProvider` directly. Kicks in only when a deployment opts into `agent` mode for one of those workers. |
| 7 | `FrontendAdapter` | **P1** | project `.cairn/cairn.db` state into whatever an editor / plugin / desktop GUI consumes (markdown + frontmatter, sidecar files, live events), and translate reverse edits back into signed `ReconcileRequest` envelopes (§13.5.d) | **None at P0** — headless vaults need zero frontend adapters; out-of-band markdown edits are re-ingested via `cairn ingest --resync <path>`. **Available at P1**: `cairn-frontend-obsidian`, `cairn-frontend-vscode`, `cairn-frontend-logseq`, and `cairn-frontend-desktop` (Tauri/Electron GUI alpha) — all ship with v0.2 to satisfy the §13 "P1 GUI alpha" promise. All adapters are untrusted library code: they cannot apply edits directly; they emit `ReconcileRequest` with an `IdentityContext` + signed intent envelope that the backend re-verifies, subjects to field-level mutability rules (§13.5.c), runs optimistic version checks on, and either commits or rejects. Multiple adapters can run against the same backend simultaneously. v0.3 promotes selected adapters to GA (see §13). |

Everything else — Extractor, Filter, Classifier, Scope, Matcher, Ranker, Consolidator, Promoter, Expirer, SkillEmitter, HotMemoryAssembler, TraceCapturer, TraceLearner, UserSensor, UserSignalDetector, PropagationPolicy, OrphanDetector, ConflictDAG, StalenessScanner — is a **pure function** with a typed signature. Cairn ships a default implementation for each; users override by pointing `.cairn/config.yaml` at a different function exported from any registered plugin.

### 4.1 Plugin architecture

Cairn is plugin‑first end to end. "Plugin" means exactly one thing: a crate or package that **implements a Cairn contract trait** and registers itself through the shared loader. There is no distinction between "built‑in" and "third‑party" at runtime — Cairn's own `cairn-store-nexus`, `cairn-llm-openai`, and `cairn-sensors-local` crates use the same registration path a third‑party `cairn-store-qdrant` crate would.

**Registry rules:**

- **L0 core (`cairn-core`) has zero implementation dependencies.** It defines traits + types + pure functions, nothing that talks to a network, filesystem, LLM, or workflow engine. L0 compiles with zero runtime deps.
- **Every contract in §4 is a trait.** Seven total: `MemoryStore`, `LLMProvider`, `WorkflowOrchestrator`, `SensorIngress`, `MCPServer` (all P0), plus `FrontendAdapter` (P1 opt-in — required when any editor / plugin / GUI surface is registered; §13.5.d; conformance tests ship with v0.2), plus `AgentProvider` (P2 opt-in — only active when an Agent-mode `ExtractorWorker` or `DreamWorker` is configured). Implementations live in separate crates / packages; plugin registration, capability tiering, and conformance tests are identical across all seven contracts — `FrontendAdapter` is not a special case.
- **Every pure function in the pipeline is a trait + default impl.** `Extractor`, `Classifier`, `Ranker`, `HotMemoryAssembler`, etc. Override any one by naming a different function in `.cairn/config.yaml` under `pipeline.<stage>.function`.
- **Registration is explicit, not magic.** Plugins call `cairn_core::register_plugin!(<trait>, <impl>, <name>)` in their entry point. The host assembles the active set from config at startup. No classpath scanning, no auto‑discovery surprises.
- **Config selects the active implementation.** `.cairn/config.yaml` → `store.kind: sqlite | nexus-sandbox | nexus-full | qdrant | custom:<name>`; `llm.provider: openai-compatible | ollama | bedrock | custom:<name>`; `agent_provider.kind: cairn-core | pi-mono | custom:<name>` (only loaded when an Agent-mode worker is selected); same pattern for every contract.
- **Contracts are versioned.** Each trait declares a `CONTRACT_VERSION`. Plugins declare the range they support. Startup fails closed if versions diverge — never a silent run with a mismatched contract.
- **Capability declaration.** Each plugin publishes a capability manifest (supports streaming? multi‑vault? async? transactions?). `AgentProvider` capabilities additionally include: supported tool allowlist surfaces (CLI subprocess, in-process trait, MCP), scope-tuple enforcement mode, cost-budget honoring (`max_turns` / `max_wall_s` / `max_tokens`). Cairn's pipeline queries capabilities before dispatching — features gracefully degrade (e.g., if the store doesn't support graph edges, `wiki/entities/` still works but backlinks fall back to text search; if the `AgentProvider` doesn't honor `cost_budget`, Agent-mode workers are rejected at startup).
- **Conformance is tested.** `cairn plugins verify` runs the contract conformance test suite against every active plugin. For `AgentProvider`, conformance includes: (a) refuses to invoke a verb outside the configured tool allowlist, (b) aborts cleanly on `cost_budget` exceeded, (c) writes produced by the spawned agent go through §5.6 WAL like every other write — no direct vault mutations.
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

### 4.2 Identity — agents, sensors, actor chains [P0 minimal · P2 full chain]

Multi‑agent collaboration only works if every memory record can answer **who wrote this, who asked for it, on whose behalf**. Cairn treats identity as a first‑class contract, not a string tag.

**Priority split** — the identity model layers just like storage does:

| Piece | Priority | What ships |
|-------|----------|------------|
| Ed25519 keypair per vault in platform keychain (Keychain / Secret Service / DPAPI) | **P0** | single `author` identity per write; signature on every record; no chain |
| Signed envelope schema (operation_id, nonce, sequence, target_hash, issued_at, expires_at, signature) | **P0** | every CLI / MCP / SDK / skill call carries one; replay ledger + atomic consumption in `.cairn/cairn.db` |
| Three identity kinds (`HumanIdentity` · `AgentIdentity` · `SensorIdentity`) | **P0** | each write is tagged as human / agent / sensor; identity kind gates visibility defaults + consent capability |
| `actor_chain` with delegation (principal → delegator → author → sensor) | **P2** | multi-hop signing when one agent spawns another; required once more than one agent writes to the same vault |
| Countersignatures (`attestation_chain`) | **P2** | each actor in the chain signs independently; needed for adversarial-multi-agent and cross-org scenarios |
| `ConsentReceipt` for shared-tier promotions (`private → project → team → org → public`) | **P2** | human signature required to promote any record to `team`+; propagation workflow (§10) depends on this |
| Trust score per identity | **P2** | weights ranker + skill evolution gates; only meaningful once multiple identities have track records |
| Scope tuple + `rebac` integration | **P1 scope · P2 full rebac** | scope tuple lands at P0 on every record; dynamic rebac enforcement arrives with Nexus sandbox |

**At P0 a single user with a single agent doesn't need the chain** — the record carries one `author: agt:claude-code:opus-4-7:v1` signature and one sensor label if applicable. That signature is enough for audit, forget-me, and replay protection. Full delegation, countersignatures, and trust scores only become load-bearing once a vault has more than one agent writing to it concurrently (the multi-agent P2 case).

**Three identity kinds, all stable + verifiable:**

| Kind | Format | How it's provisioned | What signs |
|------|--------|-----------------------|------------|
| `HumanIdentity` | `hmn:<slug>:<rev>` (e.g., `hmn:tafeng:v1`) | OS keychain keypair on first run; SSO/OIDC binding optional | user consent events, memory authored by user, `ConsentReceipt` |
| `AgentIdentity` | `agt:<harness>:<model>:<role>:<rev>` (e.g., `agt:claude-code:opus-4-7:reviewer:v3`) | Ed25519 keypair generated at agent registration; bound to harness + model + role manifest | every memory record the agent writes, every MCP call, every Dream/Reflection workflow run |
| `SensorIdentity` | `snr:<family>:<name>:<host>:<rev>` (e.g., `snr:local:screen:mac-tafeng:v2`) | keypair generated when sensor is first enabled; bound to machine + OS user | every `raw event` the sensor emits |

Every identity keypair lives in the platform keychain (Keychain on macOS, Secret Service on Linux, DPAPI on Windows) — never on disk in plaintext, never synced into the vault.

**Actor chain on every record.** `MemoryRecord` frontmatter carries a typed chain describing the full provenance. What the chain **must** contain depends on priority:

| Priority | Minimum required chain | Filter stage behavior |
|----------|------------------------|------------------------|
| **P0** | Single-entry chain: one `{ role: author, identity: <AgentIdentity \| HumanIdentity>, at: <ts> }` plus `signature` signed by that identity. `attestation_chain` and multi-role entries are **permitted but not required**. | Filter rejects records with **no signature** or **invalid signature**; accepts single-author records without delegation. |
| **P1** | Same as P0 + optional sensor entry for sensor-originated writes (`{ role: sensor, identity: snr:…, at: … }`) | Same as P0, plus: reject writes whose declared sensor label doesn't match a registered `SensorIdentity`. |
| **P2** | Full chain: `principal → delegator* → author → sensor*` with countersignatures in `attestation_chain`. Multi-hop delegation required when one agent spawns another. | Filter rejects (a) records with **no valid author signature**, (b) P2 records with **missing countersignatures** from any actor in the declared chain, (c) records whose chain order violates `principal → delegator* → author → sensor*`. |

**P0 minimum valid example** (single-user, single-agent vault — the v0.1 baseline):

```yaml
actor_chain:
  - { role: author, identity: agt:claude-code:opus-4-7:main:v1, at: 2026-04-23T09:12:04Z }
signature: ed25519:...        # signed by the author's key in the platform keychain
# attestation_chain omitted — only one actor
```

**P2 full example** (multi-agent delegation with countersignatures):

```yaml
actor_chain:
  - { role: principal,  identity: hmn:tafeng:v1,               at: 2026-04-22T14:02:11Z }
  - { role: delegator,  identity: agt:claude-code:opus-4-7:main:v3, at: 2026-04-22T14:02:14Z }
  - { role: author,     identity: agt:claude-code:opus-4-7:reviewer:v1, at: 2026-04-22T14:02:17Z }
  - { role: sensor,     identity: snr:local:hook:cc-session:v1,  at: 2026-04-22T14:02:11Z }
signature: ed25519:...                 # signed by the *author* identity
attestation_chain: [sig1, sig2, sig3]  # countersignatures from each actor
```

**Why a chain (P2) and not just a single `author` field:** multi‑agent systems delegate. A supervisor agent spawns a reviewer agent; the reviewer spawns a critic agent; the critic writes a memory. Every hop is material to trust and auditability. P0 vaults rarely need this because one user + one agent = one author per record; full delegation only becomes load-bearing at P2.

**Flow — how a chained signature is built (P2 write time):**

```
     Human              Supervisor           Reviewer            Critic             Cairn
     (hmn:alice)        agent                agent               agent              MCP server
        │                  │                   │                   │                   │
        │── "review PR" ─▶ │                   │                   │                   │
        │                  │── delegate(PR) ─▶ │                   │                   │
        │                  │                   │── spawn(critic)─▶ │                   │
        │                  │                   │                   │── extract memory  │
        │                  │                   │                   │                   │
        │                  │                   │                   │─ sign(env,        │
        │                  │                   │                   │   role=author,    │
        │                  │                   │                   │   key=critic)     │
        │                  │                   │─ countersign(env, │                   │
        │                  │                   │   role=delegator) │                   │
        │                  │─ countersign(env, │                   │                   │
        │                  │   role=delegator) │                   │                   │
        │── countersign ──▶│                   │                   │                   │
        │  (env,           │                   │                   │                   │
        │   role=principal)│                   │                   │                   │
        │                  │                   │                   │── ingest(env + chain + payload) ─▶│
        │                  │                   │                   │                   │
        │                  │                   │                   │                   │  § 5.2 Filter stage:
        │                  │                   │                   │                   │    1. verify each signature against its key_version
        │                  │                   │                   │                   │    2. verify chain order (principal → delegator* → author → sensor*)
        │                  │                   │                   │                   │    3. verify scope tuple fits each actor's allowed_kinds/allowed_tiers
        │                  │                   │                   │                   │    4. atomic replay check (§4.2 "Atomic replay + ordering")
        │                  │                   │                   │                   │    5. write MemoryRecord with frontmatter.actor_chain + attestation_chain
        │                  │                   │                   │                   │
        │                  │                   │                   │◀── op_receipt ────│
```

**Read-time verification is cheap.** `retrieve` reads the record, walks the chain once, checks each signature against the cached public keys, and returns a typed `chain_status: "valid" | "expired_key" | "revoked" | "broken"`. Only `valid` surfaces through `search`; the other three land in `cairn lint` output for human review. Caller sees the status; they never see records with a broken chain unless they explicitly request them.

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

The two statements run inside one short `BEGIN` transaction. **SQLite in WAL mode serializes all writers on a single database file** — there is exactly one writer at a time, regardless of issuer; readers don't block writers and vice versa, but the write path is a queue. Concurrent submissions from the **same issuer** are serialized in two ways: first by SQLite's file-level write queue, then by the `UPDATE … WHERE high_water < :seq` CAS (if another concurrent request already advanced the high-water mark, RETURNING is empty and the transaction rolls back cleanly). Concurrent submissions from **different issuers** still queue on the file's write lock — they don't deadlock, but their throughput is bounded by the DB's single-writer write throughput. The CAS is per-issuer, so logical contention beyond the file lock is avoided; the file lock itself is the floor.

**Throughput budget (subject to the single-writer floor).** Measured numbers are indicative, not guarantees: on SQLite 3.45 + NVMe, the Bloom filter absorbs > 99 % of replays without entering the transaction, and the transactions that do hit disk commit at p99 < 3 ms. With a single-issuer workload this converts to ~10 k QPS; with writes spread across 50 issuers the same file-lock serialization produces ~10 k QPS aggregate (the number does **not** scale linearly with issuer count — the aggregated 30 k QPS figure previously quoted was wrong about the SQLite concurrency model and has been removed). HDD budgets degrade to p99 ~ 20 ms. Deployments that saturate a single file's write throughput — whether from one hot issuer or many — switch to the `cairn.admin.v1` extension's sharded replay DB (one file per tenant) to exit the single-writer floor. The §15 eval harness runs a replay-ledger benchmark that measures actual sustained QPS on the target deployment's hardware and gates releases on regressions, rather than asserting the numbers here as contract.

**Signature‑first rejection.** Signature verification runs **before** any disk write to `.cairn/cairn.db`. An attacker replaying a valid signature hits step 5's unique constraint; an attacker sending junk never reaches step 5 because signature check rejects first. This prevents ledger pollution by unauthenticated traffic.

**Replay consumption is coupled to WAL `PREPARE`, not independent.** The replay ledger (`used`, `issuer_seq`, `outstanding_challenges`) and the WAL op log (`wal_ops`, `consent_journal`) all live in the same SQLite file — `.cairn/cairn.db` — owned directly by the Rust core (see "Durability topology" in §3). At every tier (P0 / P1 / P2) the **record bodies themselves also live in `.cairn/cairn.db`** — that file is the single authority for record state (§3.0 storage-authority rule). At P1+, Nexus additionally holds derived projections in `nexus-data/` (CAS mirror + BM25S + `sqlite-vec` + ReDB metastore) that are rebuildable from the DB via `cairn reindex --from-db`. Cairn coordinates the DB→Nexus projection via idempotency keys (§5.6), not via a distributed transaction. The transaction below is a single local SQLite commit that atomically couples replay consumption with the WAL `PREPARE` row:

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

Challenge‑mode clients call `cairn handshake` first to receive a fresh `server_challenge` stored in `outstanding_challenges`; each challenge is single‑use with a 60 s TTL. If v0.1 chooses not to ship challenge mode, the `server_challenge` field simply fails validation and only sequence mode is supported — the capability is advertised in `status.capabilities`.

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

## 5. Pipeline — Read, Write, Consolidate [P0]

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
      │                            via CLI or MCP, bounded             │                    │
      │                            to N tokens budget]                 │                    │
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

### 5.0.a Three capture modes — auto, explicit, proactive (all run concurrently)

A single turn can trigger **all three** capture modes at once. Cairn doesn't pick one — the pipeline de‑duplicates at the Filter stage (§5.2), so even overlapping captures produce one final record per concept.

```
                 one user turn enters the system through three paths simultaneously
    ══════════════════════════════════════════════════════════════════════════════════════
                                              │
                ┌─────────────────────────────┼─────────────────────────────┐
                │                             │                             │
                ▼                             ▼                             ▼
     ╔══════════════════╗          ╔══════════════════╗          ╔══════════════════╗
     ║  MODE A: AUTO    ║          ║  MODE B: EXPLICIT║          ║  MODE C:         ║
     ║  (sensor-driven) ║          ║  ("tell it")     ║          ║  PROACTIVE       ║
     ║                  ║          ║                  ║          ║  (agent decides) ║
     ╚══════════════════╝          ╚══════════════════╝          ╚══════════════════╝
     Hook fires on every           User says:                     Agent notices:
       SessionStart                  "remember that I              "this is a novel
       UserPromptSubmit               prefer X"                      entity I haven't
       PreToolUse                   "forget what I                   seen before"
       PostToolUse                    said about Y"                "user corrected me —
       Stop                         "skillify this"                  save as feedback"
                                                                   "this strategy
     Every hook event            The skill (§18.d) or                worked — promote
     becomes a CaptureEvent      "tell it directly"                   to strategy_success"
     signed by the sensor's      triggers (§18.a) route             "I hit an unmet
     SensorIdentity, enters      directly to cairn ingest            prerequisite —
     the pipeline.               with an explicit kind                emit knowledge_gap"
                                 declared by the user.
     ExtractorWorker chain       Goes through the same              Agent invokes
     runs in default order       Filter/Classify/Store              cairn ingest with
     (regex → llm → agent).      as any other capture —             its own AgentIdentity
     Agent has zero               no fast path, no skipping         signature.
     involvement.                 PII redaction.
                │                             │                             │
                └─────────────────────────────┼─────────────────────────────┘
                                              │
                                              ▼
                            ┌──────────────────────────────────┐
                            │  SAME INGESTION PIPELINE §5.2    │
                            │  Extract → Filter → Classify →   │
                            │  Scope → Store (§5.6 WAL upsert) │
                            │                                   │
                            │  Filter stage de-dupes across     │
                            │  modes — if all three paths       │
                            │  captured "user prefers dark      │
                            │  mode" in one turn, one record    │
                            │  lands, attributed to the         │
                            │  highest-authority actor.         │
                            └──────────────────┬────────────────┘
                                               │
                                               ▼
                                    same MemoryStore, same vault
```

**Which mode fires when:**

| Scenario | Mode A auto | Mode B explicit | Mode C proactive | Why |
|----------|-------------|------------------|-------------------|-----|
| User types a message | ✓ (hook captures raw msg) | — | ✓ (agent may re‑emit as `user` or `feedback` kind) | hook always fires; proactive is judgment |
| User says "remember that …" | ✓ (hook captures raw msg) | ✓ (skill trigger matches) | — | explicit wins; agent doesn't also re‑remember |
| Tool call completes | ✓ (PostToolUse hook) | — | ✓ (agent may emit `trace` child or `strategy_success`) | hook is automatic; proactive records the meaning |
| Novel entity encountered | ✓ (hook captures raw transcript) | — | ✓ (agent emits `entity` record) | user isn't thinking about memory; agent decides |
| User corrects the agent | ✓ (hook captures msg) | — | ✓ (agent emits `feedback` with high confidence) | correction is high‑salience; agent should capture |
| Ad‑hoc success worth reusing | ✓ (hook captures trace) | may say "skillify this" | ✓ (agent may emit `strategy_success` on its own) | explicit accelerates; proactive catches what user forgets |
| Session ends | ✓ (Stop hook → `capture_trace`) | — | ✓ (agent may emit session summary) | both run; rolling summary consolidates downstream |

**Mode composition — none of these modes requires the other two:**

- **Minimum Cairn (no agent cooperation):** only Mode A runs. Hooks fire, `ExtractorWorker` chain produces drafts, pipeline stores them. A harness that does nothing beyond loading the MCP server still gets a functional memory.
- **Explicit only:** a user who disables hooks and only types "remember …" still gets durable memory via Mode B. Works in any bash-capable harness via the skill.
- **Proactive only:** an agent with strong self-awareness may choose to call `cairn ingest` at key moments without waiting for hooks. Uncommon in P0 but common in P2 (AgentExtractor as the default extractor).

**Who records what — the attribution rule:**

Every record's `actor_chain` (§4.2) names the actual author. Mode A records are authored by the sensor (`snr:local:hook:cc-session:v1`); Mode B records are authored by the user (`hmn:alice:v1`) with the agent as delegator; Mode C records are authored by the agent (`agt:claude-code:opus-4-7:main:v3`). An auditor reading `consent.log` + `actor_chain` can reconstruct which mode fired for any record.

### 5.0.b Auto-learning loop — how raw capture becomes durable skill

Capturing isn't the same as learning. Raw `trace` records are dead bytes until a workflow distills them into reusable knowledge. Three workflows, running off-request, do this automatically:

```
     RAW CAPTURE (the last 24 h of trace + turn + reasoning records)
                                │
                                ▼
          ┌──────────────────────────────────────────────────┐
          │  ConsolidationWorkflow (rolling summary, P0)     │
          │  every N turns, emit a `reasoning` record        │
          │  summarizing window_size_turns worth of history  │
          │  → lets assemble_hot load meaning, not raw turns │
          └──────────────────┬───────────────────────────────┘
                             ▼
          ┌──────────────────────────────────────────────────┐
          │  ReflectionWorkflow (P1)                         │
          │  mid-depth pass — hourly or on high-salience     │
          │  identifies repeated patterns:                   │
          │    - same tool error recurring → knowledge_gap   │
          │    - novel entity appeared → entity_candidate    │
          │    - user corrected agent 3× same way → rule     │
          │  emits new records as candidates for promotion   │
          └──────────────────┬───────────────────────────────┘
                             ▼
          ┌──────────────────────────────────────────────────┐
          │  ACE — SkillEmitter (P1, trajectory→playbook)    │
          │  nightly DeepDream: scans successful trajectories│
          │  distills them into `playbook`/`strategy_success`│
          │  records. This is where one successful ad-hoc    │
          │  procedure becomes a reusable skill.             │
          │  Example: user + agent solved a deploy issue in  │
          │  6 steps → SkillEmitter produces                 │
          │  `skill_deploy-hotfix_v1.md` + its scripts+tests │
          │  via Skillify pipeline (§11.b stage 2).          │
          └──────────────────┬───────────────────────────────┘
                             ▼
          ┌──────────────────────────────────────────────────┐
          │  EvolutionWorkflow (P2)                          │
          │  mutates existing skills based on new traces:    │
          │  A/B proposals + §11.3 nine-gate promotion       │
          │  predicate + canary rollout before going live.   │
          └──────────────────┬───────────────────────────────┘
                             ▼
                   ┌──────────────────────┐
                   │  durable skills +    │
                   │  cleaner summaries + │
                   │  auto-built user     │
                   │  profile (§7.1)      │
                   └──────────────────────┘
```

**So the answer to "who decides what to remember":**

- **The user never has to** — hooks + `ExtractorWorker` + ConsolidationWorkflow keep working in the background.
- **The user can always override** — `remember that …` and `skillify this` bypass classifier heuristics and force immediate capture.
- **The agent should do the hard judgment calls** — which `trace` records deserve an `entity` promotion, which `feedback` warrants a `rule`, which ad‑hoc success is worth `strategy_success`.

Cairn provides the tooling for all three; deployments tune the balance via `.cairn/config.yaml`:

```yaml
capture:
  mode_a_hooks: enabled       # default P0
  mode_b_explicit: enabled    # default P0 (skill triggers)
  mode_c_proactive:
    enabled: true             # default P0 (agent has cairn CLI/MCP access)
    encouragement: strong     # one of: off | weak | strong
                              # strong: agent sees "capture this" hints in
                              # its system prompt whenever a novel entity,
                              # rule, or success is detected
```

---

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
| **Extract** | distillation of experiences, facts, preferences, skills into `MemoryRecord` drafts — runs through the pluggable `ExtractorWorker` trait (§5.2.a) with three built‑in modes: regex (P0), LLM (P0), agent (P2) | `ExtractorWorker` trait |
| **Filter (Memorize?)** | decide `yes` (proceed) or `no` (discard). Discard reasons are first‑class and logged: `volatile`, `tool_lookup`, `competing_source`, `low_salience`, `pii_blocked`, `policy_blocked`, `duplicate`. Also handles PII redaction (Presidio) and prompt‑injection fencing before the yes branch | `shouldMemorize` + `redact` + `fence` |
| **Classify & Scope** | kind (19) × class (4) × visibility (6) × scope → keyspace; emits `ADD / UPDATE / DELETE / NOOP` decision. Kind cardinality is generated from the single IDL (§13.5) — a CI check fails on drift across sections, examples, and validators | `classifyAndScope` |
| **Memory Store upsert** | persist with provenance; write index + cache entries | `MemoryStore.upsert` (contract) |

Capture → Memory Store is **always on‑path** and bounded — p95 < 50 ms including hot‑memory re‑assembly on high‑salience writes.

### 5.2.a ExtractorWorker — pluggable dispatch modes

The **Extract** stage is on the hot path of every turn (unlike DreamWorker which runs off‑path). Cost and latency matter more than for dreaming. Cairn ships three built‑in implementations on one `ExtractorWorker` trait; deployments pick per write‑kind so you can use regex for noisy high‑volume sensors, LLM for mainline capture, and an agent for the rare "this turn is worth deeply reasoning about" event.

```rust
// L0 trait — zero deps, pure data over in/out
pub trait ExtractorWorker: Send + Sync {
    fn name(&self) -> &'static str;                 // "regex" | "llm" | "agent" | custom
    fn budget(&self) -> ExtractBudget;              // tokens, wall-clock, tool calls
    async fn extract(&self, event: &CaptureEvent) -> Vec<MemoryDraft>;
}
```

**The three built‑ins + when to pick each:**

| Mode | How extraction runs | Cost | Latency | Right default for | Priority |
|------|----------------------|------|---------|--------------------|-----------|
| **`RegexExtractor`** | pattern‑matches the event against declared rules (pre‑compiled regex + small state machine per `MemoryKind`). No LLM, no network. | ~0 | p99 < 2 ms | sensor events with predictable shape (hook payloads, tool call frames, "user says X" triggers from §18.a) | **P0** — always on |
| **`LLMExtractor`** | single prompted LLM call with a structured schema (`{kind, body, entities, confidence}`). Schema enforced via `LLMProvider`'s JSON mode. | ~1 model call × ≤ 2 KB prompt | p95 < 400 ms | mainline turn capture: free‑form user messages, agent reasoning traces, novel entities/facts | **P0** — default for turn capture |
| **`AgentExtractor`** | invokes a full Cairn agent with read‑only tools (`search`, `retrieve`, `lint --dry`) in a short multi‑turn loop. Agent can corroborate against existing records before drafting, call deterministic scripts for parsing, iterate on ambiguous input. | 5–20× LLM cost; tool calls metered | unbounded unless capped — cap via `budget.max_turns` + `max_wall_s` | high‑stakes captures where extraction accuracy matters more than latency: `rule`/`playbook`/`opinion` kinds, adversarial sources, domain‑specific extraction | **P2** — opt‑in |

**Contract rules (all three modes obey):**

- Every mode produces the **same `MemoryDraft` vector** — identical schema, identical downstream `Filter → Classify → Store` pipeline. An agent extraction is indistinguishable from a regex extraction after serialization.
- Every mode respects `budget` — exceeding it returns `ExtractBudgetExceeded`, the event falls through to the next extractor in the chain (or to `RegexExtractor` as last‑resort fallback).
- **No extractor writes to the vault directly.** The draft flows through §5.6 WAL `upsert` like every other write. An agent cannot skip the Filter stage, PII redaction, or classification.
- **Agent mode shells out to the same `cairn` CLI** as external callers — not an "internal MCP server." The `AgentExtractor` is a Cairn agent whose tool set is literally `bash(cairn search …)`, `bash(cairn retrieve …)`, `bash(cairn lint --dry …)`. Same binary, same policy gates, same signed‑envelope requirement (with the extractor's own `agt:cairn-extractor:v1` identity). One thing to test, one thing to secure, one thing to observe; stdout lands in the harness log stream like any other command.
- Agent mode's CLI commands are **read‑only by default**. An `AgentExtractor` that tries to invoke `cairn ingest` or `cairn forget` is rejected at the signed‑envelope layer — the extractor's scope tuple (§4.2) forbids mutating verbs. The binary knows the caller is an extractor from the signed `issuer` field.

**Chained extractors — the real deployment:**

```
  capture event ──►  RegexExtractor       ──► matched kind? ──► draft list
                     (first pass, <2 ms)          │ no
                                                   ▼
                     LLMExtractor          ──► structured output ──► draft list
                     (P0 mainline)                 │ confidence < 0.6
                                                   ▼
                     AgentExtractor        ──► multi-turn reasoning ──► draft list
                     (P2 opt-in, only for selected kinds or low-confidence events)
```

Each stage is a function call in the extract chain, configured per vault:

```yaml
# .cairn/config.yaml
pipeline:
  extract:
    chain:
      - worker: regex              # P0 always
        kinds: [trace, sensor_observation, user_signal]
      - worker: llm                # P0 default for turn capture
        kinds: [user, feedback, rule, playbook, reasoning, strategy_success]
        model: ${LLM_MODEL:-gpt-4o-mini}
        budget: { max_tokens: 2000, max_wall_ms: 500 }
      - worker: agent              # P2 opt-in, only for flagged events
        trigger: confidence_below  # 0.6 threshold
        agent_profile: cairn-extractor:v1
        budget: { max_turns: 6, max_wall_s: 30 }
```

**Why three modes and not "pick one":** the real‑world reference systems each picked a different point on this spectrum for *extraction*, and each picked correctly for their use case:

| Reference system | Extraction mode | Why |
|-------------------|-------------------|-----|
| **Hindsight / hermes‑agent** | `llm` — `post_llm_call` hook fires structured extraction with a fixed prompt | single‑tenant personal agent; latency budget matters; works well for entity + fact extraction |
| **opencode** | `regex`‑equivalent — structured "parts" with typed fields; no LLM extraction on session writes | sessions store raw exchanges verbatim; extraction happens only at compaction time, not at capture |
| **gbrain** | `agent`‑equivalent — skills dispatched as subagents can enrich + cross‑reference before drafting | personal knowledge‑base; 10k+ files; extraction accuracy compounds over months, worth the cost |

Cairn supports all three behind the same `ExtractorWorker` trait. Default `regex + llm` chain at P0; add `agent` at P2 for the kinds where accuracy matters more than 400 ms of latency. **Switching modes is a config line; the record schema, WAL, and pipeline are identical.**

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
- Every stage is a pure function that takes `MemoryRecord[]` (or a `Query`) and returns `MemoryRecord[]` (+ side effects through one of the six contracts: `MemoryStore`, `LLMProvider`, `WorkflowOrchestrator`, `SensorIngress`, `MCPServer`, or `AgentProvider` when Agent-mode workers are configured).
- Any stage can fail without losing data; the `WorkflowOrchestrator` (default tokio + SQLite; Temporal optional in v0.2+) replays from the last persisted step.
- Discard is **never silent** — every `no` from Filter writes a row to `.cairn/metrics.jsonl` with the reason code.

### 5.5 Plan, then apply

Every write path run produces a **FlushPlan** before any bytes hit the `MemoryStore`. A FlushPlan is a typed, serializable object listing the concrete upserts / deletes / promotions / expirations it would apply and why. The `apply` step is a pure function from `FlushPlan → side effects`.

| Mode | Behavior |
|------|----------|
| `autonomous` (default) | Capture → … → Plan → apply inline, same turn |
| `dry_run` | Plan returned via `cairn ingest --dry-run` (CLI) or `ingest(dry_run: true)` (MCP); no writes |
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

**Transitions at P0 (single-transaction model)** — the FSM progresses strictly through its states, but because there is only one storage system (SQLite), `ISSUED → PREPARED → COMMITTED` typically collapses into **one `BEGIN IMMEDIATE; … COMMIT;`** that writes all state markers together with every side-effect (records / FTS / edges / consent_journal / lock_holders). `PREPARED → ABORTED` at P0 is reachable only via `ISSUED → REJECTED` (validation failure in the same txn) — there is no "partial side effects, now compensate" window at P0.

**Transitions at P1+ (two-transaction durable-messaging model)** — `PREPARED` becomes observable at rest between the two local transactions sandwiching the Nexus HTTP apply call (§3.0 P1 flow); compensation paths and supervisor crash recovery activate.

| Transition | Requires | What happens |
|------------|----------|--------------|
| `ISSUED → PREPARED` | signature valid, idempotency key unused, principal/issuer policy ok, locks acquired (see below) | writes `PREPARE <op>` marker in `wal_ops`. **P0: same txn as side-effects.** **P1+: first local txn, before Nexus HTTP apply.** Locks held under `(scope, entity_id)`. |
| `PREPARED → COMMITTED` | **P0:** all side-effects (records / FTS / edges / consent_journal) committed atomically in the same txn that wrote `PREPARE`. `.cairn/consent.log` file is updated by the async `consent_log_materializer` — never on the request path. **P1+:** Nexus HTTP apply returned success, then a second local txn flips `wal_ops.state = COMMITTED` and appends `consent_journal` atomically. | writes `COMMIT <op>` marker; releases locks |
| `PREPARED → ABORTED` | **P1+ only** (P0 has no PREPARED-at-rest): Nexus HTTP apply failed, probe confirmed Nexus did not apply the op (idempotency-keyed). | compensating ops run (delete partial local rows, remove local tracking state); writes `ABORT <op>` marker; releases locks |
| `ISSUED → REJECTED` | signature invalid / idempotency key reused / policy deny | writes `REJECT <op>` + reason; no locks ever taken |

**Idempotency.** `operation_id` is the idempotency key — second `PREPARE` with the same id returns the first commit's outcome without re‑doing side effects. Third‑party writers collide safely on retries; broken networks can't double‑apply.

**Lock granularity and compatibility matrix — implemented as a lock table, not advisory.** SQLite does not provide cross‑process row‑level advisory locks, so Cairn implements lock acquisition as ordinary inserts/updates inside `.cairn/cairn.db`, protected by the SQLite write serialization. The lock state is **split across two tables** so shared holders can be fenced individually without invalidating their peers:

```sql
-- Per-scope row: one row per (scope_kind, scope_key). The row tracks the
-- mode of the currently-held lock and the generation counter used to
-- invalidate ALL holders at once (mode conversion, abandoned-lease reclaim).
CREATE TABLE locks (
  scope_kind        TEXT NOT NULL,     -- 'entity' | 'session'
  scope_key         TEXT NOT NULL,     -- "(tenant, workspace, entity)" or "(tenant, workspace, session)"
  mode              TEXT NOT NULL,     -- 'shared' | 'exclusive' | 'free' (= no holders)
  holder_count      INTEGER NOT NULL,  -- number of live holders (exclusive ⇒ at most 1; free ⇒ 0)
  epoch             INTEGER NOT NULL,  -- monotonic counter; bumped ONLY on reclaim or mode conversion,
                                       -- NEVER on heartbeat. Invalidates ALL holders as a group.
  waiters           BLOB,              -- small queue of pending acquirers
  last_heartbeat_at INTEGER,           -- wall-clock ms — LOG-ONLY, never read by fencing path
  PRIMARY KEY (scope_kind, scope_key)
);

-- Per-holder row: one row per live holder. Holder-level liveness is tracked
-- here so one shared holder's heartbeat never touches another holder's row.
CREATE TABLE lock_holders (
  scope_kind        TEXT NOT NULL,
  scope_key         TEXT NOT NULL,
  holder_id         TEXT NOT NULL,     -- per-holder fencing token (ULID), stable for this holder's lifetime
  acquired_epoch    INTEGER NOT NULL,  -- value of locks.epoch when this holder acquired; frozen for life
  owner_incarnation TEXT NOT NULL,     -- daemon incarnation token — ULID minted fresh on every daemon startup,
                                       -- stored in a singleton row of `daemon_incarnation` (see below). All holders
                                       -- admitted by this daemon carry its incarnation. A SIGKILL/restart mints a NEW
                                       -- incarnation, so prior-incarnation rows are definitionally stale even in the
                                       -- same OS boot session.
  boot_id           TEXT NOT NULL,     -- OS boot identity at acquisition — distinguishes lease clocks across host reboots
                                       -- (Linux: /proc/sys/kernel/random/boot_id; macOS: sysctl kern.bootsessionuuid;
                                       --  Windows: GetTickCount64 + session guid).
  reclaim_deadline  INTEGER NOT NULL,  -- deadline for THIS holder, in BOOTTIME-nanoseconds (CLOCK_BOOTTIME on Linux,
                                       -- mach_absolute_time on macOS, QueryUnbiasedInterruptTime on Windows) — persistable,
                                       -- monotonic across suspend/resume. Refreshed by heartbeat. Valid ONLY when
                                       -- lock_holders.boot_id matches the current process's boot_id AND
                                       -- lock_holders.owner_incarnation matches the current daemon's incarnation.
  PRIMARY KEY (scope_kind, scope_key, holder_id),
  FOREIGN KEY (scope_kind, scope_key) REFERENCES locks(scope_kind, scope_key)
);

-- Singleton row holding the current daemon's incarnation token. Rewritten on every daemon startup.
CREATE TABLE daemon_incarnation (
  only_one     INTEGER PRIMARY KEY CHECK (only_one = 1),
  incarnation  TEXT    NOT NULL,    -- fresh ULID per startup
  boot_id      TEXT    NOT NULL,    -- OS boot_id captured at startup
  started_at   INTEGER NOT NULL     -- BOOTTIME-ns at startup
);
```

**Durable lease clock — `boot_id` + `owner_incarnation` + `BOOTTIME` nanoseconds, not `std::time::Instant`.** `std::time::Instant` cannot be persisted across process restarts, so lock state uses three stacked identity fields:

1. `boot_id` — OS boot identity, changes on host reboot. Invalidates all leases after reboot.
2. `owner_incarnation` — daemon incarnation token minted fresh on every daemon startup. Invalidates all leases after a daemon SIGKILL/restart even within the same OS boot (the review's Finding 3 case).
3. `reclaim_deadline` — BOOTTIME-ns monotonic clock, stable across suspend/resume within a boot session.

Daemon startup runs **crash recovery as a single recovery transaction** before accepting any new acquisition:

```sql
BEGIN IMMEDIATE;
  -- Mint new incarnation + capture current boot_id.
  INSERT OR REPLACE INTO daemon_incarnation (only_one, incarnation, boot_id, started_at)
    VALUES (1, :new_incarnation_ulid, :current_boot_id, :now_boottime);
  -- Reclaim every holder that belonged to a prior boot OR a prior daemon incarnation.
  -- This is the same DELETE the acquisition protocol uses to GC live zombies,
  -- run once at startup over the full lock_holders table.
  DELETE FROM lock_holders
    WHERE boot_id != :current_boot_id
       OR owner_incarnation != :new_incarnation_ulid;
  -- Bump epoch on every `locks` row whose holders we just cleared, so any in-flight
  -- chunk CAS from a prior-incarnation process fails closed on its next commit attempt.
  UPDATE locks
    SET epoch = epoch + 1
    WHERE (scope_kind, scope_key) IN (
      SELECT DISTINCT scope_kind, scope_key FROM lock_holders_orphaned -- materialized from the DELETE
    );
COMMIT;
```

After this transaction the daemon is ready to serve. Every subsequent acquisition / heartbeat / fencing CAS also filters by `owner_incarnation = :current_incarnation` (in addition to `boot_id`), so there is **no window — not across host reboot, not across daemon restart within the same boot — where a prior-incarnation holder can prevent a new acquirer from reclaiming a lock** or complete a write after recovery.

Cairn defines two lock scopes: entity locks `(tenant, workspace, entity_id)` and session locks `(tenant, workspace, session:<id>)`. Every write acquires an entity lock in exclusive mode; a write that carries a `session_id` in its scope **also** acquires the session lock in **shared** mode. `forget_session` acquires the session lock in **exclusive** mode for the full Phase A (§5.6 delete row).

**Acquisition protocol (one SQLite transaction per lock).** The transaction garbage-collects expired `lock_holders` rows before deciding mode compatibility, so a shared lock whose only remaining live holders are zombies is correctly seen as `free`:

```sql
BEGIN IMMEDIATE;
  -- 0) (Runs once per daemon startup, NOT per acquisition): on startup, before
  --    accepting any acquisition, DELETE FROM lock_holders WHERE boot_id != :current_boot_id.
  --    This reclaims every lease left behind by a prior boot.

  -- 1) Garbage-collect dead holders — stale-boot, prior-incarnation, or expired-deadline.
  DELETE FROM lock_holders
    WHERE scope_kind = ? AND scope_key = ?
      AND (boot_id != :current_boot_id
           OR owner_incarnation != :current_incarnation
           OR reclaim_deadline < :now_boottime);

  -- 2) Recompute live-holder count.
  SELECT mode, epoch, COUNT(h.holder_id) AS live
    FROM locks l
    LEFT JOIN lock_holders h USING (scope_kind, scope_key)
    WHERE l.scope_kind = ? AND l.scope_key = ?
    GROUP BY l.scope_kind, l.scope_key;

  -- 3) Decide.
  -- a) No row yet: INSERT locks(epoch=1, mode=:wanted, holder_count=1);
  --    INSERT lock_holders(holder_id=:new_ulid, acquired_epoch=1, owner_incarnation=:current_incarnation, boot_id=:current_boot_id, reclaim_deadline=:now_boottime+lease).
  -- b) live=0 (all holders GC'd OR natural release): treat as free.
  --    UPDATE locks SET epoch = epoch + 1, mode = :wanted, holder_count = 1;   -- epoch bump = reclaim
  --    INSERT lock_holders(holder_id=:new_ulid, acquired_epoch=new_epoch, owner_incarnation=:current_incarnation, boot_id=:current_boot_id, reclaim_deadline=:now_boottime+lease).
  -- c) live>0 AND mode == :wanted AND :wanted == 'shared': compatible, no reclaim.
  --    UPDATE locks SET holder_count = live + 1;                               -- epoch UNCHANGED
  --    INSERT lock_holders(holder_id=:new_ulid, acquired_epoch=current_epoch, owner_incarnation=:current_incarnation, boot_id=:current_boot_id, reclaim_deadline=:now_boottime+lease).
  -- d) live>0 AND mode != :wanted (incompatible): return WAIT;
  --    caller enqueues in waiters and retries with exponential backoff.
COMMIT;
```

Every `:now_boottime` above is `CLOCK_BOOTTIME` nanoseconds on Linux, `mach_absolute_time` (converted to nanoseconds via `mach_timebase_info`) on macOS, and `QueryUnbiasedInterruptTime` on Windows — each of these keeps counting across suspend/resume and can be read back by the same process or a successor process within the same boot session, which is what makes the deadline persistable.

**Epoch bumps ONLY on reclaim or mode conversion — never on heartbeat.** This is the fix that makes shared locks coherent: when ten readers hold the session lock in shared mode and one heartbeats, the heartbeat touches only that reader's `lock_holders` row, never the parent `locks.epoch`. The other nine readers' cached `(holder_id, acquired_epoch)` pair stays valid. Epoch advances exactly when a new acquirer must invalidate the whole group (all holders are zombies, or an exclusive acquirer is taking over after all shared holders dropped) — which is precisely when invalidating "ALL holders" is the correct behavior. NTP jumps, DST changes, suspend/resume, and container clock drift cannot alter the epoch counter — the only thing that bumps it is a SQLite commit that went through this protocol.

**Heartbeat protocol (holder-scoped, never touches `locks.epoch`).**

```sql
BEGIN IMMEDIATE;
  UPDATE lock_holders
    SET reclaim_deadline = :now_boottime + :lease_duration_ms
    WHERE scope_kind = ? AND scope_key = ? AND holder_id = :my_holder_id
      AND boot_id = :current_boot_id
      AND owner_incarnation = :current_incarnation
      AND reclaim_deadline >= :now_boottime;  -- refuse to revive a zombie, stale-boot, or prior-incarnation lease
  -- If 0 rows updated: this holder has already been GC'd; stop heartbeating,
  -- abort any in-flight work (the epoch CAS below will reject it anyway).
  UPDATE locks
    SET last_heartbeat_at = :now_wall_clock    -- LOG-ONLY; not read by any fencing path
    WHERE scope_kind = ? AND scope_key = ?;
COMMIT;
```

**Per‑holder fencing — each holder caches its own `(holder_id, acquired_epoch)`.** The Rust core caches this pair at acquisition and re‑asserts it on every chunk:

```sql
BEGIN IMMEDIATE;
  -- Fencing CAS: both the group epoch and THIS holder's liveness must still be valid.
  SELECT
    (SELECT epoch FROM locks
        WHERE scope_kind = ? AND scope_key = ?) AS current_epoch,
    EXISTS (SELECT 1 FROM lock_holders
        WHERE scope_kind = ? AND scope_key = ? AND holder_id = :cached_holder_id
          AND acquired_epoch = :cached_acquired_epoch
          AND boot_id = :current_boot_id
          AND owner_incarnation = :current_incarnation
          AND reclaim_deadline >= :now_boottime) AS still_live;
  -- Abort if current_epoch != :cached_acquired_epoch OR still_live = 0.
  -- This rejects: (a) the group was reclaimed (epoch advanced), OR
  -- (b) this specific holder was GC'd (heartbeat missed), OR
  -- (c) someone else stole this holder_id (would need same acquired_epoch — impossible).
  -- ... chunk's mutation statements ...
COMMIT;
```

A zombie worker cannot commit a chunk: if a new acquirer already reclaimed the row, the epoch advanced, the CAS fails, the transaction rolls back, the zombie self‑aborts. If only this specific holder got GC'd (its own heartbeat missed while peers are still alive), the `still_live` predicate fails while `current_epoch` stays put — the zombie aborts without disturbing its peers. Heartbeats fire every 10 s and extend only the caller's own `reclaim_deadline`; a chunk takes at most `max_chunk_duration` (default 500 ms) so the heartbeat cadence keeps this holder's row alive across all its chunks. No two holders produce durable mutations — the per‑holder CAS is the single choke point.

**`max_chunk_duration` is enforced by counting SQLite commits on the holder's own lock row**, not by wall‑clock. A concurrency test asserts the invariant "no chunk commits after a newer epoch has been published OR after this holder's own row was GC'd" across synthetic clock‑skew + NTP‑step schedules; this test is part of the §15 gate.

This is the Martin Kleppmann / Chubby fencing pattern applied to the single lock authority (Rust‑owned `.cairn/cairn.db`) at chunk granularity, extended with per-holder tokens so shared locks scale without a spurious-invalidation tax.

**Crash recovery — three layers.**
1. *In-incarnation crash* (a holder process dies, but the daemon keeps the same incarnation): the dead holder's `reclaim_deadline` passes; the next acquirer's protocol Step 1 (GC) deletes the zombie row, Step 3 either reclaims (bumping `epoch` only if live count drops to 0 or mode conversion is needed) or silently absorbs the slot. Any in‑flight writes from the crashed holder are rejected by the per-holder CAS — the `still_live` predicate fails the instant its `lock_holders` row is deleted.
2. *Daemon restart within the same boot* (daemon SIGKILL / crash / operator restart; OS `boot_id` unchanged): the new daemon mints a fresh `owner_incarnation` ULID and runs the startup recovery transaction (shown above). Every prior-incarnation `lock_holders` row is deleted and every affected `locks.epoch` is bumped in one transaction before the daemon accepts new acquisitions. A pre-restart holder cannot successfully run its fencing CAS after the new daemon comes up because the `still_live` predicate now requires `owner_incarnation = :current_incarnation` — closing the Finding-3 gap where same-boot restarts previously left live-looking holders behind.
3. *Host restart*: `boot_id` additionally changes, so `BOOTTIME` values from the prior boot are invalidated by the same recovery transaction (the DELETE filter is `boot_id != :current_boot_id OR owner_incarnation != :current_incarnation`).

The concurrency invariant test in §15 includes three restart schedules covering all three layers: (a) holder-only crash mid-chunk, (b) daemon SIGKILL + restart mid-`forget_session`, (c) host reboot mid-chunk. All three must prove (i) every prior holder is reclaimable by the next acquirer, (ii) no pre-crash zombie commits any chunk after recovery, and (iii) `forget_session`'s exclusive lock can be re-acquired or completed after the restart.

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
| `forget_record` (single-record delete, v0.1) | **Phase A — record-scoped tombstone commit, no session fence:** 1. `primary.mark_tombstone` — in one SQLite transaction: `UPDATE records SET tombstoned = 1 WHERE target_id = :target_id`, insert into `consent_journal`. The tombstone is set on **every version** of the same `target_id`, not just the active one, so no superseded body or edges survive Phase A via version history. Sibling turns in the same session are **not** affected — only this `target_id` disappears from reader queries, which now filter `WHERE active = 1 AND tombstoned = 0`. **Phase B — physical purge across all retention surfaces (child ops, terminal and irreversible):** 2. `vector.drain` — delete sqlite-vec rows for every `record_id WHERE target_id = :target_id` → 3. `fts.drain` — delete FTS5 rows for the same set → 4. `edges.drain` → 5. `primary.purge` — `DELETE FROM records WHERE target_id = :target_id` (all versions) → 6. `wal.purge_pre_images` — scan `wal_ops` / `wal_steps` for any row whose `pre_image` blob references this `target_id` and zero the blob (replacing with a salted-hash stub preserving only auditable metadata: `{target_id_hash, purged_at, op_id}`) → 7. `snapshot.purge` — for every cold-storage snapshot referenced by `ExpirationWorkflow` (`nexus-data/` CAS mirror, hub Postgres projection, `.cairn/snapshots/YYYY-MM-DD/`), run the idempotent bundle rewrite that excludes this `target_id`; bundle rewrites are chunked and retriable. `forget_record` is **not committed-terminal** until step 7 completes — the `wal_ops.state = COMMITTED` transition for a forget op requires every Phase B child to reach DONE. `PURGE_PENDING` flagged in `lint` with operator escalation on exhausted retries; the fence remains closed. | on abort **before step 1**: no state change. On abort **at step 1**: SQLite txn rolls back, no partial state. After step 1: Phase A is durable; Phase B steps 2–7 retried idempotently. No `reader_fence` is ever opened for `forget_record`, so session siblings remain visible throughout the delete. **Audit invariant**: `forget_record(target_id)` must leave no original body, frontmatter, index entry, graph edge, pre-image, or bundle copy of `target_id` in `.cairn/cairn.db`, `nexus-data/`, or `.cairn/snapshots/` after step 7; only salted-hash audit metadata and the `consent_journal` row remain. §15 includes a raw-file-grep invariant test: after forget, no tokenization of the deleted body appears anywhere in the vault's on-disk state. |
| `forget_session` (whole-session fan-out, v0.2) | **Phase A — session-scoped fan-out with fence:** 1. `session.fence.open` — insert a row into the `reader_fence` table with `(scope_kind='session', scope_key=session_id, op_id, state='tombstoning')`; **the fence only shields readers scanning this specific session_id** — every read plan joins on `reader_fence` filtered by `scope_kind/scope_key`, so record-level forgets on other scopes are not affected → 2. `primary.mark_tombstone` — in `forget_chunk = 1024`-sized transactions, set `tombstoned = 1` on **every version** of every child `target_id` in the session; on the last chunk only, close the fence inside the same transaction by flipping `reader_fence` to `state='closed'` and appending to `consent_journal`. From this transaction onward, readers neither see the session's children directly nor fall through the fence. **Phase B — physical purge across all retention surfaces (same 6-step pipeline as `forget_record`, fan-out per child `target_id`):** for every child in the session run: 3. `vector.drain` → 4. `fts.drain` → 5. `edges.drain` → 6. `primary.purge` (all versions) → 7. `wal.purge_pre_images` → 8. `snapshot.purge`. `forget_session` is not committed-terminal until every child has reached DONE on step 8. | on abort **before the fence-close chunk of step 2**: drop all tombstones written in earlier chunks, delete the `reader_fence` row; readers revert to seeing the session. On abort **after the fence-close chunk**: Phase A is durable; Phase B retried idempotently across every child; `PURGE_PENDING` flagged in `lint` on final retry failure. Bound Phase A duration by `forget_chunk` (default 1024) × per-row write cost; backpressure exposed via `estimated_phase_a_ms`. Same audit invariant as `forget_record`, applied per child. |
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

### 5.7 Sessions are trees, not logs [P2]

Most agent memory systems model a session as a flat append‑only log. Cairn models it as a **tree**: any session can be forked at any turn, producing a new `session_id` that inherits history up to the fork point but diverges afterward. This keeps side‑quest exploration from polluting the main context and makes recall like "show me what happened if we'd taken the other path" a first‑class query.

**Priority and sequencing.** Session tree operations (`fork` / `clone` / `switch` / `merge`) are **P2, shipping in v0.3** alongside `cairn.federation.v1` and the full evolution surface. They are advertised via a dedicated `cairn.sessiontree.v1` extension namespace (§8.0.a) — clients discover the verbs by inspecting `status.extensions`. v0.1 and v0.2 runtimes do **not** advertise this extension; calls to `fork_session` / `clone_session` / `merge_session` on earlier runtimes return `CapabilityUnavailable`. The storage model below is written assuming the P2 stack (Nexus sandbox + versioning brick); there is no pure-SQLite P0 implementation because v0.1 uses a flat per-session log and never exposes these verbs.

```
  trunk session (s1)
  ─────────────────────────────────────────────────────────►  time
   t1    t2    t3    t4    t5    t6    t7    t8    t9    t10

                   ├──── fork ──── side‑quest session (s2)
                   │    t4'   t5'   t6'                         (abandoned; kept for history)
                   │
                         ├──── fork ──── research session (s3)
                         │    t5''  t6''  t7''   ──── merge summary ───►  promoted into trunk at t8
                         │
                                 ├──── clone ──── experiment (s4)
                                 │    (copy of t6, new identity, isolated writes)
```

**Primitives (§8 forget/retrieve/search already know about session_id; add three session‑mode verbs):**

All five CLI commands dispatch to the `cairn.sessiontree.v1` extension (§8.0.a); none overloads a core verb. Clients discover availability via `status.extensions` (§8.0.a) — a v0.1 or v0.2 runtime does not advertise `cairn.sessiontree.v1`, so the CLI surfaces `CapabilityUnavailable` and refuses dispatch.

| CLI | MCP (extension verb in `cairn.sessiontree.v1`) | What it does |
|-----|------------------------------------------------|---------------|
| `cairn session tree <root>` | `{verb:"session_tree", args:{root}}` | walk the ancestry + siblings of a session; returns a typed tree |
| `cairn session fork <sid> --at <turn_id>` | `{verb:"fork_session", args:{from, at}}` | create child session `s'` whose history is the prefix `s[0..turn_id]`; future writes go to `s'` |
| `cairn session clone <sid>` | `{verb:"clone_session", args:{from}}` | hard copy at the latest turn — new `session_id`, new identity chain hop, isolated writes (for experiments you don't want to leak back) |
| `cairn session switch <sid>` | `{verb:"switch_session", args:{to}}` | change the "active" session pointer for a (user, agent) pair without altering history |
| `cairn session merge <src> <dst>` | `{verb:"merge_session", args:{src, into, strategy}}` | fold a fork's outcome back into the trunk as a `reasoning` summary record or a full turn splice |

**Storage model.** Forks are cheap because they are copy‑on‑write pointers: child inherits parent's `wal_ops` references up to the fork point; new writes go under the child's `session_id` only. The Nexus `versioning` brick (§3.0) handles the underlying CoW semantics; `snapshot` handles the immutable checkpoint needed at fork time. Clones are a full copy (different `session_id` owner), priced to encourage forks as the default.

**Why this matters beyond aesthetics:**

- **Side‑quests don't destroy main context.** "Try this debugging approach in a side‑session, come back if it works" is a one‑command workflow (`fork → work → merge on success, discard on failure`).
- **Trajectory learning benefits from counterfactuals.** §11 `EvolutionWorkflow` already feeds on `strategy_success` + `strategy_failure`; session forks generate paired trajectories (main vs. side‑quest) that are direct evidence for which path worked better. Same eval, richer signal.
- **Undo is a primitive.** "Undo last turn" is just `cairn session fork --at <last-ok-turn>`; the bad branch persists for audit but no longer steers future `assemble_hot` calls.
- **Cross‑agent collaboration.** A reviewer agent can fork the main session, leave its review as side‑quest turns, and merge the verdict back — without the reviewer's scratch work polluting the principal's context.

**Guarantees preserved across the tree:**

- Every turn in every session still carries its full `actor_chain`, `session_id`, and WAL lineage (§4.2, §5.6). Forks do not reset identity.
- `forget --session <id>` deletes only that node; descendants and ancestors survive. A second command `forget --tree <root>` can cascade if that's what the user wants — explicit and separate.
- Visibility tiers propagate per record, not per session — promoting a record from `s3` to `public` does not promote the tree.

### 5.8 Pipeable CLI modes — one binary, five shapes

Inspired by pi‑mono's multi‑mode pattern, the `cairn` binary has the same operations available in five shapes so scripts, agents, and humans all compose over the same verbs:

| Mode | Example | Output |
|------|---------|--------|
| Interactive TUI | `cairn` | Ink/ratatui dashboard: sessions, search, lint, workflow status |
| Print‑and‑exit | `cairn search -p "flight to Singapore"` | plain text to stdout; pipeable into `grep` / `jq` / `head` |
| JSON event stream | `cairn --mode json retrieve <sid>` | one JSON object per line; structured fields |
| RPC (LF‑delimited JSONL stdin/stdout) | `cairn --mode rpc` | stdin takes JSONL request envelopes, stdout emits JSONL responses — designed for non‑Node hosts; clients **must** split on `\n` only (not Unicode line separators) |
| SDK import | `use cairn::client` (Rust) / `import { createCairnClient } from "cairn"` (TS) | same API in‑process |

Every mode is a thin adapter over the same eight core MCP verbs (§8) — there is no mode‑specific logic the others can't reach. `cairn --mode rpc` is the long‑lived counterpart of `cairn mcp` (stdio MCP server) when the caller wants a simpler LF‑delimited transport.

---

## 6. Taxonomy [P0]

**Every record has four orthogonal tags:** `kind × class × visibility × scope`. They compose — the taxonomy is a tensor, not a tree. Ranker, Consolidator, Promoter, and Expirer all branch on these four axes to pick the right behavior per record.

```
                        19 kinds                  4 classes                 6 visibility tiers
                 ──────────────────────    ──────────────────────    ───────────────────────────
                 user           │          episodic  ▲ event,          private → session →
                 feedback       │          (timed)   │ trace             ▲
                 rule           │                    │ reasoning         │  (requires consent
                 fact           │                    │ feedback          │   log entry per hop)
                 belief         │                    │                   │
                 opinion        │          semantic  ▲ fact,             project →
                 event          │          (facts)   │ entity            │
                 entity         │                    │ reference         │
                 reference      │                    │ belief            │
                 project        │                    │                   team →
                 workflow       │          procedural▲ playbook,         │
                 trace          │          (how-to)  │ workflow          │
                 reasoning      │                    │ strategy_success  │
                 playbook       │                    │ strategy_failure  org →
                 strategy_success│                   │ rule              │
                 strategy_failure│          graph    ▲ relationships,    │
                 sensor_observation│       (links)   │ edges, tag          public
                 user_signal    │                    │ backlinks
                 knowledge_gap  │                    │
                                                                               scope tuple:
                                                                               (tenant, workspace,
                                                                                project, session,
                                                                                entity, user, agent)
```

**Examples of the tensor in use:**

| Example record | kind | class | visibility | scope |
|----------------|------|-------|------------|--------|
| "user prefers dark mode" | `user` | `semantic` | `private` | `user=tafeng` |
| rolling summary of session 01H3… | `reasoning` | `episodic` | `session` | `session=01H3…` |
| "deploy-k8s playbook v3" | `playbook` | `procedural` | `team` | `team=infra, project=koi` |
| contract "HIPAA compliance" | `fact` | `semantic` | `org` | `org=acme` |
| agent‑written self‑critique | `strategy_failure` | `procedural` | `private` | `agent=agt:reviewer:v2` |

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

```
  Visibility ladder — default is private; each hop requires consent
  ─────────────────────────────────────────────────────────────────
            public      ◄── opt-in only, never automatic; 3 human
              ▲             approvals for any org→public promotion
              │ ConsentReceipt + evidence gate + canary
              │
            org         ◄── cross-team; 2 human approvals; requires
              ▲             federation hub or cloud tier
              │ ConsentReceipt + evidence gate
              │
            team        ◄── small-group knowledge; 1 human approval;
              ▲             shared hub or share_link grants
              │ ConsentReceipt (signed by HumanIdentity with team tier capability)
              │
            project     ◄── within one project tree; agents can propose;
              ▲             human signs off; stays on the same machine/hub
              │ ConsentReceipt (signed by HumanIdentity)
              │
            session     ◄── reachable by any turn in this session;
              ▲             auto-promoted from private on first reuse
              │ implicit (same session boundary)
              │
            private     ◄── default for every new write; agent working
                            memory; never leaves the vault without
                            explicit promotion
```

**Rules:**

- Every new record starts at `private` or `session`. The choice is kind-dependent (default table in `.cairn/config.yaml`).
- Promotion is **always one tier at a time** — no skipping. `private → team` is not allowed in one hop; it must pass through `project` first so the project signer has visibility.
- Every promotion writes an append-only entry to `.cairn/consent.log` (§14). The log is the only auditable record of who authorized what.
- Demotion is possible via `forget` with `mode: record` or `mode: scope`; there is no soft "unshare" — once a record is visible at a tier it must be deleted to remove it.
- `AutoUserProfile` (§7.1) and hot-memory assembly respect the caller's maximum visibility — an agent with `agent.max_visibility: project` never sees team/org/public records even if they exist in the vault.

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

## 6.a Multi‑Modal Memory [P2]

Not all memory is text. Cairn's `ingest` verb already accepts non‑text payloads; §6.a is the architecture that makes them first‑class.

- **Multi‑modal sensors.** Video (frame capture + temporal index), audio (transcription + speaker‑diarized segments), image (scene + object embeddings), and binary structured streams (sensor telemetry, packet captures). Each lands in `sources/<modality>/` with provenance; none are mutated.
- **Record stores the caption, not the bytes.** A `sensor_observation` record for a video clip stores: timecode range, auto‑caption, extracted entities, scene summary, and a URI reference to the raw clip in `sources/`. Retrieval matches on the text surface; playback opens the raw clip.
- **Temporal index.** Multi‑modal records share a `time_range: {start, end}` field; a dedicated `TemporalIndex` plugin (implements the `MemoryStore` cross‑cutting trait) answers queries like *"what happened between 14:00 and 16:00 on camera 4?"* across any modality.
- **Cross‑modal correlation.** A `Consolidator` variant joins records with overlapping `time_range` + shared `entities` into a single composite record under `wiki/synthesis/`. Use case: a transcript segment + the screen capture at the same timestamp + the commit that followed → one synthesis page.
- **Embedding model per modality.** `LLMProvider` is extended with a `multimodal_embed(blob, kind) → vector` capability; providers declare which modalities they support. Cairn routes by modality; unsupported modalities fall back to caption‑only indexing.
- **Cost control.** Dense video frame embedding is disabled by default; enable per source (`sources/<id>/config.yaml: dense_embed: true`) so a specific camera / channel can opt in without blanket cost.

## 7. Hot Memory — the Always‑Loaded Prefix [P0]

Every harness turn starts with a hot‑memory assembly:

- Bounded **200 lines / 25 KB / ~6,250 tokens** (at ~4 bytes per token). Hard ceiling enforced by `HotMemoryAssembler`; anything that would push over is demoted to on‑demand retrieval.
- Composed from `purpose.md` + `index.md` + pinned `user`/`feedback` memories + highest‑salience `project` memories + active `playbook` + recent `user_signal`s.
- Assembled by the `HotMemoryAssembler` pure function.
- Cached per‑agent in the hot tier.
- Re‑assembled on Dream (nightly), on high‑salience write, and on `SessionStart`.
- Surfaced via `cairn assemble_hot` (CLI, MCP, SDK, or skill) so non‑Koi harnesses consume the exact same prefix through whichever surface they prefer.

**Explicit token budget (every component declared up front — same spirit as pi‑mono's `<1000 tokens for tools` target):**

| Component | Budget (tokens) | Source |
|-----------|------------------|--------|
| Eight core MCP verb schemas | ~550 | §8 — tool defs are intentionally tiny |
| `cairn.mcp.v1` envelope + capability handshake | ~80 | §8.0.b |
| `purpose.md` framing | ~200 | user‑authored; capped at 800 tokens |
| `index.md` catalog | ~600 | auto‑maintained; capped at 200 lines / ~1,600 tokens |
| `AutoUserProfile` summary (§7.1) | ~400 | auto‑built, compressed on Dream |
| Pinned `user` + `feedback` memories | ~1,200 | top 8 by salience × recency |
| Highest‑salience `project` + active `playbook` | ~1,800 | top 6 |
| Recent `user_signal`s | ~150 | last 24h |
| Reserved headroom | ~1,270 | absorbs prompt expansion across models |
| **Total hot prefix** | **~6,250 tokens (25 KB)** | hard cap |

On‑demand retrieval, classification hooks, and full‑file reads are charged to the per‑turn budget, not the always‑loaded prefix. A harness running at 128k context gets ~5% of its context spent on Cairn baseline; at 1M context, < 1%.

---

## 7.1 Auto‑Built User Profile [P0]

`assemble_hot` and the new `retrieve({target: "profile"})` variant (§8.0.c) both return a synthesized profile that grows automatically from every turn, without the user maintaining it. The profile is split along `records.is_static` (§3.0) so callers can tell "who the user is" apart from "what the user is doing right now" in one round trip instead of fanning out 3–5 search calls.

Two halves, refreshed on `DreamWorkflow` runs:

- **static** — permanent traits drawn from records where `is_static = 1`: name, role, time zone, primary language, core preferences, long-lived entities (employer, primary project). Changes rarely; expirer never touches it.
- **dynamic** — current state drawn from records where `is_static = 0`: active session / project, current_issues, blocker in progress, devices actively in use, recent tool outcomes, recurring patterns detected in the last N days. Decays under the expirer.

Within each half, three structured fields:

- **summary** — current snapshot. ~300 words; top of the hot prefix.
- **historical_summary** — narrative of what's happened and been resolved. Append-only in spirit; old entries compress, never vanish.
- **key_facts** — structured fields: `devices`, `software`, `preferences`, `current_issues`, `addressed_issues`, `recurring_issues`, `known_entities`.

Each field is derived from `user_*.md` + `feedback_*.md` + `entity_*.md` + `strategy_*_*.md` records, filtered by the `is_static` flag. A `UserProfileSynthesizer` pure function produces the frontmatter + markdown body; `HotMemoryAssembler` includes the profile summary in the top of the hot prefix; the `retrieve.profile` verb returns the full `{static, dynamic, updated_at}` document. The profile has its own evidence gates — a `current_issue` is only listed after it appears in two turns on different days. The static/dynamic split + single-verb retrieval is **P0** (plain SQLite aggregation — no embedding key, no Nexus); the richer rolling-summary and historical-narrative layers remain P1 since they depend on `DreamWorkflow` regeneration.

## 8. Contract — CLI is ground truth; MCP, SDK, and Skill all wrap CLI [P0]

### 8.0 The four surfaces are isomorphic — CLI comes first

Cairn exposes one set of eight verbs through four surfaces. **The CLI is the ground truth.** Every other surface — MCP server, language SDK, "cairn skill" for harnesses that don't speak MCP — is a thin wrapper that invokes the same Rust functions the CLI invokes. There is no "internal protocol" distinct from what a human at a shell can type.

```
       ┌─────────────────────────────────────────────────────────────────┐
       │                  Eight verbs (cairn.mcp.v1)                     │
       │   ingest · search · retrieve · summarize · assemble_hot         │
       │   capture_trace · lint · forget                                  │
       └─────────────────────────────────────────────────────────────────┘
                                     ▲
                                     │  (same 8 Rust functions)
           ┌─────────────────────────┼─────────────────────────┐
           │                         │                         │
   ┌───────┴────────┐       ┌────────┴────────┐       ┌────────┴────────┐
   │   cairn CLI    │       │   cairn mcp     │       │  cairn skill    │
   │   (ground      │       │   (protocol     │       │  (SKILL.md +    │
   │    truth)      │       │    wrapper      │       │   bash tool —   │
   │                │       │    ~300 LOC)    │       │   no server)    │
   └───────┬────────┘       └────────┬────────┘       └────────┬────────┘
           │                         │                         │
           ▼                         ▼                         ▼
       human · CI ·             Claude Code ·              Codex · Gemini ·
       shell · scripts          Cursor · any harness        opencode · any
                                that speaks MCP             harness with a
                                                            bash tool + file
                                                            discovery
```

**Why CLI-first:**

| Property | Why it matters |
|----------|-----------------|
| **One testable surface** | Every verb path is exercisable from `bash` — CI, shell scripts, humans all use the same entry point |
| **Zero protocol overhead for internal use** | `AgentExtractor` and `AgentDreamWorker` subprocess the CLI; no internal MCP server to operate or secure |
| **Observable by default** | `stdout` + `stderr` with `--log-format json` replaces wire sniffing; works inside tmux, editor terminals, log pipelines |
| **Discoverable** | `cairn --help` and `cairn <verb> --help` are the spec; any LLM can read them |
| **Composable** | `cairn search X \| jq '.hits[].id' \| xargs -n1 cairn retrieve` — UNIX pipes replace orchestrator glue |
| **Degrades gracefully** | If a harness doesn't support MCP, it still supports `bash` — install the Cairn skill, you're done |

**The mapping is 1:1.** One CLI command per verb, one MCP verb per command, one SDK function per command:

| Verb | CLI | MCP | SDK (Rust) |
|------|-----|-----|------------|
| 1 | `cairn ingest --kind user --body "..."` | `{verb:"ingest", args:{kind,body,...}}` | `cairn::ingest(IngestArgs {...})` |
| 2 | `cairn search "query" [--mode semantic]` | `{verb:"search", args:{...}}` | `cairn::search(SearchArgs {...})` |
| 3 | `cairn retrieve <record-id>`<br>`cairn retrieve --session <id> [--limit K --order desc --rehydrate]`<br>`cairn retrieve --session <id> --turn <n> [--include tool_calls,reasoning]`<br>`cairn retrieve --folder <path>`<br>`cairn retrieve --scope <expr>`<br>`cairn retrieve --profile [--user <id>] [--agent <id>]` | `{verb:"retrieve", args: RetrieveArgs}` (discriminated union — see §8.0.c) | `cairn::retrieve(RetrieveArgs::{Record,Session,Turn,Folder,Scope,Profile}{…})` |
| 4 | `cairn summarize <record-ids...> [--persist]` | `{verb:"summarize", args:{...}}` | `cairn::summarize(SumArgs {...})` |
| 5 | `cairn assemble_hot [--session <id>]` | `{verb:"assemble_hot", args:{...}}` | `cairn::assemble_hot(...)` |
| 6 | `cairn capture_trace --from <file>` | `{verb:"capture_trace", args:{...}}` | `cairn::capture_trace(...)` |
| 7 | `cairn lint [--write-report]` | `{verb:"lint", args:{...}}` | `cairn::lint(LintArgs {...})` |
| 8 | `cairn forget --record <id> \| --session <id>` | `{verb:"forget", args:{mode,...}}` | `cairn::forget(ForgetArgs {...})` |

**What lives where in the binary:**

```
  cairn (one static Rust binary, ~15 MB)
    ├── src/verbs/          ← 8 Rust functions, one per verb (ground truth)
    ├── src/cli/            ← clap command tree, calls verbs directly
    ├── src/mcp/            ← ~300 LOC: reads JSON-RPC, calls verbs, writes JSON-RPC
    ├── src/sdk/            ← exported as a library crate (`cairn` on crates.io)
    └── skills/cairn/       ← SKILL.md ships with the binary; installed by `cairn skill install`
```

`cairn mcp` is **not a separate process or service**. It is a subcommand that reads MCP frames on stdio, dispatches to `src/verbs/*`, writes responses. If a harness can spawn a subprocess and pipe it JSON-RPC, MCP works. If a harness can only run bash commands, the skill works. Either way the same 8 Rust functions produce the same 8 outputs.

### 8.0.a Handshake — two protocol preludes, neither counted in the eight verbs [P0]

The eight verbs are frozen public entry points for **mutations and queries**. Two additional **protocol preludes** exist, and they are split on purpose because one is deterministic and cacheable while the other mints fresh state:

1. **`status` — deterministic capability discovery (cacheable, no side-effects).** Returns the contract version, advertised capabilities, and server info — exactly the fields clients need to decide which verbs/modes are legal. The response is byte-identical (after canonical JSON ordering) across every call within a single daemon incarnation, so MCP `initialize` and `cairn status --json` can be compared byte-for-byte in CI wire-compat.
2. **`handshake` — fresh challenge mint (per-call, side-effectful).** Inserts a row into `outstanding_challenges` (§4.2) with a fresh nonce + expiry and returns it. Each call produces a different response; the challenge is single-use and consumed by the next signed mutation. Stateless clients and the anti-replay flow (§4.2) call this surface separately from `status`.

| Surface | `status` (deterministic) | `handshake` (fresh challenge) |
|---------|---------------------------|----------------------------------|
| **MCP** | MCP's built-in `initialize` request (required by the MCP spec). Cairn returns `server_info` + `capabilities` + `extensions`. Clients MUST issue `initialize` before any `tools/call`. | `handshake` MCP verb (part of the prelude namespace, not the eight core verbs). Returns a fresh `{nonce, expires_at}` pair. Called whenever a stateless client needs a new challenge. |
| **CLI** | `cairn status --json` | `cairn handshake --json` |
| **SDK** | `cairn::status() -> StatusResponse` | `cairn::handshake() -> ChallengeResponse` |
| **Skill** | `cairn status --json \| jq '.capabilities'` (first step in every SKILL.md recipe) | `cairn handshake --json \| jq -r '.nonce'` (right before any signed mutation) |

The `status` response (deterministic):

```jsonc
{
  "contract": "cairn.mcp.v1",
  "server_info": { "version": "0.1.0", "build": "…", "started_at": "…", "incarnation": "01HQZ…" },
  "capabilities": [
    "cairn.mcp.v1.search.keyword",
    "cairn.mcp.v1.search.semantic",    // advertised at v0.1 via local candle + sqlite-vec
    "cairn.mcp.v1.search.hybrid",      // advertised at v0.1 via local blend
    // dropped from this list ONLY when `search.local_embeddings: false` in config
    "cairn.mcp.v1.forget.record",
    // advertised ONLY on v0.2+ runtimes:
    // "cairn.mcp.v1.forget.session",
    // advertised ONLY on v0.3+ runtimes:
    // "cairn.mcp.v1.forget.scope",
    "cairn.mcp.v1.retrieve.record",
    "cairn.mcp.v1.retrieve.session",
    "cairn.mcp.v1.retrieve.turn",
    "cairn.mcp.v1.retrieve.folder",
    "cairn.mcp.v1.retrieve.scope",
    "cairn.mcp.v1.retrieve.profile"
  ],
  "extensions": []                    // e.g., "cairn.aggregate.v1", "cairn.admin.v1", "cairn.federation.v1"
}
```

The `handshake` response (fresh per call):

```jsonc
{
  "contract": "cairn.mcp.v1",
  "challenge": { "nonce": "…base64…", "expires_at": 1735000000000 }
}
```

**CI wire-compat** (§15) asserts:
(a) `status.capabilities` matches the verbs/modes the runtime will actually execute — no over-advertising, no silent support.
(b) Every verb call that corresponds to an un-advertised capability returns `CapabilityUnavailable` rather than succeeding or falling back.
(c) `cairn status --json` output is byte-identical (after sorting arrays) to the MCP `initialize` response **within the same daemon incarnation**. Restarts mint a new `incarnation` ULID; the byte-identity test scopes to a single run.
(d) Two back-to-back `handshake` calls return **different** nonces (they are fresh per call).

There is exactly one capability surface (`status`) and one challenge surface (`handshake`). §8 / §18.c / §19 / §1.b / §4 all reference `status.capabilities` consistently; no alias, no second name.

### 8.0.a-bis The Cairn skill — what gets installed when you say "cairn skill install"

A SKILL.md file teaches any bash-capable agent how to use Cairn without MCP. This is the pattern Garry Tan's gbrain and Anthropic's Claude Code Skills use: a fat markdown doc + deterministic commands + LLM reads the doc and calls the commands via the harness's native `bash` tool.

```
  ~/.cairn/skills/cairn/
    ├── SKILL.md            ← the contract (§18.d)
    ├── conventions.md       ← when to ingest vs. search; kinds cheat-sheet
    ├── examples/            ← 10-20 real transcripts: user intent → cairn call
    └── scripts/             ← any deterministic helpers (none required for v0.1)
```

Concrete payoff: a harness with no MCP plugin (or one where the user prefers not to install servers) can still use Cairn fully by loading the skill.

**Contract version.** `cairn.mcp.v1` — the entire verb set below is frozen under this name; a breaking change yields `cairn.mcp.v2` and both versions run side by side during deprecation. The contract version, verb list, and per‑verb schema are generated from the single IDL (§13.5); wire‑compat tests fail CI on drift. Clients declare the version they implement via the **status prelude** (§8.0.a) — they read `status.contract` + `status.capabilities` before any verb call. Cairn refuses unknown verbs rather than silently dropping them. The same IDL generates the CLI clap definitions and SDK trait signatures — single source of truth across all four surfaces.

### 8.0 Core verbs (always present in `cairn.mcp.v1`)

| # | Verb | What it does | Auth requirement |
|---|------|--------------|-------------------|
| 1 | `ingest` | push an observation (text / image / video / tool call / screen frame / web clip) | signed actor chain; rate‑limited per‑agent (§4.2) |
| 2 | `search` | hit records across scope. **All three modes ship at v0.1** via the P0 stack (SQLite FTS5 + statically-linked `sqlite-vec` + pure-Rust `candle` embeddings — §3.0): `mode: "keyword"`, `mode: "semantic"`, `mode: "hybrid"`. Each mode is advertised as a separate capability (`cairn.mcp.v1.search.keyword` / `.semantic` / `.hybrid`). A deployment that opts out of local embeddings via `search.local_embeddings: false` drops the semantic/hybrid capabilities from `status.capabilities` and rejects those modes with `CapabilityUnavailable` — never silent fallback. P1 Nexus sandbox adds BM25S as an additional scorer and the option to swap the embedding provider to `litellm` (OpenAI / Cohere / Voyage / Ollama) for richer vectors. Clients inspect `status.capabilities` before issuing any mode. | rebac‑gated; results filtered per visibility tier |
| 3 | `retrieve` | get a specific memory by id, a full session, a single turn within a session, a folder subtree, or a scope — variant selected via `RetrieveArgs` (§8.0.c). Turn retrieval is its own first-class variant `target: "turn"` keyed by `{session_id, turn_id, include}` (turn IDs are monotonic per session — §18.c US1 — so the `turn` shape requires `session_id` as the disambiguator, never a bare id). `RetrieveArgs` is an exhaustive discriminated union generated from the single IDL; the CLI, MCP wire schema, and Rust SDK enum are all emitted from the same source (§13.5) | rebac‑gated; unverified chain → `trust: "unverified"` flag unless `allow_unverified: true` |
| 4 | `summarize` | multi‑memory rollup; optional `persist: true` files the synthesis as a new `reference` or `strategy_success` memory with provenance | rebac‑gated on sources; `persist` requires write capability |
| 5 | `assemble_hot` | return the always‑loaded prefix for this agent/session | rebac‑gated on sources |
| 6 | `capture_trace` | persist a reasoning trajectory for later ACE distillation | signed actor chain |
| 7 | `lint` | health check — contradictions, orphans, stale claims, missing concept pages, data gaps; returns a structured report and optionally writes `lint-report.md` | read‑only; `write_report: true` requires write capability |
| 8 | `forget` | delete record, session, or scoped set. `mode` is capability‑gated: `record` is always present in `cairn.mcp.v1`; `session` requires the `cairn.mcp.v1.forget.session` capability (advertised in v0.2+ runtimes only); `scope` requires `cairn.mcp.v1.forget.scope` (v0.3+). A runtime that does not advertise a capability must reject calls with that `mode` rather than silently succeeding. Transactional under §5.6 WAL. | signed principal (human) with `Forget` capability for the target tier |

`forget` is the single delete surface — the CLI `cairn forget …` is a thin wrapper calling this verb. There is no undocumented delete path. Clients must inspect `status.capabilities` to discover which `mode` values this runtime supports; CI wire‑compat tests fail if a v0.1 runtime advertises a mode it cannot execute.

**Citations mode.** Every read verb (`search`, `retrieve`, `summarize`, `assemble_hot`) accepts a `citations: "on" | "compact" | "off"` flag, resolved from `.cairn/config.yaml` by default. `on` appends `Source: <path#line>` to each recalled snippet; `compact` appends only a single citation per record; `off` returns content without paths. Turn compact or off in harnesses whose UI shouldn't expose file paths to end users.

### 8.0.a Extension namespaces (opt‑in, capability‑gated)

Optional verbs live in named extensions registered at startup and advertised via capability negotiation. Clients that don't request an extension never see its verbs; Cairn rejects calls to extensions the caller didn't opt into.

| Extension | Adds verbs | Ships in | Enabled by | Auth requirement |
|-----------|-----------|----------|------------|-------------------|
| `cairn.aggregate.v1` | `agent_summary` · `agent_search` · `agent_insights` (§10.0) | v0.2 | `.cairn/config.yaml` → `agent.enable_aggregate: true` | rebac‑gated, results are anonymized aggregates only |
| `cairn.admin.v1` | `snapshot` · `restore` · `replay_wal` | v0.1 | operator role | hardware‑key countersigned principal |
| `cairn.federation.v1` | `propose_share` · `accept_share` · `revoke_share` (accept `subject.path_prefix` for folder-scoped shares, §3.4) | v0.3 | enterprise deployments only | signed `ShareLinkGrant` |
| `cairn.sessiontree.v1` | `session_tree` · `fork_session` · `clone_session` · `switch_session` · `merge_session` (§5.7 — first-class extension verbs, **not** overloads of core `ingest` / `retrieve`) | v0.3 | `.cairn/config.yaml` → `session.enable_tree: true`; requires Nexus `versioning` brick (P2) | signed actor chain; `fork_session` / `clone_session` / `merge_session` require write capability on both source and target sessions |

Extensions extend the surface; they do not reinterpret core verbs. A verb ID belongs to exactly one namespace for the life of the contract version. Clients discover enabled extensions via `status.extensions` (§8.0.a).

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

The **eight verbs** are the only public entry points — four surfaces, same verbs, same signed envelope, same policy trace. A CLI invocation like `cairn forget --session <id>` dispatches to the same Rust function as the MCP frame `{verb: "forget", args: {mode: "session", session_id: "..."}}`; neither is "syntactic sugar" over the other — both are thin shells around `src/verbs/forget.rs`. Hooks, library calls, and skill invocations route through the same layer.

**MCP tool descriptions are prompt-engineered, not just documentation.** When `cairn mcp` registers its verbs with the harness, each tool description is deliberately opinionated — it tells the model *when to use this tool* and, critically, *when not to*. Weak models (cheap inference tiers, smaller open-weight models) pick tools mostly from the description; generic docstrings produce wrong-tool selection. Every Cairn MCP verb description therefore includes:

1. **One-line purpose** — "persist a memory about the user, the task, or the world"
2. **Positive trigger examples** — "use when the user says 'remember that…', 'from now on…', or you detect a correction"
3. **Negative triggers** — "do NOT use for one-off computation results, for facts the user can re-derive, or for chat transcripts (those flow through `capture_trace`)"
4. **Exclusivity hint when a harness ships multiple memory tools** — "this is the canonical memory tool for this vault; prefer it over other `remember_*` / `save_*` tools registered in this session"

The descriptions are generated from the same IDL (§13.5) as the JSON schemas, so there is one source of truth for both machine-readable signatures and human/model-readable selection prompts. §15 includes a tool-selection eval that measures how often a weaker model picks the right Cairn verb from the description alone.

### 8.0.c `RetrieveArgs` — discriminated union [P0]

`retrieve` serves six distinct read shapes (record by id, full session, a single turn within a session, folder tree, arbitrary scope filter, and the composed user/agent **profile**). Rather than overload a single `{id}` shape, the verb's `args` is a tagged union keyed on `target`. Unknown `target` values are rejected at the wire layer, never silently ignored.

```jsonc
// args: RetrieveArgs — exactly one variant per call
{ "target": "record",  "id": "01HQZ..." }
{ "target": "session", "session_id": "01HQY...", "limit": 100, "order": "desc", "rehydrate": false, "include": ["tool_calls"] }
{ "target": "turn",    "session_id": "01HQY...", "turn_id": 42, "include": ["tool_calls", "reasoning"] }
{ "target": "folder",  "path": "people/<user_id>", "depth": 2 }
{ "target": "scope",   "scope": { "user": "...", "agent": "...", "kind": ["user","feedback"] } }
{ "target": "profile", "user": "...", "agent": "..." }
```

| Variant | CLI form | What it returns | Auth gate |
|---------|----------|-----------------|-----------|
| `record` | `cairn retrieve <id>` | one `MemoryRecord` + its edges | rebac on the record |
| `session` | `cairn retrieve --session <id> [--limit K --order asc\|desc --rehydrate]` | ordered turn stream; `rehydrate: true` unpacks cold snapshots (US2, §18.c) | rebac on session + every included turn |
| `turn` | `cairn retrieve --session <id> --turn <n> [--include tool_calls,reasoning]` | one turn record for `(session_id, turn_id)` plus any `include`-requested children (tool calls, reasoning) — addresses US5's `retrieve(turn_id, include: ["tool_calls"])` without the confusion of a globally-bare `turn_id` (§18.c US1 says `turn_id` is monotonic per session, not unique) | rebac on the turn + each included child |
| `folder` | `cairn retrieve --folder <path> [--depth N]` | `_index.md` + `_summary.md` + child index (§3.4) | rebac on folder |
| `scope` | `cairn retrieve --scope '{"user":"u","agent":"a"}'` | all records matching the filter (paginated) | rebac applied per-row at MemoryStore layer |
| `profile` | `cairn retrieve --profile [--user <id>] [--agent <id>]` | single-shot composed profile: `{static: {...permanent traits...}, dynamic: {...current issues, recent activity, recurring patterns...}, updated_at}`. Backed by `AutoUserProfile` (§7.1); splits the record set by `is_static` (§3.0). Returns in one call what would otherwise take 3–5 `search` / `scope` round-trips, keeping "who is the user and what are they doing" off the hot path of every agent turn. | rebac on the scope tuple |

**Rust SDK mirror** — `RetrieveArgs` is the exact same Rust enum emitted by the single IDL (§13.5):

```rust
pub enum RetrieveArgs {
    Record  { id: RecordId },
    Session { session_id: SessionId, limit: Option<u32>, order: Order, rehydrate: bool, include: Vec<IncludeField> },
    Turn    { session_id: SessionId, turn_id: u64, include: Vec<IncludeField> },
    Folder  { path: VaultPath, depth: Option<u8> },
    Scope   { scope: ScopeFilter },
    Profile { user: Option<UserId>, agent: Option<AgentId> },
}
```

`cairn retrieve` (CLI) parses positional vs. flag forms into exactly one variant and errors if the caller mixes them (e.g., `--session X --folder Y` is `InvalidArgs` — not "last wins"; `--turn N` without `--session` is rejected because `turn_id` is not globally unique; `--profile` without at least one of `--user` / `--agent` is rejected). SKILL.md documents the six forms as six separate bash recipes so LLM agents never guess the shape.

### 8.0.d `SearchArgs.filters` — metadata filter DSL [P0]

`search` supports a structured metadata filter grammar on top of the scope tuple so callers don't have to fan out multiple queries for "`kind=user AND priority >= 7 AND category != draft`"-shaped questions. Filters compose `AND` / `OR` / `NOT` trees over a small set of typed predicates. The same grammar applies at P0 (FTS5 + column filter) and P1 (ranker re-scores within the filtered set); no semantic-mode surface changes.

```jsonc
// args: SearchArgs
{
  "query": "migration strategy",
  "mode":  "keyword",                    // capability-gated, §8.0 verb 2
  "scope": { "user": "...", "agent": "..." },
  "filters": {
    "and": [
      { "field": "kind",       "op": "in",              "value": ["strategy_success", "playbook"] },
      { "field": "is_static",  "op": "eq",              "value": false },
      { "field": "tags",       "op": "array_contains",  "value": "infra" },
      { "field": "priority",   "op": "gte",             "value": 7 },
      { "or": [
          { "field": "category", "op": "eq",             "value": "shipped" },
          { "not": { "field": "category", "op": "eq",    "value": "draft" } }
      ]},
      { "field": "title",      "op": "string_contains", "value": "pg" }
    ]
  },
  "limit": 25,
  "citations": "compact"
}
```

**Supported ops per field type:**

| Field type | Ops |
|------------|-----|
| `string` (kind, class, visibility, path, title, category, …) | `eq`, `neq`, `in`, `nin`, `string_contains`, `string_starts_with`, `string_ends_with` |
| `integer` / `float` (priority, version, created_at, confidence) | `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `between` |
| `boolean` (`is_static`, `tombstoned`, `active`) | `eq` |
| `array` (tags, actor_chain, backlinks) | `array_contains`, `array_contains_any`, `array_contains_all`, `array_size_eq` |

**Composition.** `{ and: [ ... ] }`, `{ or: [ ... ] }`, `{ not: <filter> }`; nested to arbitrary depth. Each leaf is `{ field, op, value }`. Unknown fields or unsupported op-on-field combinations are rejected at the wire layer with `InvalidFilter` — never silently dropped.

**Execution at P0.** The filter compiles to a SQLite `WHERE` clause against the `records` table (all fields are either columns or indexed JSON paths on `frontmatter_json`); the FTS5 match narrows the row set, then the filter narrows further. Everything in one query. At P1 the ranker re-scores the filtered set against the semantic index; the filter itself never moves into Nexus.

**Same grammar on `retrieve --scope`.** The `ScopeFilter` used by `RetrieveArgs::Scope` (§8.0.c) accepts the exact same filter expression, so a scope-level read and a search-within-scope read share one parser, one test suite, one IDL schema.

---

---

## 8.1 Session Lifecycle — Auto‑Discovery + Auto‑Create [P0]

All eight core MCP verbs accept an optional `session_id`. When absent, Cairn applies this policy:

```
  caller invokes any verb without session_id
                    │
                    ▼
          ┌───────────────────────┐
          │  Find most recent     │  (query .cairn/cairn.db sessions
          │  active session for   │   for this agent_id, ordered by
          │  (user_id, agent_id)  │   last_activity_at desc)
          └─────────┬─────────────┘
                    │
          ┌─────────┴─────────┐
          │                   │
        found?              not found?
          │                   │
          ▼                   ▼
    ┌───────────┐       ┌──────────────────┐
    │ idle window│       │ create new session│
    │ <= 24 h?   │       │ with title: ""    │
    │ (default)  │       │ populated by next │
    └─────┬──────┘       │ DreamWorkflow pass│
          │              └────────┬──────────┘
      yes │ no                    │
          │  │                    │
          │  ▼                    │
          │ create new            │
          │ session (old one      │
          │ stays "ended")        │
          │  │                    │
          ▼  ▼                    ▼
     ┌──────────────────────────────────┐
     │  resolved session_id returned    │
     │  in every response envelope      │
     └──────────────────────────────────┘
```

1. **Find** the user's most recent active session for this `agent_id` (within a configurable idle window, default 24 h).
2. **If found** — reuse it; append turns to it.
3. **If not found** — create a new session with `title: ""` (populated later by the first `DreamWorkflow` pass) and metadata from the caller.
4. Return the resolved `session_id` in every response.

This mirrors the "just call `ingest` — I don't want to manage sessions" pattern production memory services use. Harnesses that *do* track sessions pass `session_id` explicitly and opt out of auto‑discovery.

Sessions carry metadata (`channel`, `priority`, `tags`), emit a `session_ended` event when the idle window elapses, and are searchable via the `search` verb with `scope: "sessions"` — the same way records are searchable.

## 9. Sensors — the Capture stage of the ingestion pipeline [P0 hooks + voice + screen · P2 source connectors]

**Sensors are not a separate concept — they are the source adapters for §5.2's ingestion pipeline.** Every sensor emits `CaptureEvent`s that enter the same `Capture → Tool‑squash → Extract → Filter → Classify & Scope → Store` flow as a human typing `cairn ingest`. This section catalogs the sources; the processing lives in §5.

```
   SOURCES (this section)                       INGESTION PIPELINE (§5.2)
   ──────────────────────────────              ────────────────────────────────
    hooks (CC/Codex/Gemini) ──┐
    IDE events                 │
    terminal commands          │
    clipboard                  │
    screen frames              ├──► CaptureEvent ──► Capture ──► Tool-squash
    Slack / email              │                                    │
    GitHub / GitLab            │                                    ▼
    web clips / RSS            │                                  Extract (§5.2.a)
    document imports           │                                    │
    transcripts                │                                    ▼
    cairn ingest CLI ─────────┘                                   Filter → Classify
    cairn ingest MCP ─────────┘                                    → Scope → Store
                                                                     │
                                                                     ▼
                                                                  MemoryStore
```

All sources produce the same `CaptureEvent` schema, signed with the sensor's `SensorIdentity` (§4.2). A Slack message, a screen frame, and a CLI `cairn ingest` invocation are indistinguishable after Capture — they differ only in the sensor label and any modality‑specific extraction hint.

### 9.1 Source families — all opt‑in per‑sensor

**No UI required.** Every sensor enables via config (`.cairn/config.yaml`) or CLI flag (`cairn sensor enable <name>`). Sensors run as background daemons under `cairn daemon start` — works on headless servers, SSH sessions, and CI runners. The desktop GUI (§13) is purely optional: it exposes the same toggles but is never required to turn a sensor on or off.

**Local sensors** — run on the same machine as Cairn, emit events into the pipeline as they happen. Every local sensor ships in v0.1 (P0) and is a pure-Rust adapter unless the "Backed by" column says otherwise.

| Sensor | Priority | What it captures | Backed by | Privacy |
|--------|----------|------------------|-----------|---------|
| Hook sensor | P0 | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `Stop` — harness‑agnostic (CC / Codex / Gemini) | harness hook protocol | harness‑scoped |
| IDE sensor | P0 | file edits, diagnostics, tests run, language server events | LSP client in Rust core | opt‑in per project |
| Terminal sensor | P0 | captured commands + outputs | shell integration scripts | opt‑in, secret‑scrubbed |
| Clipboard sensor | P0 | clipboard snapshots | [`arboard`](https://github.com/1Password/arboard) (Apache-2) | opt‑in |
| **Voice sensor** | **P0** | continuous mic capture → VAD-gated utterances → ASR transcript + **speaker embeddings** (attaches `HumanIdentity` via enrollment — §4.2). Streams `{speaker_id, text, ts_start, ts_end, confidence}` as `CaptureEvent`s. | [`cpal`](https://github.com/RustAudio/cpal) (Apache-2, mic I/O) + [**sherpa-onnx**](https://github.com/k2-fsa/sherpa-onnx) (Apache-2, one ONNX Runtime running VAD + ASR + diarization + speaker-embedding models — ~50 MB runtime + ~50 MB models). Bound via direct C FFI from Rust core (thin ~600 LOC adapter); models downloaded on first run into `.cairn/models/`. | opt‑in; per-app / per-process allowlist; PII-scrub pass before Store |
| **Screen sensor** | **P0** (via subprocess) | continuous screen frames + active-window + URL + accessibility tree → OCR'd text + app-activity events. Streams `{app, window_title, text, url?, bbox}` as `CaptureEvent`s. On-demand snapshot mode also supported for hotkey-driven capture. | Primary: [**screenpipe**](https://github.com/screenpipe/screenpipe) (MIT main tree — pin; never import `ee/`) spawned as subprocess by `cairn daemon start`; Cairn subscribes to its HTTP `/events` SSE and `/search` API. Fallback (when screenpipe unavailable / policy-blocked): in-process [`xcap`](https://github.com/nashaofu/xcap) (Apache-2) + [`tesseract`](https://github.com/tesseract-ocr/tesseract) via `leptess` — pure Rust, no subprocess, ~250 MB total working set. | opt‑in, per‑app allow‑list, password fields blurred, PII-scrub pass before Store |
| Neuroskill sensor | P0 | structured agent tool‑call traces emitted by the harness itself | harness neuroskill protocol | always on when harness cooperates |

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

**All sensors emit through the same write path** (§5.2) — one ingestion pipeline, many source adapters. A Slack message and a screen frame and a `cairn ingest` CLI call are all `CaptureEvent`s once they cross the sensor boundary; the `ExtractorWorker` chain (§5.2.a) picks the right extractor per event kind and the rest of the pipeline proceeds identically.

**Ingestion rate limits and budget.** Every source sensor declares a per‑scope budget (`max_items_per_hour`, `max_bytes_per_day`). Cairn's Filter stage enforces these. Exceeding budget routes to `discard(budget_exceeded)` and surfaces in the next `lint` report — Cairn never silently drops under budget pressure.

### 9.1.a Recording-to-text — understanding audio and video after the fact

The voice + screen sensors above stream observations **as they happen**. A separate batch pipeline handles the "understand this recording" case — a meeting MP4, a podcast, a screen-recording of a workflow, a voice memo. Same `CaptureEvent` schema, different source:

```
  recording file (mp4 / m4a / mp3 / mkv / webm)
       │
       ▼
  `cairn ingest --recording <path>`   (CLI)
       │                                        ┌──────────────────────────────────┐
       ├─► split into audio + video tracks ──► │  audio track: sherpa-onnx ASR +  │
       │   (ffmpeg, shelled out)                │  diarization → timestamped      │
       │                                        │  utterances                     │
       │                                        └──────────────────────────────────┘
       │                                        ┌──────────────────────────────────┐
       │                                    ──► │  video track: frame-sample at   │
       │                                        │  1–2 fps; OCR each frame        │
       │                                        │  (tesseract), dedupe via        │
       │                                        │  perceptual-hash; optional      │
       │                                        │  vision-LM caption pass via     │
       │                                        │  LLMProvider                    │
       │                                        └──────────────────────────────────┘
       ▼
  fused transcript stream: `[{t: 00:42, speaker: alice, text: "..."}, {t: 00:45, frame_ocr: "config.yaml line 12: ..."}, ...]`
       │
       ▼
  one CaptureEvent per aligned segment → Extract → Filter → Classify → Store (§5.2)
       │
       ▼
  every segment gets a `trace` / `meeting` / `transcript` record with back-links to the
  source file (kept under sources/, hashed for §3 forget-me re-ingest consent) and to
  any people / entities mentioned (edge kind = `attended` / `mentioned`)
```

**Tier placement.**

| Tier | What recording-to-text can do |
|------|-------------------------------|
| **P0** | `cairn ingest --recording <path>` works offline using local sherpa-onnx (audio) + tesseract OCR (video frames). No vision model, no cloud. Diarization attaches speakers via local embeddings; unrecognized speakers become `unknown_speaker_<ulid>` until enrolled. |
| **P1** | Nexus sandbox adds a richer video pipeline: whisper via `litellm`, frame-level vision captions via a small local VLM, entity-linking into the knowledge graph (every face / logo / on-screen name resolved against `entity_*` records). |
| **P2** | Continuous-recording sensor: `cairn record --on` spools full-day video+audio to disk with per-app privacy masks; `DreamWorkflow` at night processes the spool into the pipeline. Opt-in only, explicit retention cap (default 7 days before auto-purge). |

No external product name is baked in; the pipeline is composed from the same local libraries the continuous voice + screen sensors already use, so there is no second toolchain to install.

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

Hooks are plain scripts executed via `cairn hook <name>` (Rust binary on `$PATH`). A single Cairn binary wires identically into CC's `.claude/settings.json`, Codex's `.codex/hooks.json`, and Gemini's `.gemini/settings.json`.

---

## 10. Continuous Learning — Eight Durable Workflows [P0 rolling · P1 full tiers · P2 agent]

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

### 10.2 DreamWorker — pluggable dispatch modes

**"Who actually runs the dream pass"** is pluggable. The three tiers above describe *when* and *what*; the `DreamWorker` trait describes *how*. Cairn ships three built‑in implementations on the same trait, and third‑party plugins can add more.

```rust
// L0 trait — zero deps, pure data over in/out
pub trait DreamWorker: Send + Sync {
    fn name(&self) -> &'static str;                     // "llm" | "agent" | "hybrid" | custom
    fn cost_budget(&self) -> DreamBudget;               // tokens, wall-clock, tool calls allowed
    async fn run(&self, tier: DreamTier, plan_input: &DreamInputs) -> DreamPlan;
}
```

**The three built‑ins + when to pick each:**

| Mode | How a dream pass executes | Cost | Latency | Risk | Right default for |
|------|---------------------------|------|---------|------|--------------------|
| **`LLMDreamWorker` (default, v0.1)** | each sub‑stage (consolidate, classify, promote) is **one prompted LLM call** with a structured schema; no tool loop; no self‑invocation | lowest — bounded by token count × stages | bounded, predictable; p95 < 60 s for Light Sleep | lowest | L1/L2, single‑user, offline, CI runs |
| **`AgentDreamWorker` (opt‑in, v0.2+)** | invokes a full Cairn agent (with its own `agt:*` identity + tool allowlist scoped to `search` / `retrieve` / `lint`) in a multi‑turn loop; agent can iterate, call deterministic scripts, use its own memory | 5–20× LLM cost; tool calls metered | unbounded unless capped; cap via `cost_budget.max_turns + max_wall_s` | medium — tool sprawl, cost blowup | power users, team/org vaults with complex corpora, compounding skill synthesis |
| **`HybridDreamWorker` (opt‑in, v0.2+)** | deterministic prune first (stamp stale records, dedup by hash); then one LLM call per remaining bucket; no tool loop | close to LLM mode | ~10–20 % slower than LLM mode (prune pass first) | low — prune is idempotent | anyone whose corpus has measurable dup rate; opencode‑style compaction |

**Contract rules (all three modes obey):**

- Every mode produces the **same `DreamPlan` output** (§5.5 FlushPlan). A hybrid plan is indistinguishable from a pure‑LLM plan after serialization.
- Every mode respects `cost_budget` — exceeding it aborts the run with a `DreamBudgetExceeded` entry in the `lint-report.md`; partial plans are never applied.
- Every mode writes its `DreamPlan` through the same §5.6 WAL `promote`/`consolidate`/`expire` state machines — the WAL is the safety net regardless of who authored the plan.
- **Agent mode shells out to the same `cairn` CLI** as external callers. The `AgentDreamWorker` is a Cairn agent (identity `agt:cairn-librarian:v2` by default) whose tool set is `bash(cairn search …)`, `bash(cairn retrieve …)`, `bash(cairn lint --dry …)`. No internal MCP server runs — the binary you type at a shell is the binary the dreamer invokes.
- Agent mode's CLI commands are **read‑only by default**. The agent proposes a `DreamPlan`; the plan goes through the normal §11.3 promotion predicate before any mutation. An agent cannot unilaterally write to the vault from inside a dream pass; attempted `cairn ingest` / `cairn forget` calls are rejected at the signed‑envelope layer via the dreamer's scope tuple (§4.2).

**Config selector (per vault, per tier):**

```yaml
# .cairn/config.yaml
dream:
  light_sleep:
    worker: llm               # default — cheap, every Stop hook
  rem_sleep:
    worker: hybrid            # prune first, then LLM — dedup pays off hourly
  deep_dreaming:
    worker: agent             # nightly — full agent loop; the heavy pass
    agent_profile: cairn-librarian:v2
    cost_budget:
      max_turns: 40
      max_wall_s: 900
      max_tokens: 800000
```

**Why three modes and not "pick one":** the real‑world reference systems each picked a different point on this spectrum, and each picked correctly for their user:

| Reference system | Mode | Why it's right for them |
|-------------------|------|--------------------------|
| **Hindsight / hermes‑agent** | `llm` — `post_llm_call` hook fires async structured extraction; no tool loop | single‑tenant personal agent, hard latency + cost budget, bounded surface |
| **opencode** | `hybrid` — `SessionCompaction.process` does deterministic stale‑output prune → one‑pass summary (hidden "compaction agent" in config but no self‑invocation) | session‑level compaction under a strict token ceiling, needs reversibility (stamp‑not‑delete) |
| **Garry Tan / gbrain** | `agent` — nightly cron "dream cycle" dispatches skills as subagents/Minions over a 10 k+ file markdown brain | personal knowledge compounding over months; worth the tool‑loop cost because the corpus is huge and heterogeneous |

Cairn is *harness‑agnostic memory*, so we commit to **all three** behind the same `DreamWorker` trait. Default `llm`; opt in to `hybrid` once dup rate justifies it; opt in to `agent` once the corpus is big enough that a tool loop compounds. Switching modes is a one‑line config change — the plan schema, WAL, and audit trail are identical.

**Anti‑patterns the contract prevents:**

- An `AgentDreamWorker` that writes directly to `wiki/` without going through the §5.6 WAL — structurally impossible (agent's tools are read‑only; plan goes through the normal promotion gate).
- Unbounded cost — every worker declares `cost_budget`; violating it aborts the run, not the vault.
- Silent mode drift — `cairn vault status` shows which `DreamWorker` ran each tier last and its budget consumption, so operators never wake up surprised by a 10× cost spike.

---

## 11. Self‑Evolution — the Evolution Workflow [P2]

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

## 11.a Graph of Skills — Dependency‑Aware Structural Retrieval [P2]

Skills are not a flat pile. They form a **directed acyclic dependency graph** — `ship-a-pr` depends on `run-tests` depends on `lint-the-diff`. Retrieving a skill that has unmet prerequisites is worse than useless, so Cairn surfaces the DAG explicitly.

- **Declared dependencies.** Every `skills/*.md` frontmatter carries `requires: [<skill_id>, …]` and `provides: [<capability>, …]`. `SkillEmitter` infers these from the trajectory that produced the skill; `EvolutionWorkflow` can refine them.
- **Graph is a first‑class store.** `MemoryStore`'s `graph` class holds `(skill) --requires--> (skill)` edges. A `SkillGraphResolver` pure function answers "what's the ordered prerequisite chain for skill X?" in one traversal.
- **Retrieval walks the graph, not just the flat store.** The `search` verb with `kind: playbook | strategy_success` returns hits *and* their prerequisite closures, so the agent sees the full activation context in one call.
- **Evolution respects the graph.** `EvolutionWorkflow` only mutates a skill if its declared `provides` set stays stable (any regression would break dependents). Dependents are listed in the constraint‑gate report.
- **Unmet‑prereq memory.** When a turn fails because a prerequisite is missing, Cairn writes a `knowledge_gap` record with `missing_skill: <id>` — so subsequent evolution has a directed target.
- **Public skill catalogs.** When `wiki/skills/` is shared cross‑user (via PropagationWorkflow), the dependency graph is shared with it; consumers pull the closure, not the leaf.

This is what makes skills *compound* — `strategy_success` stays strategy‑scoped, but its dependency closure lets the agent assemble bigger plans turn‑after‑turn.

## 12. Deployment Tiers — Same Interfaces, Different Adapters [P0 embedded · P1 local · P2 cloud]

| Tier | Priority | Who it's for | Adapters | Cloud? |
|------|----------|--------------|----------|--------|
| **Embedded** | **P0** | library mode inside a harness; CI runners; offline / air‑gap first run | **Pure SQLite + `sqlite-vec` + `candle`** — `.cairn/cairn.db` with FTS5 (records + WAL + consent), statically-linked `sqlite-vec` for ANN, and a pure-Rust `candle` runtime loading a small embedding model (~25 MB, downloaded once into `.cairn/models/`). `LLMProvider` in-process, `tokio` job runner. **No Python, no Nexus, no embedding key.** `search` ships all three modes — `keyword`, `semantic`, `hybrid` — at v0.1. Semantic is only rejected when the user sets `search.local_embeddings: false`. | none |
| **Local** | **P1** | laptop, single user, researcher who wants richer semantic + BM25 + multi-modal parsers | Embedded **+ Nexus `sandbox` profile** sidecar (Python: BM25S + richer parsers + `litellm` providers + ReDB metastore + CAS blob store under `nexus-data/`). `.cairn/cairn.db` is unchanged; Nexus is additive. `search` retains all three modes; Nexus offers `litellm` as an **alternative** embedding backend when the user wants larger vectors than the local small model. `semantic_degraded=true` only flips on transient provider outages. | none |
| **Cloud** | **P2** | team / enterprise with shared memory | Local **+ federation** — sandbox instances delegate cross-tenant queries to a shared Nexus `full` hub (PostgreSQL + pgvector + Dragonfly) over HTTPS + mTLS. Any OpenAI-compatible LLM. Optional Temporal orchestrator | yes |

Switching tiers is a change in `.cairn/config.yaml` (`store.kind: sqlite` → `nexus-sandbox` → `nexus-full`). The vault on disk, the four contract surfaces (CLI · MCP · SDK · skill), the CLI commands, the hooks — all unchanged.

## 11.b Skillify — turning every failure into a permanent skill with tests [P1 base · P2 agent-authored]

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

**Skillify pipeline — from one directive to durable skill:**

```
  User: "great! so we should actually remember this — skillify it"
    │
    ▼
  ┌─ STAGE 1: Extract (from conversation trace)
  │   trace → decision tree → tool-call sequence → success criteria
  │   output:  skill-spec.draft.json
  ▼
  ┌─ STAGE 2: Author the ten artifacts (LLM + code gen)
  │   ┌───────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
  │   │ 1. skill_*.md         │  │ 2. scripts/<s>.mjs   │  │ 3. unit tests    │
  │   │    (contract)         │  │    (deterministic)   │  │    (fixtures)    │
  │   └───────────────────────┘  └──────────────────────┘  └──────────────────┘
  │   ┌───────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
  │   │ 4. integration tests  │  │ 5. LLM evals         │  │ 6. resolver trig.│
  │   │    (real endpoints)   │  │    (rubric judge)    │  │    (catalog row) │
  │   └───────────────────────┘  └──────────────────────┘  └──────────────────┘
  │   ┌───────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
  │   │ 7. resolver eval      │  │ 8. check-resolvable  │  │ 9. E2E smoke     │
  │   │    (false +/- cases)  │  │    + DRY audit       │  │    (prompt→out)  │
  │   └───────────────────────┘  └──────────────────────┘  └──────────────────┘
  │                                           ┌──────────────────┐
  │                                           │ 10. filing rules │
  │                                           │    (files_to:)   │
  │                                           └──────────────────┘
  ▼
  ┌─ STAGE 3: Gate (§11.3 promotion predicate — version-scoped subset)
  │   v0.1 subset: gates 1-6 (tests, size, semantic preservation, caching, confidence, review)
  │   v0.2:        + gate 7  (held-out adversarial)
  │   v0.3+:       + gates 8-9 (canary rollout, shared-tier gate) — full predicate
  │   any failure → status stays `candidate`; lint report surfaces the gap
  ▼
  ┌─ STAGE 4: Promote (PromotionWorkflow)
  │   skill_*.md → `live` ; resolver row activated ; `wiki/skills/` updated ; signed bundle
  ▼
  ┌─ STAGE 5: Daily health check (`cairn lint --daily`, runs every 24 h)
      unit + integration + LLM eval + resolver eval + DRY + check-resolvable + filing-rules
      first failure → badge red, `knowledge_gap` record, lint-report.md updated
      ⇒ silent rot structurally impossible
```

**Two failure paths feeding back into the same pipeline:**

```
     failure class         feedback hook                    skillify triggered?
  ┌────────────────────┬────────────────────────────────┬──────────────────────┐
  │ hallucinated tool  │ PostToolUse hook notices tool  │ yes — auto-skillify  │
  │ call / wrong arg   │ error + agent retry sequence   │ with blocking review │
  ├────────────────────┼────────────────────────────────┼──────────────────────┤
  │ ad-hoc procedure   │ user types "skillify this"     │ yes — user-triggered │
  │ that worked        │                                │ no blocking review   │
  └────────────────────┴────────────────────────────────┴──────────────────────┘
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

## 12.a Distribution Model — Beyond Single‑User [P2]

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

**Federation flow — how a `search` query fans out from sandbox to hub:**

```
                             ┌────────────────────────────────┐
                             │   Nexus `full` hub (shared)    │
                             │   Postgres + pgvector + Dragonfly │
                             │   holds tier ∈ {team,org,public}│
                             └──────────────┬─────────────────┘
                                            │  (HTTPS, mTLS, RBAC via rebac)
                                            │
           ┌────────────────────────────────┼───────────────────────────────┐
           │                                │                               │
  ┌────────┴─────────┐              ┌───────┴──────────┐            ┌───────┴──────────┐
  │  Alice's laptop  │              │  Bob's laptop    │            │  CI runner       │
  │  sandbox vault   │              │  sandbox vault   │            │  sandbox vault   │
  │  private+session │              │  private+session │            │  ephemeral       │
  │  tier local only │              │  tier local only │            │                  │
  └────────┬─────────┘              └──────┬───────────┘            └─────┬────────────┘
           │                               │                              │
           │   search("pgvector perf")     │                              │
           ├───────────────────────────────┴──────────────────────────────┘
           │     1. sandbox runs local BM25 + sqlite-vec over own vault  (<15 ms p95)
           │     2. if scope includes team|org|public → federate to hub  (asynchronous)
           │     3. hub query runs on Postgres + pgvector; rebac drops non-readable rows
           │     4. merge + re-rank; return to caller with provenance_per_hit
           │     5. on hub timeout → stamp `semantic_degraded=true`, return local-only
           ▼
   agent gets combined result set, knows exactly which hits came from local vs hub
```

**The failure modes this topology handles:**

| Scenario | What happens | Why it's safe |
|----------|--------------|----------------|
| Hub unreachable | Sandbox returns local‑only results with `degraded: hub_unreachable` | No query ever blocks; agent knows result set is partial |
| Hub down + user writes | Writes stay in sandbox's local WAL; `PropagationWorkflow` resumes on reconnect | Local vault is the source of truth; hub is a projection |
| rebac revokes a team grant mid‑query | Hub drops non‑readable rows atomically; query still returns readable rows | Filter lives at the store layer; caller never sees leaked rows |
| Federation is off but a write targets `team` tier | Write fails fast with `FederationRequired`; no silent downgrade | Visibility tier is never silently lowered |
| Forget‑me crosses the boundary | Local Phase A/B runs; same verb fans out to hub via `forget` extension; hub deletes its projection under its own WAL | Two‑file durability topology applies to both sandbox and hub independently |

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

## 13. UI / UX [P0 markdown · P1 GUI alpha · P3 GUI GA]

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

### 13.3 Commands — the ground truth; MCP wraps these (§8.0)

```
# Core verbs — canonical spelling matches §8 verb IDs, MCP frames, and SDK function names.
# Verb IDs use underscores (assemble_hot, capture_trace). CLI names match verb IDs exactly.
# A single IDL generates the CLI clap tree, MCP schemas, SDK signatures, and SKILL.md triggers —
# a CI lint fails on any drift. No dash aliases exist.

cairn ingest <file|url|-->       verb 1 — ingest a source / record
cairn search <query>             verb 2 — search (keyword P0, +semantic P1, +federation P2)
cairn retrieve <id>              verb 3 — retrieve a specific record
cairn summarize <query>          verb 4 — summarize (optional --persist)
cairn assemble_hot               verb 5 — print the hot prefix
cairn capture_trace <file>       verb 6 — capture a reasoning trajectory
cairn lint                       verb 7 — health check; writes .cairn/lint-report.md
cairn forget --record|--session  verb 8 — delete (capability-gated per runtime)

# Vault / session / operator commands (not core verbs; management-only):
cairn init                       scaffold vault + config
cairn bootstrap                  20‑min first‑session interview → purpose.md + seed memories
cairn vault list|switch|add|remove    vault registry (§3.3)
cairn session tree|fork|clone|switch|merge    session-as-tree primitives (§5.7)
cairn standup                    pretty print of `assemble_hot` + recent log entries
cairn mcp                        stdio MCP adapter that wraps the same verbs (§8.0)
cairn serve                      HTTP + SSE server (alternate protocol adapter)
cairn ui                         open desktop GUI (Electron by default; Tauri when configured)
cairn sensor <name> enable       interactive consent prompt
cairn skill install              install SKILL.md for the active harness (§18.d)
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
| **P0 MemoryStore** — records + FTS5 + WAL + replay + consent in `.cairn/cairn.db` via `rusqlite` | Rust (direct, in-process) | hot path; one local SQLite file; zero network; sub-ms queries |
| **P1 MemoryStore extensions** — semantic/hybrid search + CAS projection via the Nexus sandbox sidecar | Rust client over HTTP / MCP; Nexus sandbox itself is Python | P1 adds the sidecar **additively** alongside the unchanged `.cairn/cairn.db`; Rust does connection pooling, retry, circuit breaker; Python owns the sandbox indexes |
| Squash, rank, scope resolve, classify | Rust | pure functions over bytes; benefits from no runtime |
| Durable job runner (default) | Rust | `tokio` + SQLite‑backed job table; crash‑safe; single binary, no external service |
| Temporal worker (optional cloud) | Rust *or* TypeScript | Rust via `temporalio-sdk` / `temporalio-client` (prerelease, on crates.io) when users accept prerelease; TS sidecar with the GA Temporal TS SDK when they don't |
| Pipeline orchestration + MCP server | Rust | single binary for the core |
| CLI (Ink TUI, slash commands, dev loop) | TypeScript / Bun *optional companion* | ecosystem, fast iteration, `bunx`/`npx` distribution for the optional companion TUI — not the main `cairn` binary |
| Electron shell / renderer | TypeScript + React | Electron is Node; renderer is web |
| Hook scripts | TypeScript | same as every harness's scripting ecosystem |
| Cairn internal libs consumed by harnesses | TypeScript | L0/L1/L2 package pattern stays TS so harnesses can import in‑process |

The Rust core is **a single binary** shipped with both the CLI and the GUI. TypeScript packages on the harness side talk to it via whichever surface fits: CLI subprocess (most common; zero protocol overhead), MCP (for harnesses that already speak it), or a Cairn skill (for harnesses with only a bash tool). A harness never links against the Rust core — it always crosses a process boundary through one of the four surfaces in §8.0.

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
- Temporal workflow IDs — exposed via `cairn capture_trace --trace-id <id>` CLI
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
- **Contract parity with the rest of the kernel.** `FrontendAdapter` is contract 7 of 7 in §4, sitting next to `MemoryStore`, `LLMProvider`, `WorkflowOrchestrator`, `SensorIngress`, `MCPServer`, and `AgentProvider`. Same registration, same capability tiering (§4.1), same fail‑closed default. Priority **P1** — opt-in, activates the moment any editor / plugin / GUI adapter is registered. Headless P0 vaults run without it and re-ingest out-of-band markdown edits via `cairn ingest --resync <path>`; P1 adapters (`cairn-frontend-obsidian`, `cairn-frontend-vscode`, `cairn-frontend-logseq`, `cairn-frontend-desktop`) ship with the v0.2 GUI alpha promise (§13).
- **Multiple adapters can run at once.** User runs `@cairn/frontend-obsidian` on their laptop and `@cairn/frontend-vscode` on their work machine against the same backend. Cairn fans projections to every registered adapter.
- **Testable in isolation.** Each adapter has its own test suite; core ships a conformance harness (same pattern as `MemoryStore` conformance tests) — every adapter must pass the same round‑trip + conflict‑resolution cases.

This keeps Cairn headless‑by‑default and frontend‑agnostic in the strongest sense: the core doesn't import Obsidian, doesn't import Electron, doesn't import VS Code APIs. It just calls `adapter.project(...)` and trusts the adapter to know its frontend.

### 13.6 Non‑goals for UI

- Not an Obsidian clone; not a Notion clone.
- No built‑in project management.
- No AI chat window — the harness is the chat window; Cairn is the memory.

---

## 14. Privacy and Consent [P0]

**Consent flow — every sensitive action crosses one of these gates:**

```
    ┌─────────────────────────────┐
    │  user action / sensor event │
    └─────────────┬───────────────┘
                  ▼
        ┌─────────────────────┐
        │ Presidio redaction  │  PII/secrets stripped pre-persist
        │ (pre-persist gate)  │  → dropped bytes never hit disk
        └─────────┬───────────┘
                  │
                  ▼
        ┌─────────────────────┐
        │ scope check (§4.2)  │  caller's scope tuple permits this kind+tier?
        └─────────┬───────────┘
           pass │  │ fail → reject with policy_trace
                ▼
        ┌─────────────────────┐
        │ visibility decision │  start at private or session (§6.3)
        └─────────┬───────────┘
                  ▼
        ┌─────────────────────┐
        │  WAL upsert (§5.6)  │  + consent_journal row committed atomically
        └─────────┬───────────┘
                  │
                  ▼          ────────────────────────────────────────
        ┌─────────────────────┐                                      │
        │ consent_log_        │  async tail → .cairn/consent.log     │
        │ materializer        │  (append-only; never edited; never   │
        │ (background)        │  deleted; survives GDPR review)      │
        └─────────────────────┘                                      │
                                                                      │
                                                                      │
    LATER: promotion across tiers                                     │
    ┌─────────────────────┐                                           │
    │ agent proposes      │──► needs HumanIdentity signature         │
    │ private → project   │    (or project lead) before applying ────┘
    │ private → team      │    every promotion writes a new
    │ project → org       │    consent_journal row
    │ org → public        │    irreversible via "unshare" —
    └─────────────────────┘    only forget can remove content
```

- **Local‑first default.** First run writes only to disk.
- **Per‑sensor opt‑in.** Screen, clipboard, web clip, terminal — each requires explicit enable with a consent prompt.
- **Pre‑persist redaction.** PII detection and masking before a record hits disk; secrets never reach the vault.
- **Per‑user salt.** Pseudonymized keys; forget‑me is a hash‑set drop, not a scan.
- **Append‑only `consent.log`.** Every share / promote / propagate writes a line. Never edited. Never deleted.
- **Exportable.** The vault *is* the export; `cairn export` is a `tar` of markdown.
- **Deny by default.** On any policy or ReBAC check failure — deny.
- **Propagation requires user assent.** Agents can *request* promotion; only users *grant* it.

---

## 15. Evaluation [P0 core · P1 full SRE]

**The eval harness — one pipeline, four checks, runs on every PR:**

```
     cassette fixtures + golden queries + scenarios
            │
            ▼
  ┌────────────────────────────────────────────────────┐
  │  Replay engine — deterministic, no LLM, no network │
  │  (loads cassette → feeds into cairn verbs)         │
  └─────────┬────────────┬────────────┬────────────────┘
            │            │            │
            ▼            ▼            ▼
      ┌────────────┐ ┌──────────┐ ┌────────────────┐
      │  Golden    │ │ Multi-   │ │  Metrics:      │
      │  queries   │ │ session  │ │  · orphans     │
      │  (exact    │ │ coherence│ │  · conflicts   │
      │  match or  │ │ (5-50    │ │  · staleness   │
      │  within    │ │ sessions │ │  · recall_rate │
      │  ε)        │ │ each)    │ │  · latency     │
      └─────┬──────┘ └────┬─────┘ └───────┬────────┘
            │             │               │
            └─────────────┴───────────────┘
                          │
                          ▼
              ┌─────────────────────────┐
              │  CI regression gate     │
              │  fails build if any     │
              │  metric drops > 2% or   │
              │  a golden query breaks  │
              └─────────────────────────┘

  SLOs enforced at the gate (per §18 targets):
    · p95 turn latency with hot-assembly + write   < 50 ms
    · p99 turn latency                             < 100 ms
    · forget-me reader-invisible latency (1M recs) < 1 s p95
    · forget-me physical purge (Phase B)           < 30 s p95
    · cold-rehydration (≤ 10 MB session)           < 3 s p95
```

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

## 16. Distribution and Packaging [P0 binary · P3 full channels]

- `brew install cairn` (macOS / Linux) — Homebrew tap; single static Rust binary (~15 MB), no runtime deps.
- `cargo install cairn` — install from crates.io for Rust users.
- **DMG / MSI / AppImage / deb / static tarball** — platform packages for the Rust binary plus the Electron desktop shell; a slim Tauri build is available for air‑gap / bandwidth‑constrained users.
- `cairn mcp` — stdio MCP server (Rust core) that any harness registers in its MCP config.
- `winget install cairn` / Scoop bucket — Windows package managers.
- Koi integrates via a thin L2 package that bridges the harness's internal middleware to Cairn MCP.

**Monorepo shape (polyglot: Rust core + TypeScript shell + Electron renderer).** Everything outside `cairn-core` is a plugin using the registration path from §4.1 — no internal shortcuts. Third‑party plugins live in their own repos and are listed in `.cairn/config.yaml` exactly like the bundled ones.


```
cairn/
├── crates/
│   ├── cairn-core             Rust — L0 types, pure functions, MCP server
│   ├── cairn-jobs             Rust — default orchestrator (`tokio` + SQLite job table)
│   ├── cairn-jobs-temporal    Rust — optional Temporal adapter via `temporalio-sdk` / `temporalio-client` (prerelease)
│   ├── cairn-store-sqlite     Rust — MemoryStore on pure SQLite + FTS5 + filesystem (default P0; zero deps, no network, no Python)
│   ├── cairn-store-nexus      Rust — MemoryStore HTTP/MCP client into a Nexus `sandbox` sidecar (opt‑in P1; unlocks BM25S + sqlite-vec hybrid)
│   ├── cairn-nexus-supervisor Rust — spawns + health‑checks + restarts the Python Nexus sidecar (P1 opt‑in, pulled in by `cairn-store-nexus`)
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

## 16.a Replacing Existing Memory Systems [P2]

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

### Koi v1 (this repo, `archive/v1/`) — forge · context‑arena · ACE

Cairn is designed to replace the three memory‑adjacent meta‑packages in Koi v1 with one coherent substrate. Each v1 surface maps to a Cairn section; the behaviors are preserved, the implementation collapses.

| Koi v1 surface | Purpose in v1 | Cairn equivalent | Notes |
|----------------|---------------|-------------------|-------|
| `@koi/forge` | Self‑extension: agent composition, verification, integrity attestation, policy enforcement | §11 `EvolutionWorkflow` + §11.b Skillify + §4.2 actor_chain + §14 ConsentReceipt | `configured-koi`, `forge-bootstrap`, `forge-middleware-stack` become a thin wiring layer above Cairn's 5 contracts; policy lives in §4.2 scope tuples + rebac |
| `@koi/context-arena` | Compose personality + bootstrap + conversation + memory into the model context with budget allocation | §7 `HotMemoryAssembler` + §5.5 FlushPlan + §7.1 `AutoUserProfile` | ContextArenaPreset (conservative / balanced / aggressive) maps to `hot_memory.budget_profile` in `.cairn/config.yaml` |
| `@koi/middleware-ace` + `@koi/ace-types` | Trajectory capture → reflection → curation → playbook generation | `capture_trace` verb (§8) + §6.1 `trace` / `reasoning` / `strategy_success` / `strategy_failure` / `playbook` MemoryKinds + §10 `ReflectionWorkflow` / `ConsolidationWorkflow` / `PromotionWorkflow` | v1's `TrajectoryEntry` → a `trace` record; `Playbook` / `StructuredPlaybook` → a `playbook` record; `Reflector` / `Curator` / `Generator` → three durable workflows |
| `@koi/memory-fs` | Filesystem‑backed memory store | §3 vault layout + Nexus `sandbox` profile as default `MemoryStore` | v1's fs‑only store becomes one adapter among many; same markdown on disk, now with BM25 + vector + graph for free |
| `@koi/middleware-hot-memory` | Hot‑memory prefix injection | §7 `HotMemoryAssembler` | direct 1:1 |
| `@koi/middleware-compactor` | Rolling compaction of long threads | §10 `ConsolidationWorkflow` (rolling‑summary pass) | US4 rolling summary maps to this; cadence configurable per agent |
| `@koi/middleware-context-editing` | Prune tool results to stay under budget | §5.2 Tool‑squash stage + §5.5 FlushPlan | squash rules + plan‑then‑apply |
| `@koi/middleware-user-model` | Classify user intent, maintain user profile | §7.1 `AutoUserProfile` + `UserSignalDetector` (pure fn) + `user` / `feedback` / `user_signal` MemoryKinds | same classification, typed records instead of in‑middleware state |
| `@koi/middleware-conversation` | Thread + turn persistence | §8.1 Session lifecycle + §18.c US1 turn schema | `session_id` + `turn_id` monotonic, same shape |
| `@koi/middleware-collective-memory` | Shared memory across agents/users | §10.0 Cross‑user aggregate + §12.a distribution (share_link, federation) | anonymized aggregates via `cairn.aggregate.v1` extension |
| `@koi/snapshot-chain-store` + `@koi/snapshot-store-sqlite` | Append‑only event chain for audit | §5.6 `wal_ops` + §14 `consent_journal` + append‑only `consent.log` | WAL + consent journal subsume the chain‑store; Nexus `versioning` brick adds undo |
| `@koi/skill-stack` | Skill definition + discovery + loading | §11.b Skillify + Nexus `catalog` brick (§4.2) + resolver (Classifier pure fn) | v1 skills become first‑class records with `lane` + 10‑step checklist |
| `@koi/tool-squash` | Squash verbose tool outputs | §5.2 Tool‑squash stage | direct 1:1 |
| `@koi/transcript` / `@koi/session-store` / `@koi/session-state` | Session state + transcript persistence | §3 `raw/trace_*.md` + §8.1 session lifecycle + §5.6 WAL durability | one substrate, not three packages |

**How Koi uses Cairn after the cutover:**

```
Koi harness (Rust agent loop + middleware stack)
      │
      │  CLI subprocess (default) / MCP / SDK / skill — pick your surface
      ▼
Cairn Rust static binary (cairn <verb>  OR  cairn mcp)
      │
      ├─► .cairn/cairn.db      (WAL · replay · locks · consent journal · records
      │                         at P0 via FTS5; at P1+ still here for control plane)
      │
      └─► nexus-data/           (P1+ only — BM25S lexical index · sqlite-vec ANN
                                 · CAS blob store · ReDB metastore; internal layout
                                 is Nexus's concern, not Cairn's)
                                 Cairn reaches Nexus only over HTTP+MCP, never opens
                                 files inside nexus-data/ directly.
```

No Koi‑side code writes to disk directly; every mutation goes through Cairn's 8 MCP verbs. The v1 meta‑packages above are either (a) replaced by a Cairn L2 plugin, (b) collapsed into the core pipeline, or (c) deleted because Cairn handles the concern end‑to‑end.

**What Koi still owns after cutover:** the agent loop itself (model calls, tool dispatch, middleware chain composition), harness‑specific I/O (CLI, channels, hooks), and whatever it layers on top of Cairn (Koi‑specific workflows, UI, integrations). Memory is no longer Koi's problem.

**Migration path (v1 → Cairn):**

1. Install `cairn` Rust binary; `cairn init` a vault in the Koi workspace.
2. Run `cairn import --from koi-v1 archive/v1/` — walks `@koi/memory-fs`, ACE trajectory stores, snapshot chains, session stores, and skill directories; writes typed records into the new vault with provenance links.
3. Flip Koi's runtime config: `memory.provider: cairn-mcp` (was `memory-fs` / `@koi/memory-fs`). Middleware stack drops `compactor`, `context-editing`, `ace`, `hot-memory`, `user-model`, `conversation` — the thin layer on top of Cairn replaces all of them.
4. Delete the corresponding v1 meta‑packages or move them to `archive/legacy/` for audit.

This matches the v0.1 reference‑consumer plan (§19): Claude Code is the anchor harness in v0.1; Koi's own harness lands in v0.2 as the second consumer once the capability matrix reaches the full P1 surface.

### Common pattern

All four (plus Koi v1) migrations share the same three steps:

1. **Import once** — `cairn import --from <system>` produces a Cairn vault with provenance links back to the source system's files.
2. **Dual‑run briefly** — both the legacy memory and Cairn stay active; reads prefer Cairn; writes fan to both. Lets you validate parity on real turns.
3. **Cut over** — legacy becomes a one‑way export target for audit; Cairn is the source of truth.

Nothing in these migrations requires the legacy system to change. Cairn exposes eight verbs through four surfaces (§8.0) — every legacy stack can call whichever fits: the `cairn` CLI from a shell plugin, `cairn mcp` for MCP-speaking harnesses, the Rust SDK for in-process embedding, or the Cairn skill for bash-only environments.

---

## 17. Non‑Goals (what Cairn will never be)

Every line below follows the pi‑mono pattern: **"Not X — you might expect X because Y. Use Z instead."** The point is to pre‑empt the five most common category errors and redirect without argument.

**Decision tree — pick the right tool first:**

```
  What do you need?
      │
      ├─► Run an agent loop + tools + model calls
      │       └─► NOT Cairn.  →  Use Claude Code · Codex · Gemini · pi-mono
      │
      ├─► Persist typed memory across sessions and hand it to your agent
      │       └─► Cairn. ✓
      │
      ├─► Vector search at scale across 100M+ records
      │       └─► Partly Cairn (sandbox) + your vector DB (full profile path)
      │            →  Use Postgres+pgvector or Qdrant behind MemoryStore trait
      │
      ├─► IAM / SSO / role assignments / auth provider
      │       └─► NOT Cairn.  →  Use Okta · Azure AD · Google Workspace
      │            Cairn signs envelopes with your resolved principal.
      │
      ├─► Schedule durable background jobs
      │       └─► Partly Cairn (tokio default) + your runner (Temporal adapter)
      │            →  Keep tokio default unless ops already runs Temporal
      │
      ├─► Ship a desktop GUI for knowledge browsing
      │       └─► Optional Cairn + your editor.  →  Use Obsidian · VS Code · Logseq
      │            Cairn's Tauri GUI is small on purpose; it never owns the data
      │
      ├─► Run a built-in "standup bot" or "brag doc" feature
      │       └─► NOT Cairn.  →  Build it as a user-space template on top of cairn verbs
      │
      ├─► Distribute skills publicly via marketplace
      │       └─► NOT Cairn v0.1.  →  Use cairn share for peer-to-peer .nexus bundles
      │            Public indexing is out of scope until v0.3+
      │
      └─► Casual "ChatGPT-style memory toggle"
              └─► Cairn L1 (§18.a).  →  cairn skill install + "remember that..." triggers
                    Same primitives underneath; just lighter-weight UX
```

**The non-goal list below elaborates each branch.**


- **Not a harness.** You might expect one because every other memory framework ships a loop. Cairn has no agent loop, no tool executor, no opinionated LLM adapter beyond `LLMProvider`. → **Use** Claude Code, Codex, Gemini, pi‑mono, or your own loop; register `cairn mcp` as a tool.
- **Not a scheduler of last resort.** You might expect Temporal‑grade durability to be required because we talk about `WorkflowOrchestrator`. The v0.1 default is `tokio` + a SQLite job table — crash‑safe, single binary, zero external services. → **Use** the default orchestrator; swap to Temporal only when your ops team already runs it. Durability + idempotency guarantees apply to both; see §10 truth table.
- **Not a vector database.** You might expect a dedicated pgvector / Pinecone / Weaviate dependency. The Nexus `sandbox` profile ships SQLite + `sqlite-vec` + `litellm` embeddings as the default vector path via the `search` brick, and it is enough for millions of records per vault. → **Use** the sandbox profile for L1/L2; swap to the `search` brick's Postgres adapter when you cross the single‑SQLite ceiling.
- **Not a UI framework.** You might expect a full IDE‑style surface because of the §13 UI section. The desktop GUI is optional, purposely small (browse/edit/graph/consent), and never a prerequisite. → **Use** Obsidian, VS Code, Logseq, or raw Markdown via the FrontendAdapter contract (§13.5.c); the vault is plain files.
- **Not an IAM engine.** You might expect role assignments, SSO, identity providers, because we talk about actors, visibility, and tenant scopes. `MemoryVisibility` is a tag; `rebac` is a query‑time filter. → **Use** your existing IAM (Okta / Azure AD / Google Workspace); pass the resolved principal into the signed envelope's `issuer` field.
- **Not an application.** You might expect built‑in "brag doc", "standup template", "review brief", "knowledge wiki" features. Those are opinionated user‑space compositions, not framework primitives. → **Use** templates that sit on top of Cairn's verbs (`templates/<domain>/`), or build your own — every domain has different vocabulary.
- **Not a chat memory plugin.** You might expect a one‑click ChatGPT‑style "memory" toggle. Cairn is a substrate; every capture is explicit (hook event, signed envelope, consent journal) so it survives audit and forget‑me. → **Use** L1 "tell it directly" triggers (§18.a) if you want the casual chat experience — they run over the same primitives.
- **Not a skill registry.** You might expect npm / PyPI / marketplace distribution of skills. Skills live inside a vault, shipped via `.nexus` bundles under consent‑gated share links (§12.a). → **Use** `cairn share` for peer‑to‑peer skill handoff; public indexing is opt‑in and out of scope for v0.1.

---

## 18. Success Criteria [P3 — v1.0 targets]

1. **Adoption.** Three independent harnesses call Cairn's eight verbs (via CLI, MCP, SDK, or skill — pick the one that fits) in v0.1; ten by v1.0.
2. **Standalone proof.** `cairn init` on a fresh laptop (no network), works end‑to‑end.
3. **Latency.** p95 harness turn with Cairn MCP hot‑assembly < 50 ms.
4. **Privacy.** `forget-me` on a 1M‑record vault: reader‑invisible within 1 s p95 (Phase A tombstones + fence closed), physical purge within 30 s p95 (Phase B); append‑only consent log survives GDPR review.
5. **Evaluation.** Golden queries + multi‑session coherence + orphan / conflict / staleness metrics all regression‑tested in CI.
6. **Local‑first.** Zero code changes to move from embedded → local → cloud; only `.cairn/config.yaml`.
7. **Maintenance is a command.** Weekly `cairn lint` + continuous Temporal workflows keep the vault healthy without manual cleanup.

---

## 18.a Progressive Adoption — three ways to use Cairn

Users don't have to commit to the full stack on day one. Cairn is designed to be useful at three levels of commitment, each a superset of the last.

```
     L3 ─ Second brain with continuous learning         1-2 hours · P1-P2
     ─────────────────────────────────────────────     ───────────────────
      + source sensors (Slack · email · GitHub · web)   + Nexus sandbox
      + Light/REM/Deep dream tiers running overnight    + sqlite-vec semantic
      + desktop GUI (Tauri) for browsing + graph view   + ReflectionWorkflow
      + EvolutionWorkflow auto-promotes skills          + EvolutionWorkflow
      + auto-built user profile refreshes daily
                              ▲
                              │  (same vault; turn on a config flag)
                              │
     L2 ─ File-based vault on disk                      5 minutes · P0-P1
     ─────────────────────────────────────────────     ───────────────────
      + cairn init scaffolds ~/vaults/<name>/            + purpose.md
      + raw/ tree (plain markdown, one file per record)  + CLAUDE.md
      + .cairn/cairn.db (WAL + identity + consent log)   + AGENTS.md / GEMINI.md
      + git works (diff, blame, revert)                  + cairn snapshot weekly
      + any editor works (Obsidian, VS Code, vim, Typora)
                              ▲
                              │  (cairn init "claims" the existing L1 memories)
                              │
     L1 ─ Zero-config in your harness                    30 seconds · P0
     ─────────────────────────────────────────────     ───────────────────
      + install the cairn binary                         + brew install cairn
      + register cairn mcp OR install the cairn skill    + cargo install cairn
      + "tell it directly" triggers (§11.6):             + winget install cairn
         "remember that I prefer X"  → user memory
         "forget what I said about Y" → forget verb
         "what do you know about Z?"  → search
      + eight core MCP verbs usable from any chat
```

**You can live at any level indefinitely.** L1 is fine for casual use. L2 gives you portability. L3 gives you compounding knowledge. Each level is a superset; you don't rewrite anything to move up.

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
- Retrievable independently via `RetrieveArgs::Turn` (§8.0.c): `retrieve({target:"turn", session_id, turn_id, include:["tool_calls"]})` — turn IDs are monotonic *per session*, so the `(session_id, turn_id)` pair is always required. Or use `search(kind: "trace", tool: "<name>")` for cross-session tool-call queries.
- Sections: §6.1 MemoryKind (`trace`), §9.1 Sensors (Hook sensor, Neuroskill sensor), §5.2 Write path.

### P2 stories

**US6 — Automatically archive inactive sessions (SRE).**
- `ExpirationWorkflow` transitions records through tiers: **hot** (active sessions, SQLite primary) → **warm** (idle 7+ days, still in SQLite but evicted from LRU) → **cold** (idle 30+ days, moved into Nexus `snapshot` bundles on object storage).
- Metadata stays hot: session title, summary, actor chain, turn count, ConsentReceipts, search‑index terms — all remain in the primary index so `search` hits a cold session at the same latency as a warm one.
- Hydration: `retrieve(session_id)` on a cold session triggers `rehydrate` which unpacks the snapshot and restores to warm for the next hour. **Budget ≤ 3 s p95 for ≤ 10 MB sessions** (§15 regression gate).
- SRE observability: §15 includes per‑tier latency histograms, archive/hydration counts, and storage‑cost metrics exported via OpenTelemetry.
- Sections: §3.0 Storage topology, §10 Workflows (Expiration), §15 Evaluation.

### P3 stories

**US7 — Search across prior conversations and memories (SRE + Developer).** *Version‑scoped; matches the sequencing matrix, not a single "P3" box.*
- **v0.1 (keyword only, capability-gated rejection — no silent fallback).** `search(mode: "keyword")` runs SQLite **FTS5** over the local `.cairn/cairn.db` — no Python, no embedding key, no network. `mode: "semantic"` or `"hybrid"` is **rejected with `CapabilityUnavailable`** on v0.1 runtimes, per the §8.0 verb 2 capability gate — clients must inspect `status.capabilities` for `cairn.mcp.v1.search.semantic` / `.hybrid` before issuing those modes. There is no silent FTS5 fallback; fail-closed is the only behavior. A wire-compat CI test (§15) asserts that a v0.1 runtime rejects unadvertised search modes. (The `semantic_degraded` flag still exists on read responses but is only set when a v0.2+ runtime has a *transient* embedding-provider outage, not as a v0.1 degraded mode.)
- **v0.2 (semantic + hybrid via Nexus sandbox).** `cairn-store-nexus` (§13) is enabled; `mode: "semantic"` now uses `sqlite-vec` ANN with `litellm` embeddings (OpenAI / local Ollama / Cohere) inside the Nexus `sandbox` sidecar, and `mode: "hybrid"` blends **BM25S** keyword scores with semantic scores via Nexus's `search` brick. `semantic_degraded` flips to `false`.
- **v0.3 (cross‑tenant federation, true P3).** `search(federation: "on")` fans out to other Cairn vaults the caller has been granted `ShareLinkGrant` for; results merge across vaults with per‑source provenance. Requires the `cairn.federation.v1` extension namespace (§8.0.a).
- Results shape (all versions): every hit returns `{record_id, snippet, timestamp, session_id, score, actor_chain, vault_id?}` so SRE audits and developer reuse both have full provenance.
- RBAC: `rebac` brick (§4.2) enforces tenant + role + visibility at query time on every tier; results the caller can't read are dropped at the MemoryStore layer, never surfaced. Caller sees the filter count (`results_hidden: N`) without seeing the hidden records themselves.
- Sections: §8 MCP Surface, §5.1 Read path, §4.2 Identity + rebac, §6.3 Visibility, §13 `cairn-store-sqlite` (P0) / `cairn-store-nexus` (P1).

**US8 — Delete a specific session and memories (Customer + SRE).**
- **Record‑level delete ships in v0.1.** `cairn forget --record <id>` — or the MCP verb `forget` with `mode: "record"` — runs the full §5.6 `delete` Phase A (logical tombstone + index drains committed atomically) plus Phase B physical purge. Irretrievable: `search` and `retrieve` return `not_found` as soon as Phase A commits.
- **Session‑level delete ships in v0.2.** `cairn forget --session <id>` (MCP `forget` with `mode: "session"`) is advertised only by v0.2+ runtimes via `status.capabilities` (see §8 verb 8 row). v0.1 clients receive `CapabilityUnavailable` if they attempt a session mode. Session delete adds the chunked fan‑out, `reader_fence` closure in the last chunk's transaction, and exclusive session lock (§5.6 delete row + lock compatibility matrix).
- Immutable audit (both modes): every delete writes an entry to the `consent_journal` table inside `.cairn/cairn.db` atomically with the state change; the `consent_log_materializer` then appends it to `.cairn/consent.log` asynchronously. The deletion itself is auditable forever; the *content* deleted is unrecoverable after Phase B purge.
- Record vs. session delete semantics are identical per child; the only difference is the transaction boundary (one record vs. a chunked fan‑out under exclusive session lock).
- Sections: §14 Privacy and Consent, §10 Workflows (forget‑me fan‑out), §5.6 WAL.

### Personas — explicit coverage

| Persona | Primary goal | Cairn surface that serves it |
|---------|--------------|--------------------------------|
| **Agent (Service Account)** | fast R/W for chat context | MCP verbs (§8), sub‑5 ms retrieve from local SQLite, hot‑memory prefix always < 25 KB (§7) |
| **SRE (Maintainer)** | observability, archival, compliance | `/health`, OpenTelemetry metrics per workflow (§15), tier‑migration + hydration dashboards, `consent.log` audit, forget‑me workflow, `cairn lint` CI gate |
| **Agent Developer** | APIs for entity memory, search, summaries | Seven contracts (§4 — five P0 + FrontendAdapter P1 + AgentProvider P2), plugin architecture (§4.1), conformance tests (including FrontendAdapter round-trip + conflict-resolution checks at v0.2 and AgentProvider tool-allowlist + scope + cost-budget checks at v0.3), CLI + SDK bindings (§13), golden‑query regression harness (§15) |

### Coverage summary — priorities match §0 legend and §19 sequencing

| Story | Sub-capability priority | Covered | Sections |
|-------|-------------------------|---------|----------|
| US1 turn sequence | **P0** | v0.1 | §3, §5.1, §6.1, §8.1, §15 |
| US2 session reload — active | **P0** | v0.1 | §3, §5.6 (`upsert`), §8.1 |
| US2 session reload — cold rehydrate | **P1** | v0.2 | §10 Expiration, §15 |
| US3 user memories | **P0** | v0.1 | §4.2, §6.1, §7.1, §6.3 |
| US4 rolling summaries (basic) | **P0** | v0.1 | §10 Consolidation, §7 |
| US4 Reflection/REM/Deep tiers | **P1** | v0.2 | §10.1, §10.2 |
| US5 tool calls with turns | **P0** | v0.1 | §6.1, §9.1, §5.2 |
| US6 archive inactive sessions | **P1** | v0.2 | §3.0, §10 Expiration, §15 |
| US7 search — all three modes (FTS5 keyword + `sqlite-vec` semantic + local `candle` hybrid) | **P0** | v0.1 | §8, §5.1, §3.0 |
| US7 search — BM25S + cloud embedding providers (litellm OpenAI / Cohere / Voyage) | **P1** | v0.2 | §8, §3.0 |
| US7 search — cross-tenant federation | **P2** | v0.3 | §8, §12.a |
| US8 delete — record | **P0** | v0.1 `forget_record` | §14, §5.6 |
| US8 delete — session fan-out | **P1** | v0.2 `forget_session` | §14, §10, §5.6 |

**Coverage vs. sequencing (§19) — single source of truth:** The capability matrix below drives both this section and §19; a CI lint fails the build if §8, §18.c, and §19 disagree on what ships when.

| Capability | v0.1 ships | v0.2 ships | v0.3+ |
|------------|------------|-------------|-------|
| Core verbs 1–8 (`ingest`/`search`/`retrieve`/`summarize`/`assemble_hot`/`capture_trace`/`lint`/`forget`) across all four surfaces (CLI · MCP · SDK · skill) | yes — all 8 | unchanged | unchanged |
| `search` modes | all three modes (keyword via FTS5 + semantic via `sqlite-vec` + hybrid via local `candle` blend); dropped only when `search.local_embeddings: false` (then keyword-only, `CapabilityUnavailable` on others) | adds BM25S lexical scoring + swappable cloud embedding provider via `litellm`; `semantic_degraded=true` only on transient provider outages | adds `cairn.federation.v1` cross‑tenant queries via Nexus full hub |
| Session reload | active‑session (US2 core) | + cold‑storage rehydration (US6) | unchanged |
| `forget` modes | `record` (US8 core) | + `session` fan‑out with drain fences | + `scope` mode |
| `ConsolidationWorkflow` | rolling‑summary pass only (US4 core) | + Reflection/REM/Deep tiers | + EvolutionWorkflow mutations |
| SRE observability (OTel dashboards, tier‑migration metrics, rehydration gates) | basic lint + health | full SRE surface | unchanged |
| Extension namespaces | `cairn.admin.v1` (operator verbs) | + `cairn.aggregate.v1` (anonymized agent insights) | + `cairn.federation.v1` (share / accept / revoke — folder-scoped via `subject.path_prefix`) + `cairn.sessiontree.v1` (fork / clone / switch / merge — §5.7) |

**Therefore:** P0 (US1–US3), US4 rolling‑summary, US5, **US7 all three search modes (keyword + semantic + hybrid via local `sqlite-vec` + `candle`)**, and US8 record‑level forget all land in v0.1 — plus local sensors (voice via sherpa-onnx, screen via screenpipe subprocess + xcap fallback, recording-to-text batch pipeline). US6 cold‑rehydration, US8 session fan‑out, BM25S + cloud embedding providers, and the full reflection/evolution surface land in v0.2.

## 18.d The Cairn skill — install once, use anywhere [P0]

For harnesses that don't speak MCP (or where the user prefers not to run an extra server), Cairn ships as a **skill** — a single `SKILL.md` file plus a directory of examples. The harness's native `bash` tool is the only runtime dependency. Any LLM that can read markdown and call `bash` can use Cairn.

**Install:**

```bash
cairn skill install --harness <claude-code|codex|gemini|opencode|cursor|custom>
# writes ~/.cairn/skills/cairn/ and registers the path in the harness's skill index
```

**What gets installed:**

```
  ~/.cairn/skills/cairn/
    ├── SKILL.md              ← the spec (reproduced below, ~200 lines)
    ├── conventions.md         ← when to ingest vs. search; kind cheat-sheet
    ├── examples/              ← 10-20 example transcripts (user intent → cairn call)
    │   ├── 01-remember-preference.md
    │   ├── 02-forget-something.md
    │   ├── 03-search-prior-decision.md
    │   ├── 04-skillify-this.md
    │   └── ...
    └── .version               ← pins cairn.mcp.v1 (skill and binary must match)
```

**The SKILL.md file — the whole contract on one page:**

```markdown
---
name: cairn
description: Cairn memory system. Use for persistent memory across turns, sessions, and agents. Install required: `brew install cairn` or `cargo install cairn`.
triggers:
  - "remember (that|to) …"
  - "forget (that|what) …"
  - "what do (we|you) know about …"
  - "skillify (this|it)"
  - "search (prior|old|my) …"
  - any time the user shares a preference, constraint, correction, or procedure
---

# Cairn Memory Skill

You have persistent memory via the `cairn` CLI. Use it for anything the user
wants to remember across turns, sessions, or agents. The binary is already
installed (run `cairn --version` to confirm).

## When to call cairn

| User says / situation                        | Command to run                                       |
|----------------------------------------------|-------------------------------------------------------|
| "remember that I prefer X"                    | `cairn ingest --kind user --body "prefers X"`        |
| "remember: never do Y"                        | `cairn ingest --kind rule --body "never do Y"`       |
| "correction: it's actually Z"                 | `cairn ingest --kind feedback --body "Z"`            |
| "forget what I said about W"                  | `cairn forget --record $(cairn search "W" -1q)`      |
| "what do you know about K?"                   | `cairn search "K" --limit 10`                         |
| "load my preferences for this session"        | `cairn assemble_hot --session ${SESSION_ID}`          |
| before answering any non-trivial question     | `cairn search "$USER_INTENT" --limit 5`              |
| after completing an ad-hoc procedure          | `cairn ingest --kind strategy_success --body "..."`  |
| before ending the session                     | `cairn capture_trace --from ${TRANSCRIPT_PATH}`       |

## Kind cheat-sheet (pick one — never invent new kinds)

- `user`       — preferences, working style, identity
- `feedback`   — corrections the user gave you
- `rule`       — invariants ("never X", "always Y")
- `fact`       — verifiable claims about the world
- `entity`     — people, projects, systems you encountered
- `playbook`   — reusable procedures with decision trees
- `strategy_success` — an ad-hoc procedure that worked
- `trace`      — reasoning trajectories (auto-captured; don't call directly)

## Output format

Every `cairn` command returns JSON on stdout. Parse it. Don't "read" prose.

```bash
$ cairn search "pgvector" --limit 2 --json
{"hits":[
  {"id":"01HQZ...","kind":"fact","body":"pgvector needs extension","score":0.94},
  {"id":"01HQY...","kind":"feedback","body":"user prefers sqlite-vec","score":0.81}
]}
```

## Non-negotiable rules

1. Never invent record IDs. Always get them from `cairn search` or `cairn retrieve`.
2. Never call `cairn forget` without confirming with the user — forget is irreversible.
3. If a command fails, show the user `stderr` verbatim. Don't paper over errors.
4. Every `ingest` signs with your agent identity — you don't pass `--signed-intent`
   explicitly; `cairn` reads it from `$CAIRN_IDENTITY` set at harness startup.
5. Don't run `cairn ingest` for trivia the user didn't ask you to remember. Use
   the trigger list above — if it's not on the list, ask before storing.
```

**Why this works better than "install an MCP server":**

| Property | MCP server install | Cairn skill install |
|----------|---------------------|----------------------|
| Setup time | edit `.claude.json` or `settings.json`; restart harness | drop one directory; restart not required |
| Offline | requires running a server process | just a binary on `$PATH` |
| Debugging | sniff MCP wire | read `stderr` |
| Works in CI | requires MCP client in CI | every CI has `bash` |
| Migration when binary updates | server restart, potentially breaking API surface | same CLI contract forever (version gate in `.version` file) |
| Works in a harness that doesn't support MCP | no | yes (any bash-capable agent) |

The MCP server is still available (`cairn mcp`) for harnesses that prefer the wire protocol — Claude Code, Codex, Gemini all do. The skill is the **lowest‑common‑denominator** path: if a harness can run `bash`, it can use Cairn.

---

## 19. Sequencing

**v0.1 — Minimum substrate (all P0).** Covers US1, US2 active‑session reload, US3, US4 rolling‑summary path, US5, US7 **all three search modes** (keyword + semantic + hybrid via local embeddings), and US8 record‑level delete (see §18.c capability matrix for the authoritative mapping).
Headless only. **SQLite + statically-linked `sqlite-vec` + pure-Rust `candle` embedding runtime** — `.cairn/cairn.db` with FTS5 for keyword + `sqlite-vec` ANN for semantic over locally-computed vectors (default model `bge-small-en-v1.5` or `all-MiniLM-L6-v2`, ~25 MB, downloaded to `.cairn/models/` on first run). **Zero Python, zero Nexus, zero embedding key, zero external services**; single Rust binary installs via `brew install cairn` or `cargo install cairn` and runs offline after the one-time model fetch. Eight core MCP verbs (`ingest`, `search`, `retrieve`, `summarize`, `assemble_hot`, `capture_trace`, `lint`, `forget`) with the full §8.0.b envelope; `forget` advertises `mode: "record"` capability only; `search` advertises `keyword` + `semantic` + `hybrid` by default (droppable via `search.local_embeddings: false` — then only keyword, rejecting the others with `CapabilityUnavailable`). **Local sensors bundled in the P0 binary: hooks, IDE, terminal, clipboard, voice (sherpa-onnx direct C FFI + cpal mic), screen (screenpipe subprocess primary + xcap/tesseract in-process fallback), neuroskill — plus the §9.1.a recording-to-text batch pipeline** (`cairn ingest --recording <path>`). `DreamWorkflow` (LLMDreamWorker only) + `ExpirationWorkflow` + `EvaluationWorkflow` + `ConsolidationWorkflow` (rolling‑summary path only). §5.6 WAL with `upsert`, `forget_record`, and `expire` state machines. Five hooks. Vault on disk. `cairn bootstrap`. **Working set budget:** Rust core ~15 MB + embedding model ~25 MB + sherpa-onnx runtime+models ~100 MB + optional screenpipe subprocess ~500 MB (opt-in per sensor) → **~140 MB for the always-on default**, ~640 MB with full screen capture. Smaller than Chrome; one static install artifact.

**Reference consumer for v0.1: Claude Code.** Chosen because (a) it is the first harness with a stable hook surface in shipping form, (b) Cairn's five hooks map 1:1 to CC's native events, (c) the primary maintainer already uses CC daily so dogfood signal is immediate, and (d) the CC MCP registration format is a documented reference every other harness (Codex, Gemini) can adapt. Codex integration ships in v0.2 as the second consumer.

v0.1 acceptance ⇒ all **P0 stories** in §18.c pass their golden‑query suites against Claude Code (US1–US3, US4 rolling-summary path, US5, US7 all three search modes via local embeddings, US8 record-level forget), plus the local sensor golden tests (§15) for the voice + screen + recording-to-text pipelines, and the CI wire‑compat matrix confirms `cairn.mcp.v1` verb set + declared capabilities match the runtime. **Deferred to v0.2:** US6 cold rehydration, US8 session fan-out, BM25S and cloud embedding options via Nexus, full reflection/evolution layer.

**v0.2 — Continuous learning + SRE surface + richer search backends (all P1).** Covers US6, US8 session‑wide delete, and full US4 reflection layer. Semantic search already shipped at v0.1 via local `candle`; v0.2 **adds** backend options, not baseline capability.
**Backend upgrade: Nexus `sandbox` profile becomes opt-in** — Python sidecar adds BM25S lexical scoring as an additional search signal, richer multi-modal parsers (PDF / DOCX / video frames with vision captions), and the option to swap the embedding provider from local `candle` to `litellm` (OpenAI / Cohere / Voyage / Ollama) when the user wants larger vectors than the local small model. Existing v0.1 vaults migrate in‑place (SQLite file stays; Nexus adds its indexes alongside as derived projections; `.cairn/cairn.db` remains the sole authority). `semantic_degraded=true` is set only on transient provider outages mid-call, not as a default mode. Add `ReflectionWorkflow`, `SkillEmitter`, full `ConsolidationWorkflow` (Dream/REM/Deep tiers). DreamWorker gains `hybrid` mode. §5.6 WAL gains `forget_session` (with drain fences) and `promote` state machines. SRE observability: OpenTelemetry + tier‑migration dashboards + rehydration latency gates (§15). Second consumer wired. **Electron GUI alpha** (the primary desktop stack — §13.2) with a bundled 2D force-directed graph view over the `edges` table (reusable MIT-licensed component; no graph-viz code in `cairn-core`). The slim Tauri build stays available for bandwidth-constrained / air-gap users but is not the default. Optional Temporal adapter for orchestrator. **Public benchmark harness `cairn bench` ships** — replays long-horizon / multi-session / conversation-memory corpora through the 8 verbs with no LLM or network, publishes scores alongside every release; §15 coherence budgets are enforced against the harness's outputs.

**v0.3 — Propagation + collective.**
Add `PromotionWorkflow`, `PropagationWorkflow`, consent‑gated team/org share, `cairn.federation.v1` extension. Full sensor suite: **the `SensorIngress` connector set expands to cover the memory surfaces that actually live outside editors** — incremental-sync adapters for GitHub (issues / PRs / commits), email (IMAP + webhook), Drive (Google / OneDrive), Notion, and a generic web-clipper extension. Each connector is a separate L2 crate keyed off a stable OAuth / webhook payload format; `cairn.admin.v1` grows `connector_enable` / `connector_disable` / `connector_backfill` operator verbs. `evolve` WAL state machine with canary rollout.

**v0.4 — Evaluation and polish.**
Extended `cairn bench` corpora (domain-specific suites — research / engineering / support). Replay cassettes. Documentation freeze. Beta distribution channels.

**v1.0 — Production.**
SLAs hit. Three harnesses shipped. Desktop GUI on three OSes. Semver commitment on MCP surface (`cairn.mcp.v1` frozen).

---

## 19.a KISS — the v0.1 subset you can hold in your head [P0]

The doc above covers the full spec through v1.0. Most of the surface is skippable for the first working prototype. This section is the **complexity budget**: what ships in v0.1, what doesn't, and the entire agent ↔ memory loop in pseudocode short enough to fit on one screen.

### What v0.1 actually is — five things, nothing else

| # | Capability | Where it lives | Skippable until |
|---|------------|-----------------|------------------|
| 1 | Eight verbs over the signed envelope, exposed as CLI + MCP + SDK + skill | `cairn` binary (§8.0) | never — this is the product |
| 2 | **One SQLite file** (`.cairn/cairn.db`) with FTS5 — records, WAL, replay, consent journal, locks all in one file | Rust core via `rusqlite` | never |
| 3 | Five hooks (`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`) | harness integration layer | never |
| 4 | WAL two‑phase commit for `upsert` + `forget_record` | Rust core | never |
| 5 | `tokio` orchestrator for `DreamWorkflow` + `ExpirationWorkflow` + `EvaluationWorkflow` + rolling‑summary `ConsolidationWorkflow` | Rust core | never |

**Everything below ships later — don't build it in v0.1:**

| Deferred to | What you're skipping | Why it's safe to skip |
|--------------|-----------------------|------------------------|
| v0.2 | `ReflectionWorkflow`, `SkillEmitter`, Dream/REM/Deep consolidation tiers, session‑wide `forget`, cold rehydration, OpenTelemetry dashboards, Tauri GUI | None of these are on the hot path for US1–US5 + US7 basic + US8 record |
| v0.3 | `PromotionWorkflow`, `PropagationWorkflow`, federation, `evolve` WAL state, full sensor suite | Single‑user/single‑machine works without any of this |
| v0.4+ | Multi‑session coherence benchmarks, replay cassettes, desktop GUI polish, second/third harness | These are polish, not substrate |

### The whole agent turn in 50 lines of pseudocode

If you only read one code block in this document, read this one. Everything else is an elaboration.

```rust
// Agent turn with Cairn memory — the entire v0.1 loop, simplified for clarity
// Real impl adds envelope signing, error typing, retry policy — not shown here

async fn turn(session_id: SessionId, user_msg: &str) -> Result<AgentMsg> {
    // 1. HOOK: session_start (on first turn only) — fires once, lets Cairn inject hot memory
    let hot = cairn::assemble_hot(session_id).await?;        // ≤ 25 KB, ≤ 6,250 tokens (§7)

    // 2. HOOK: user_prompt_submit — user intent enters the journal
    cairn::capture_trace(session_id, Event::UserMsg(user_msg)).await?;

    // 3. BUILD THE PROMPT — hot prefix + rolling summary + last K turns
    let summary = cairn::summarize(session_id, window: 50).await?;  // rolling, only if > N turns
    let recent  = cairn::retrieve(session_id, limit: 10, order: Desc).await?;
    let prompt  = Prompt::new().system(hot).context(summary).history(recent).user(user_msg);

    // 4. MODEL CALL — your harness owns this, Cairn doesn't
    let mut response = llm::stream(prompt).await?;

    // 5. TOOL LOOP — PreToolUse / PostToolUse hooks fire around every tool call
    while let Some(tool_call) = response.next_tool_call().await? {
        cairn::capture_trace(session_id, Event::PreToolUse(&tool_call)).await?;
        let result = tool::exec(&tool_call).await?;          // may fail — Cairn still logs
        cairn::capture_trace(session_id, Event::PostToolUse(&tool_call, &result)).await?;
        response.feed_tool_result(result).await?;
    }

    // 6. HOOK: stop — the turn is done, let Cairn consolidate async
    let agent_msg = response.finalize().await?;
    cairn::capture_trace(session_id, Event::AgentMsg(&agent_msg)).await?;
    cairn::stop(session_id).await?;   // triggers rolling-summary orchestrator if cadence hit

    Ok(agent_msg)
}

// That's it. Everything else — Extract, Filter, Classify, Store, Consolidate,
// Dream, Reflect, Promote, Evolve, Federation — runs inside the `tokio`
// orchestrator behind those 6 calls. The harness never sees it.
```

**What runs behind each of those six calls:**

```
  cairn::assemble_hot    ─▶ read purpose.md + index.md + pinned + profile + playbook ─▶ 25 KB prefix
  cairn::capture_trace   ─▶ §5.2 Filter(PII, visibility, scope) ─▶ WAL upsert ─▶ SQLite
  cairn::summarize       ─▶ rolling-summary ConsolidationWorkflow (only if cadence hit)
  cairn::retrieve        ─▶ single SQL query over SQLite primary key, p50 < 5 ms
  cairn::stop            ─▶ enqueue post-turn jobs in tokio; return immediately
  cairn::forget (later)  ─▶ §5.6 delete state machine (Phase A tombstone + Phase B purge)
```

### Complexity budget — what you can skip and still have a working system

| You don't strictly need… | …until |
|---------------------------|---------|
| `actor_chain` with multi‑hop delegation | you have more than one agent writing to the vault |
| `ConsentReceipt` + propagation | you want to share records beyond `private` tier |
| Signed envelope with `sequence` + `server_challenge` | you expose the MCP server over a network boundary |
| Skillify 10‑step pipeline | the agent has been writing skills for long enough to accumulate rot |
| Federation to a hub | more than one person uses the same knowledge |
| Sensors beyond the five hooks | you want capture from sources outside the harness |
| Desktop GUI | raw `wiki/` markdown + any editor is already enough |
| Rich visibility tiers beyond `private` + `session` | the vault never leaves one laptop |

**Everything in the table above is a progressive enhancement.** v0.1 ships with `private` + `session` only, single‑actor `author` identity, one hook surface, one orchestrator (local `tokio`), one MCP wire format (`cairn.mcp.v1`), and one set of five workflows. That is enough to pass **all P0 user stories** (US1–US3, US4 rolling-summary, US5, US7 keyword-only, US8 record-level forget). **P1 user stories** (US6 cold rehydration, US7 semantic/hybrid, US8 session fan-out) land in v0.2 when Nexus sandbox is activated. Every later version adds one capability on top; nothing retroactively changes the v0.1 wire format.

### First principles check (§1.b)

Every capability above is derivable from these seven invariants — if you violate one, you are not shipping Cairn:

```
  1. Memory = plain text + explicit schema. The vault is inspectable, editable, grep‑able.
  2. Eight verbs are the contract; the CLI is the ground truth. MCP, SDK, skill all wrap the same eight Rust functions.
  3. One SQLite file at P0. Everything in .cairn/cairn.db (records + WAL + replay + consent + locks).
     Nexus adds a nexus-data/ directory at P1+ alongside the unchanged SQLite file. Never the other way around.
  4. Signed envelope on every write. Chain of trust never optional, even in v0.1 single-actor mode.
  5. WAL two-phase for every mutation. No "just write, we'll recover from a crash later."
  6. Orchestrator is pluggable but has a zero-dependency default. `tokio` + SQLite job table.
  7. Harness never sees Cairn internals. Eight verbs in, eight verb responses out. Every migration, every version, forever.
```

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
