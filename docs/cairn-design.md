# Cairn — Standalone Harness‑Agnostic Agent Memory Framework

> **Status:** Design brief — architecture + needs (no code)
> **Date:** 2026‑04‑22

---

> *"Vannevar Bush described the Memex in 1945 — a personal curated knowledge store where the connections between documents are as valuable as the documents themselves. The part he couldn't solve was who does the maintenance."*
>
> **Cairn is that piece.** The agent does the maintenance — continuously, durably, off the request path.

---

## 1. Thesis

**Cairn** is a stand‑alone, harness‑agnostic agent memory framework. It gives any agent loop — local or cloud, open‑source or proprietary — a shared substrate for per‑turn extraction, nightly consolidation, trajectory→playbook learning, hot‑memory prefix injection, typed taxonomy, consent‑gated propagation, and a privacy‑first local default. Its external contract is a tiny MCP surface (seven verbs). Its default backend is **Nexus `sandbox` profile** — a Python sidecar that brings SQLite + BM25S + `sqlite-vec` semantic search in a single `nexus.db` file with zero external services; scale happens through federation to a Nexus `full` hub, not through swapping adapters. The `MemoryStore` contract is still swappable if a team already runs a different store. It is lightweight enough to `bunx cairn` on a laptop and industrial enough to run behind an enterprise gateway — **same interfaces, same Nexus, different topology**.

---

## 2. Design Principles (non‑negotiable)

1. **Harness‑agnostic.** Works with any agent loop that can speak MCP.
2. **Default to one backend; scale by federation, not by swapping.** Nexus `sandbox` profile is the default `MemoryStore` at every tier (embedded, local, cloud). Scale‑up is federation from sandbox → Nexus `full` hub over HTTP — not a code change in Cairn. The contract is still swappable if a team already runs a different store, but Cairn does not "multi‑backend for multi‑backend's sake".
3. **Stand‑alone.** `bunx cairn` on a fresh laptop with zero cloud credentials works end‑to‑end.
4. **Local‑first, cloud‑optional.** The vault lives on disk. Cloud is opt‑in per sensor, per write path.
5. **Narrow typed contracts.** Five real interfaces. Fifteen pure functions. Everything else is composition.
6. **Continuous learning off the request path.** Temporal runs Dream / Reflect / Promote / Consolidate / Propagate / Expire / Evaluate in the background. Harness latency is untouched.
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
| `mcp` | Cairn's seven verbs register as MCP tools on the Nexus MCP surface; harnesses talk to either side interchangeably |
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
- **One file on disk.** `nexus.db` holds records, vectors, FTS, metadata. Back up by copying one file (or use `snapshot`).
- **Semantic search is opt‑in.** With an embedding API key (`OPENAI_API_KEY` or any `litellm` provider), `sqlite-vec` is primary. Without a key, BM25S results are stamped `semantic_degraded=true` end to end.
- **Records land through `filesystem` + `search`.** A memory = a markdown file with frontmatter at `/<vault>/raw/<kind>_<slug>.md`. `search` indexes body; `rebac` + `access_manifest` enforce scope; `snapshot` + `versioning` cover backup and undo. Cairn's Rust core never touches SQLite directly.
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
- The MCP surface is seven verbs — the public contract.
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
  kind: sqlite                # sqlite | postgres
  path: .cairn/vault.db
llm:
  provider: openai-compatible
  base_url: https://…
workflows:
  orchestrator: temporal      # temporal | local
```

A new vault inherits the default config. Teams fork a config as a shareable template (e.g. `cairn init --template research`, `--template engineering`, `--template personal`).

---

## 4. Contracts — the Five That Matter

Everything in Cairn is a pure function over data, except these five interfaces.

| # | Contract | Purpose | Default implementation |
|---|----------|---------|------------------------|
| 1 | `MemoryStore` | typed CRUD + ANN + FTS + graph over `MemoryRecord` | **Nexus `sandbox` profile** (Python sidecar; SQLite + BM25S + `sqlite-vec` for semantic via `litellm` embeddings + in‑process LRU; single DB file, zero external services; ~300–400 MB RSS, <5 s warm boot). **Scale‑up path = federation** — sandbox instances delegate to a **Nexus `full`** hub zone (PostgreSQL + Dragonfly + Zoekt + txtai) over HTTP; Cairn does not switch Cairn‑side adapters to scale. Cairn talks to Nexus over HTTP + MCP, **not in‑process** (Rust core ↔ Python Nexus across the process boundary). |
| 2 | `LLMProvider` | one function — `complete(prompt, schema?) → text \| json` | OpenAI‑compatible (local Ollama, any cloud) |
| 3 | `WorkflowOrchestrator` | durable scheduling + execution for background loops | **Rust‑native default**: `tokio` + a SQLite‑backed job table (durable, crash‑safe, single binary, zero services). **Optional Temporal adapter**: `temporalio-sdk` + `temporalio-client` (both published on crates.io, currently prerelease) when GA; a TypeScript Temporal worker sidecar as the safe path today |
| 4 | `SensorIngress` | push raw observations into the pipeline | hook sensors, IDE, clipboard, screen (opt‑in), web clip |
| 5 | `MCPServer` | harness‑facing tools | stdio + SSE; seven verbs (§8) |

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

**What stays non‑pluggable (the contract surface itself):** the MCP verb set (seven verbs), the vault layout invariants (§3.1), the append‑only `consent.log`, and the record frontmatter schema. Those are *the* contract — everything else is replaceable.

**How to verify this principle at any commit:**
```
cargo tree -p cairn-core                 # zero runtime deps expected
grep -rn "extern crate\|use " cairn-core # no imports from cairn-store-*, cairn-llm-*, etc.
cairn plugins list                       # shows all loaded plugins + versions + capabilities
cairn plugins verify                     # runs contract conformance tests against every active plugin
```

CI enforces all four: L0 has no impl deps; no module in core imports from any adapter; every bundled plugin passes contract conformance; capability declarations match runtime behavior.

---

## 5. Pipeline — Read, Write, Consolidate

Cairn's pipeline has three explicit paths: the **read path** that serves a turn, the **write path** that captures what the agent learned, and the **consolidation path** that runs off‑request.

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
| **Classify & Scope** | kind (17) × class (4) × visibility (6) × scope → keyspace; emits `ADD / UPDATE / DELETE / NOOP` decision | `classifyAndScope` |
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
- Any stage can fail without losing data; Temporal replays from the last persisted step.
- Discard is **never silent** — every `no` from Filter writes a row to `.cairn/metrics.jsonl` with the reason code.

### 5.5 Plan, then apply

Every write path run produces a **FlushPlan** before any bytes hit the `MemoryStore`. A FlushPlan is a typed, serializable object listing the concrete upserts / deletes / promotions / expirations it would apply and why. The `apply` step is a pure function from `FlushPlan → side effects`.

| Mode | Behavior |
|------|----------|
| `autonomous` (default) | Capture → … → Plan → apply inline, same turn |
| `dry_run` | Plan returned via MCP `ingest(dry_run: true)`; no writes |
| `human_review` | Plan written to `.cairn/flush/<ts>.plan.json` + human diff; apply waits for `cairn flush apply <id>` |

Benefits: plans are idempotent (re‑apply = no‑op), reviewable, replayable for eval, and the primary audit artifact for *every* memory mutation. Same pattern as OpenClaw's flush‑plan.

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

## 8. MCP Surface — Seven Verbs

| Verb | What it does |
|------|--------------|
| `ingest` | push an observation (text / image / video / tool call / screen frame / web clip) |
| `search` | BM25 + ANN + graph hybrid across scope |
| `retrieve` | get a specific memory by id (and related edges) |
| `summarize` | multi‑memory rollup; optional `persist: true` files the synthesis as a new `reference` or `strategy_success` memory with provenance |
| `assemble_hot` | return the always‑loaded prefix for this agent/session |
| `capture_trace` | persist a reasoning trajectory for later ACE distillation |
| `lint` | health check — contradictions, orphans, stale claims, missing concept pages, data gaps; returns a structured report and optionally writes `lint-report.md` |

**Citations mode.** Every read verb (`search`, `retrieve`, `summarize`, `assemble_hot`) accepts a `citations: "on" | "compact" | "off"` flag, resolved from `.cairn/config.yaml` by default. `on` appends `Source: <path#line>` to each recalled snippet; `compact` appends only a single citation per record; `off` returns content without paths. Turn compact or off in harnesses whose UI shouldn't expose file paths to end users.

MCP is the **only** public entry point. Everything else — CLI commands, hooks, library calls — routes through the same seven verbs internally.

---

## 8.1 Session Lifecycle — Auto‑Discovery + Auto‑Create

The seven MCP verbs accept an optional `session_id`. When absent, Cairn applies this policy:

1. **Find** the user's most recent active session for this `agent_id` (within a configurable idle window, default 24 h).
2. **If found** — reuse it; append turns to it.
3. **If not found** — create a new session with `title: ""` (populated later by the first `DreamWorkflow` pass) and metadata from the caller.
4. Return the resolved `session_id` in every response.

This mirrors the "just call `ingest` — I don't want to manage sessions" pattern production memory services use. Harnesses that *do* track sessions pass `session_id` explicitly and opt out of auto‑discovery.

Sessions carry metadata (`channel`, `priority`, `tags`), emit a `session_ended` event when the idle window elapses, and are searchable via the `search` verb with `scope: "sessions"` — the same way records are searchable.

## 9. Sensors and User Signals

### 9.1 Sensors — two families, all opt‑in per‑sensor

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

## 10. Continuous Learning — Eight Temporal Workflows

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
- **Three aggregate read verbs** exposed alongside the seven core verbs when the toggle is on:
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

### 11.3 Constraint gates (all must pass before promotion)

1. **Test suite** — any behavioral test the artifact has (golden queries, contract tests, replay cassettes) must pass 100%.
2. **Size limits** — skills ≤ 15 KB, tool descriptions ≤ 500 chars, hot‑memory prefix ≤ 25 KB / 200 lines.
3. **Semantic preservation** — the variant must score ≥ baseline on a similarity check against the original artifact's declared purpose (prevents drift).
4. **Caching compatibility** — no mid‑turn mutations; variants only swap in at `SessionStart` boundaries.
5. **Confidence non‑regression** — the evolved artifact's measured outcome confidence must not decrease across the eval dataset.
6. **Review gate** — `.cairn/config.yaml` declares `autonomous | human_review`; `human_review` writes a PR‑style diff to `.cairn/evolution/<artifact>.diff` and waits for approval.

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

- **Rust core** owns everything hot‑path: `MemoryStore` I/O, embedding, ANN, squash, hot‑memory assembly, and the Temporal worker. Ships as a single static binary that Electron spawns as a sidecar. Exposes MCP over stdio to the renderer.
- **Electron shell** gives a consistent Chromium runtime across macOS / Windows / Linux — rendering parity matters for the graph view and the editor, and the same webview is already the target of every reference editor (Obsidian, VS Code, Notion, Linear). No surprise WebKit / WebView2 divergence.
- **TipTap (ProseMirror)** for memory editing — wikilink autocomplete, slash commands, inline frontmatter, collaborative‑ready even though Cairn is single‑user by default. Markdown in / markdown out through TipTap's markdown extensions.
- **IPC boundary** is MCP. The Rust core speaks the same seven verbs to the Electron renderer as it does to any external harness. One transport, one schema. The GUI is not a special client.
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
- **Privacy SLO.** `forget-me` on a 1M‑record vault completes in < 1 s.
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
- Not a scheduler. Temporal is the scheduler.
- Not a vector DB. Nexus `sandbox` profile (SQLite + `sqlite-vec` + `litellm` embeddings) provides the default vector path via its `search` brick.
- Not a UI framework. The desktop GUI is optional and purposely small.
- Not an IAM engine. `MemoryVisibility` is a tag; enterprise IAM lives elsewhere.
- Not an application. No built‑in "brag doc", no "review brief", no "standup template" — those are user‑space templates that sit on top of Cairn's primitives.

---

## 18. Success Criteria

1. **Adoption.** Three independent harnesses speak Cairn MCP in v0.1; ten by v1.0.
2. **Standalone proof.** `bunx cairn` on a fresh laptop, no network, works end‑to‑end.
3. **Latency.** p95 harness turn with Cairn MCP hot‑assembly < 50 ms.
4. **Privacy.** `forget-me` on a 1M‑record vault in < 1 s; append‑only consent log survives GDPR review.
5. **Evaluation.** Golden queries + multi‑session coherence + orphan / conflict / staleness metrics all regression‑tested in CI.
6. **Local‑first.** Zero code changes to move from embedded → local → cloud; only `.cairn/config.yaml`.
7. **Maintenance is a command.** Weekly `cairn lint` + continuous Temporal workflows keep the vault healthy without manual cleanup.

---

## 18.a Progressive Adoption — three ways to use Cairn

Users don't have to commit to the full stack on day one. Cairn is designed to be useful at three levels of commitment, each a superset of the last.

| Level | Commitment | What you get | When |
|-------|------------|--------------|------|
| **L1 — Zero‑config in your harness** | 30 seconds | `cairn mcp` registered as an MCP server in CC / Codex / Gemini. Seven verbs available. "Tell it directly" — say *"remember that I prefer X"* in chat and Cairn captures a `user` or `feedback` memory. `cairn export` for portable memory. | you want better in‑chat memory today |
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
| "forget that I mentioned W" | adds an expiration marker to the matching record; `ExpirationWorkflow` removes on next pass (audit trail preserved in `consent.log`) |

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

## 19. Sequencing

**v0.1 — Minimum substrate.**
Headless only. Nexus local backend. Seven MCP verbs. `DreamWorkflow` + `ExpirationWorkflow` + `EvaluationWorkflow`. Five hooks. Vault on disk. `cairn bootstrap`. One reference consumer wired end‑to‑end.

**v0.2 — Continuous learning.**
Add `ReflectionWorkflow`, `ConsolidationWorkflow`, `SkillEmitter`. Second consumer wired. Tauri GUI alpha.

**v0.3 — Propagation + collective.**
Add `PromotionWorkflow`, `PropagationWorkflow`, consent‑gated team/org share. Full sensor suite.

**v0.4 — Evaluation and polish.**
Multi‑session coherence benchmarks. Replay cassettes. Documentation freeze. Beta distribution channels.

**v1.0 — Production.**
SLAs hit. Three harnesses shipped. Desktop GUI on three OSes. Semver commitment on MCP surface.

---

## 20. Open Questions

1. Which reference consumer anchors v0.1?
2. Governance: single‑repo vs. monorepo organization; maintainer model.
3. Default LLM for local tier: ship Ollama bootstrap, or require user install?
4. Desktop GUI: ship in v0.2 or defer to v0.3?
5. Skill distillation format: adopt an existing spec, or define Cairn‑native?
6. Propagation transport: direct `MemoryStore` write, or a thin publish/subscribe layer?
7. Screen sensor: separate opt‑in build, or always‑present‑but‑off‑by‑default toggle?

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
