# @koi/tools-web — Web Fetch and Search Tools

Wraps HTTP fetching and web search as 2 Koi Tool components: `web_fetch` and `web_search`. One factory call attaches both tools to any agent via ECS — engines discover them with zero engine changes. Includes SSRF protection, response caching, and markdown conversion.

---

## Why It Exists

Agents that research, browse, or verify information need live web access. Raw `fetch` calls are unstructured, lack SSRF protection, and bypass the middleware chain. There's no standard way to plug web operations into Koi's interposition layer.

`@koi/tools-web` solves this by wrapping HTTP behind a typed `WebExecutor` interface with:
- **SSRF protection** — Pre-request and post-redirect blocking of private/internal URLs
- **Response caching** — LRU + TTL cache for repeated fetches
- **Content conversion** — HTML → markdown or plain text
- **Pluggable search** — Inject any search backend (Brave, Google, SerpAPI)
- **Structured errors** — All failures return `KoiError` codes, never throw

The `ComponentProvider` pattern means any engine adapter (Loop, Pi, LangGraph) discovers these tools automatically.

---

## What This Enables

### Before vs After

```
WITHOUT tools-web:  agent is blind to the live internet
═══════════════════════════════════════════════════════

  User: "What's on example.com?"

  Agent: "I don't have web access. I can only use
          the tools I was given."

  ❌ No web browsing
  ❌ No search
  ❌ No live data


WITH tools-web:  agent browses and searches autonomously
════════════════════════════════════════════════════════

  User: "Research the latest Bun release notes"

  Agent: 1. web_search("Bun release notes 2026")
            → [{ title: "Bun 1.3", url: "bun.sh/blog/..." }, ...]
         2. web_fetch("https://bun.sh/blog/bun-v1.3", format: "markdown")
            → "# Bun 1.3 Release Notes\n\n..."
         3. "Bun 1.3 introduces native S3 support..."

  ✅ Live web access through middleware chain
  ✅ SSRF protection blocks internal URLs
  ✅ Cached responses for repeated fetches
  ✅ Structured errors flow back to model
```

### Search-Then-Fetch Pipeline

```
User: "Find info about Koi agent framework"
  │
  ▼
┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
│   Agent      │───▶│  web_search  │───▶│  Brave Search    │
│  (Claude)    │    │  (tool)      │    │  API             │
└──────┬───────┘    └──────────────┘    └───────┬──────────┘
       │                                        │
       │  results: [{title, url, snippet}, ...] │
       │◀───────────────────────────────────────┘
       │
       │  "Found: github.com/koi-agent/..."
       │
       │            ┌──────────────┐    ┌──────────────────┐
       └───────────▶│  web_fetch   │───▶│  github.com/...  │
                    │  format: md  │    │  (real HTTP)     │
                    └──────────────┘    └───────┬──────────┘
                                                │
Agent: "Koi is a self-extending agent   ◀───────┘
        engine with 4 layers..."
        (summarizes live page content)
```

---

## Tool Execution Flow

### Happy Path: `web_fetch`

```
LLM decides: "call web_fetch
              with { url: 'https://example.com', format: 'markdown' }"
        │
        ▼
  ┌────────────────┐
  │ Middleware Chain│
  │ wrapToolCall() │──── audit, rate-limit, permissions...
  └───────┬────────┘
          │
          ▼
  ┌────────────────────┐
  │ tool.execute(args)  │
  │ web-fetch.ts        │
  └───────┬────────────┘
          │
    parseHeaders(args) ── runtime validation (no unsafe `as` casts)
    isBlockedUrl(url) ─── SSRF pre-check ✓
          │
          ▼
  ┌────────────────────────────────────┐
  │ executor.fetch(url, {              │
  │   method: "GET",                   │
  │   timeoutMs: 15000                 │
  │ })                                 │
  └───────┬────────────────────────────┘
          │
    ├── Cache check → HIT? return cached ──────────┐
    ├── HTTP fetch (real network)                    │
    ├── Post-redirect SSRF check                     │
    ├── Body truncation (50KB limit)                 │
    └── Cache result                                 │
          │                                          │
          ▼                                          │
  ┌────────────────────┐                             │
  │ htmlToMarkdown(body)│◀──── format: "markdown"    │
  │ → structured text   │                             │
  └───────┬────────────┘                             │
          │                                          │
          ▼                                          │
  tool_call_end event  ◀─────────────────────────────┘
  result: "# Example Domain\n\nThis domain is..."
          │
          ▼
  LLM receives content
  in next turn's messages[]
```

### SSRF Protection: Pre-Request + Post-Redirect

```
Agent calls web_fetch("http://169.254.169.254/metadata")
        │
        ▼
  ┌─────────────────┐
  │ SSRF Pre-Check   │──▶ ❌ BLOCKED (AWS metadata endpoint)
  │ isBlockedUrl()   │      Returns: { code: "PERMISSION",
  └─────────────────┘                 error: "URL blocked: ..." }
                                                     │
                                                     ▼
                                              LLM receives error


Agent calls web_fetch("https://legit-looking.com/redirect")
        │
        ▼
  ┌─────────────────┐   ┌──────────┐   ┌──────────────────┐
  │ SSRF Pre-Check   │──▶│ HTTP GET │──▶│ 302 Redirect to  │
  │ ✅ OK            │   │ (fetch)  │   │ http://10.0.0.1  │
  └─────────────────┘   └──────────┘   └────────┬─────────┘
                                                 │
                                                 ▼
                                   ┌─────────────────┐
                                   │ SSRF Post-Check  │
                                   │ isBlockedUrl()   │
                                   │ ❌ BLOCKED       │
                                   └─────────────────┘
                                                 │
                                                 ▼
                                   { code: "PERMISSION",
                                     error: "Redirect to private
                                             URL blocked" }

Blocked patterns:
  localhost, 127.*, 10.*, 172.16-31.*, 192.168.*,
  169.254.* (link-local/AWS), ::1, 0.0.0.0,
  *.internal, *.local
```

### Response Caching

```
  First call: web_fetch("https://example.com")
  ┌────────────────────┐
  │ Cache lookup        │──▶ MISS
  │ key: "GET:https://  │
  │  example.com"       │
  └────────┬───────────┘
           │
           ▼
  ┌────────────────────┐
  │ HTTP GET            │──▶ 200 OK
  │ example.com         │    body: "<html>..."
  └────────┬───────────┘
           │
           ▼
  ┌────────────────────┐
  │ Cache store         │──▶ stored with TTL
  │ entry expires at    │    (configurable, default: off)
  │ now + cacheTtlMs    │
  └────────────────────┘


  Second call: web_fetch("https://example.com")
  ┌────────────────────┐
  │ Cache lookup        │──▶ HIT (not expired)
  │ key: "GET:https://  │    return cached result
  │  example.com"       │    ⚡ no HTTP request
  └────────────────────┘

Cache properties:
  ● LRU eviction (oldest entry removed when full)
  ● TTL expiry (stale entries removed on access)
  ● GET/HEAD only (POST/PUT/DELETE bypass cache)
  ● Search results cached by query + maxResults
  ● Configurable: cacheTtlMs (0 = off), maxCacheEntries (100)
```

---

## Architecture

`@koi/tools-web` is an **L2 feature package** that depends only on `@koi/core`.

```
┌───────────────────────────────────────────────────────┐
│  @koi/tools-web  (L2)                                 │
│                                                       │
│  constants.ts              ← operations, system prompt│
│  url-policy.ts             ← SSRF blocking rules      │
│  strip-html.ts             ← HTML → plain text        │
│  html-to-markdown.ts       ← HTML → Markdown          │
│  web-executor.ts           ← WebExecutor + factory    │
│  web-component-provider.ts ← ComponentProvider        │
│  index.ts                  ← public API surface       │
│                                                       │
│  tools/                                               │
│    web-fetch.ts            ← web_fetch tool           │
│    web-search.ts           ← web_search tool          │
│                                                       │
├───────────────────────────────────────────────────────┤
│  External deps: NONE (uses platform fetch API)        │
│                                                       │
├───────────────────────────────────────────────────────┤
│  Internal deps                                        │
│  ● @koi/core (L0) — Tool, ComponentProvider, KoiError │
│                                                       │
│  Dev-only                                             │
│  ● @koi/engine (L1) — createKoi (E2E tests only)     │
│  ● @koi/engine-pi — createPiAdapter (E2E tests only)  │
│  ● @koi/search-brave — Brave adapter (E2E tests only) │
└───────────────────────────────────────────────────────┘
```

### Layer Position

```
L0  @koi/core ────────────────────────────────────────┐
    Tool, ToolDescriptor, ComponentProvider,            │
    KoiError, Result, JsonObject, TrustTier,            │
    toolToken                                           │
                                                        │
                                                        ▼
L2  @koi/tools-web ◄────────────────────────────────┘
    imports from L0 only (runtime)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ All interface properties readonly
    ✓ Tool execute returns structured objects (never throws)
    ✓ Engine adapter agnostic (works with Loop, Pi, LangGraph)

Companion L2 package (optional, pluggable):
    @koi/search-brave — Brave Search API adapter
    provides searchFn compatible with WebExecutorConfig
    ✗ not imported by @koi/tools-web (injected at config time)
```

### Internal Structure

```
createWebProvider(config)
│
├── config.executor      → WebExecutor (injected)
├── config.prefix        → "web" (default)
├── config.trustTier     → "verified" (default)
├── config.operations    → ["fetch", "search"] (default)
│
└── attach(agent) → Map<SubsystemToken, Tool>
    │
    ├── toolToken("web_fetch")   → createWebFetchTool(executor, prefix, trustTier)
    └── toolToken("web_search")  → createWebSearchTool(executor, prefix, trustTier)


createWebExecutor(config)
│
├── config.fetchFn           → globalThis.fetch (default)
├── config.searchFn          → undefined (required for web_search)
├── config.maxBodyChars      → 50,000 (default)
├── config.defaultTimeoutMs  → 15,000 (default)
├── config.cacheTtlMs        → 0 — disabled (default)
├── config.maxCacheEntries   → 100 (default)
│
└── returns WebExecutor { fetch(), search() }
    │
    ├── fetch(url, options)
    │   ├── SSRF pre-check (isBlockedUrl)
    │   ├── Cache lookup (LRU + TTL, GET/HEAD only)
    │   ├── HTTP fetch with timeout + AbortController
    │   ├── SSRF post-redirect check (response.url)
    │   ├── Body truncation (maxBodyChars)
    │   └── Cache store on success
    │
    └── search(query, options)
        ├── Validates searchFn configured
        ├── Cache lookup
        ├── Delegates to searchFn
        └── Cache store on success
```

---

## Tools Reference

### 2 Tools

```
╔════════════════╦═══════════╦═══════════════════════════════════════════════════╗
║ Tool           ║ Trust     ║ Purpose                                           ║
╠════════════════╬═══════════╬═══════════════════════════════════════════════════╣
║ web_fetch      ║ verified  ║ Fetch a URL, return content as text/markdown/html ║
║ web_search     ║ verified  ║ Search the web, return title/url/snippet results  ║
╚════════════════╩═══════════╩═══════════════════════════════════════════════════╝
```

### Input Schemas

```
web_fetch
  ├── url           string    (required) URL to fetch
  ├── method?       string    HTTP method (default: "GET")
  ├── headers?      object    Custom request headers
  ├── body?         string    Request body (for POST/PUT)
  ├── timeout_ms?   number    Timeout (default: 15000, max: 60000)
  └── format?       string    "text" | "markdown" | "html" (default: "text")

web_search
  ├── query         string    (required) Search query
  └── max_results?  number    Max results to return (default: 5, max: 20)
```

### Output Formats

```
web_fetch returns (based on format parameter):

  format: "text" (default)
  ┌─────────────────────────────────────────┐
  │ HTML tags stripped, entities decoded,    │
  │ whitespace collapsed into clean text.   │
  │ "Example Domain This domain is for..."  │
  └─────────────────────────────────────────┘

  format: "markdown"
  ┌─────────────────────────────────────────┐
  │ HTML converted to Markdown. Preserves:  │
  │ # headings, **bold**, *italic*,         │
  │ [links](url), `code`, lists, quotes.    │
  │ "# Example Domain\n\nThis domain..."   │
  └─────────────────────────────────────────┘

  format: "html"
  ┌─────────────────────────────────────────┐
  │ Raw HTML response body, as-is.          │
  │ "<html><body>...</body></html>"         │
  └─────────────────────────────────────────┘


web_search returns:
  [
    { title: "Result 1", url: "https://...", snippet: "..." },
    { title: "Result 2", url: "https://...", snippet: "..." },
    ...
  ]
```

---

## Error Handling

All tool errors return structured `{ code, error }` objects — never throw.

```
╔══════════════╦═══════════════════════════════╦═══════════╦═══════════════════════╗
║ Code         ║ Meaning                       ║ Retryable ║ Agent action          ║
╠══════════════╬═══════════════════════════════╬═══════════╬═══════════════════════╣
║ VALIDATION   ║ Bad argument or missing URL   ║ No        ║ Fix args and retry    ║
║ VALIDATION   ║ No search backend configured  ║ No        ║ Configure searchFn    ║
║ PERMISSION   ║ SSRF — URL blocked            ║ No        ║ Use a public URL      ║
║ PERMISSION   ║ Redirect to private URL       ║ No        ║ Use a different URL   ║
║ TIMEOUT      ║ Request timed out             ║ Yes       ║ Increase timeout      ║
║ EXTERNAL     ║ Network or server error       ║ Yes       ║ Check URL and retry   ║
╚══════════════╩═══════════════════════════════╩═══════════╩═══════════════════════╝
```

---

## Usage

### Minimal: Web Fetch Only

```typescript
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";

// 1. Create executor (uses platform fetch, no search backend)
const executor = createWebExecutor();

// 2. Create component provider
const provider = createWebProvider({ executor });

// 3. Assemble runtime — tools are attached via ECS
const runtime = await createKoi({
  manifest: { name: "web-agent", version: "1.0.0", model: { name: "claude-haiku-4-5" } },
  adapter: createPiAdapter({
    model: "anthropic:claude-haiku-4-5-20251001",
    getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
  }),
  providers: [provider],
});

// 4. Agent now has web_fetch + web_search tools
for await (const event of runtime.run({ kind: "text", text: "Fetch https://example.com" })) {
  if (event.kind === "text_delta") process.stdout.write(event.delta);
}

await runtime.dispose();
```

### With Brave Search + Caching

```typescript
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import { createBraveSearch } from "@koi/search-brave";

// 1. Create Brave search backend
const searchFn = createBraveSearch({
  apiKey: process.env.BRAVE_API_KEY!,
  country: "US",
});

// 2. Create executor with search + 5-minute cache
const executor = createWebExecutor({
  searchFn,
  cacheTtlMs: 300_000,
  maxCacheEntries: 200,
});

// 3. Create provider — both web_fetch and web_search are now functional
const provider = createWebProvider({ executor });

// 4. Wire into createKoi
const runtime = await createKoi({
  manifest,
  adapter,
  providers: [provider],
});
```

### Fetch-Only (No Search Tool Exposed)

```typescript
const provider = createWebProvider({
  executor,
  operations: ["fetch"],    // only web_fetch, no web_search
  prefix: "browser",        // → browser_fetch
  trustTier: "promoted",    // require explicit permission
});
```

### Custom Prefix and Trust Tier

```typescript
const provider = createWebProvider({
  executor,
  prefix: "http",           // → http_fetch, http_search
  trustTier: "sandbox",     // lower trust for sandboxed agents
});
```

### Standalone Tool Usage (Without Provider)

```typescript
import { createWebExecutor, createWebFetchTool } from "@koi/tools-web";

const executor = createWebExecutor();
const tool = createWebFetchTool(executor, "web", "verified");

const result = await tool.execute({ url: "https://example.com", format: "markdown" });
// → "# Example Domain\n\nThis domain is for use in ..."
```

### With Middleware Observation

```typescript
import type { KoiMiddleware, ToolRequest, ToolResponse } from "@koi/core";

const webLogger: KoiMiddleware = {
  name: "web-logger",
  wrapToolCall: async (_ctx, request: ToolRequest, next: (r: ToolRequest) => Promise<ToolResponse>) => {
    if (request.toolId.startsWith("web_")) {
      console.log(`[web] ${request.toolId}(${JSON.stringify(request.input)})`);
    }
    const response = await next(request);
    if (request.toolId.startsWith("web_")) {
      console.log(`[web] ${request.toolId} → done`);
    }
    return response;
  },
};

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [webLogger],
  providers: [createWebProvider({ executor })],
});
```

---

## Configuration Reference

### WebExecutorConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fetchFn` | `typeof fetch` | `globalThis.fetch` | Custom fetch function (for testing or proxying) |
| `searchFn` | `(query, opts) => Promise<Result<...>>` | `undefined` | Search backend. Required for `web_search` |
| `maxBodyChars` | `number` | `50,000` | Max response body size in characters |
| `defaultTimeoutMs` | `number` | `15,000` | Default request timeout |
| `cacheTtlMs` | `number` | `0` (disabled) | Cache time-to-live. Set `> 0` to enable |
| `maxCacheEntries` | `number` | `100` | Max cached responses (LRU eviction) |

### WebProviderConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `executor` | `WebExecutor` | *(required)* | The executor instance |
| `trustTier` | `TrustTier` | `"verified"` | Trust tier for all tools |
| `prefix` | `string` | `"web"` | Tool name prefix (`{prefix}_fetch`) |
| `operations` | `WebOperation[]` | `["fetch", "search"]` | Which tools to expose |

### BraveSearchConfig (@koi/search-brave)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | *(required)* | Brave Search API key |
| `fetchFn` | `typeof fetch` | `globalThis.fetch` | Custom fetch (for testing) |
| `baseUrl` | `string` | `https://api.search.brave.com/res/v1` | API base URL |
| `timeoutMs` | `number` | `10,000` | Request timeout |
| `country` | `string` | `undefined` | Country code for localized results |
| `freshness` | `string` | `undefined` | `"pd"` (day), `"pw"` (week), `"pm"` (month) |

---

## Testing

### Test Structure

```
packages/tools-web/src/
  url-policy.test.ts             SSRF blocking rules (10 tests)
  strip-html.test.ts             HTML → plain text (12 tests)
  html-to-markdown.test.ts       HTML → Markdown (16 tests)
  web-executor.test.ts           Executor: fetch, search, cache, errors (21 tests)
  web-component-provider.test.ts Provider attach, operations, prefix (5 tests)
  tools/
    web-fetch.test.ts            Fetch tool: schema, validation, SSRF, formats (18 tests)
    web-search.test.ts           Search tool: schema, validation, results (9 tests)
  __tests__/
    e2e-full-stack.test.ts       Real LLM through full L1 runtime (9 tests)

packages/search-brave/src/
  brave-search.test.ts           Brave adapter: API, auth, errors (13 tests)
```

### Test Tiers

```
Tier 1: Unit tests (always run in CI)
═══════════════════════════════════════
  102 tests across 8 files
  ● SSRF: blocked IPs, domains, edge cases
  ● HTML conversion: headings, links, lists, entities
  ● Executor: fetch, search, caching, timeout, errors
  ● Tools: input validation, format handling, error mapping
  ● Provider: ECS attachment, operation filtering, prefix
  ● Brave: API calls, headers, params, error codes

Tier 2: Real LLM E2E (opt-in, needs ANTHROPIC_API_KEY)
═══════════════════════════════════════════════════════
  7 tests in e2e-full-stack.test.ts (2 more need BRAVE_API_KEY)
  ● Real Claude Haiku calls with tool schemas
  ● LLM discovers web_fetch, calls it with correct args
  ● Markdown format returns structured content
  ● SSRF protection blocks localhost (error flows to LLM)
  ● Middleware lifecycle: session_start → tool:web_fetch → session_end
  ● Response caching: 2 calls, 1 HTTP request
  ● Multi-provider: web tools + custom tools coexist
  ● Guard limits: maxTurns terminates cleanly
  ● Search + fetch pipeline (needs BRAVE_API_KEY)

  Run: E2E_TESTS=1 bun test packages/tools-web/src/__tests__/e2e-full-stack.test.ts
```

### Coverage

115 tests total (102 unit + 13 Brave unit + 9 E2E), 0 failures. Unit tests run on every build. E2E tests gated behind `E2E_TESTS=1`.

```bash
# Unit tests only (default)
bun --cwd packages/tools-web test
bun --cwd packages/search-brave test

# E2E with real LLM (needs ANTHROPIC_API_KEY in .env)
E2E_TESTS=1 bun test packages/tools-web/src/__tests__/e2e-full-stack.test.ts

# E2E including Brave search (needs both keys)
E2E_TESTS=1 BRAVE_API_KEY=BSA... bun test packages/tools-web/src/__tests__/e2e-full-stack.test.ts
```

---

## Comparison vs OpenClaw & NanoClaw

```
╔══════════════════════════╦═══════════╦═══════════╦═══════════════╗
║ Capability               ║ Koi       ║ OpenClaw  ║ NanoClaw      ║
╠══════════════════════════╬═══════════╬═══════════╬═══════════════╣
║ HTTP fetch               ║ ✅        ║ ✅        ║ ✅            ║
║ Web search               ║ ✅        ║ ✅        ║ ✅            ║
║ SSRF pre-request block   ║ ✅        ║ ✅        ║ ❌            ║
║ SSRF post-redirect block ║ ✅        ║ ✅        ║ ❌            ║
║ Response caching         ║ ✅ LRU+TTL║ ✅ Redis  ║ ❌            ║
║ Markdown output          ║ ✅        ║ ✅        ║ ❌ (text only)║
║ Pluggable search backend ║ ✅        ║ ❌ (fixed)║ ✅            ║
║ Built-in Brave adapter   ║ ✅        ║ ❌        ║ ❌            ║
║ Middleware interposition  ║ ✅        ║ ❌        ║ ❌            ║
║ Trust tier enforcement   ║ ✅        ║ ❌        ║ ✅            ║
║ Body size limiting       ║ ✅ 50KB   ║ ✅ 100KB  ║ ✅ 32KB       ║
║ Custom headers           ║ ✅        ║ ✅        ║ ❌            ║
║ Configurable timeout     ║ ✅        ║ ❌        ║ ✅            ║
║ Zero external deps       ║ ✅        ║ ❌ (axios)║ ❌ (node-fetch)║
╚══════════════════════════╩═══════════╩═══════════╩═══════════════╝
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| `WebExecutor` interface (not direct `fetch`) | Enables mock injection in tests; same interface for real HTTP and test doubles |
| ComponentProvider pattern | Tools attach via ECS — any engine adapter discovers them with zero engine changes |
| Both tools use same trust tier | Web fetch and search are both read-only operations; configurable per-deployment |
| SSRF checks at two points | Pre-request catches obvious private URLs; post-redirect catches open-redirect attacks to internal services |
| Regex-based URL blocking (no DNS) | Zero dependencies, deterministic, no DNS resolution latency. Covers RFC 1918, link-local, localhost, AWS metadata |
| LRU + TTL cache (not external) | No Redis/Memcached dependency. Cache is per-executor instance, GC-friendly. Set `cacheTtlMs: 0` to disable |
| `searchFn` is injectable | Decouples search backend from web tools. Brave, Google, SerpAPI, or any custom backend plug in via config |
| `@koi/search-brave` is separate L2 | Avoids L2→L2 dependency. `tools-web` never imports `search-brave`. User wires them at config time |
| `format` parameter on `web_fetch` | LLM can choose output format per-request. Markdown is best for content extraction; HTML for parsing; text for compact summaries |
| `htmlToMarkdown` is regex-based | 110 LOC, zero dependencies. Handles headings, links, bold, italic, lists, code blocks, blockquotes. Good enough for LLM consumption |
| `parseHeaders` runtime validation | Banned `as Record<string, string>` cast on untrusted input. Runtime check ensures all header values are strings |
| `WEB_SYSTEM_PROMPT` exported | Agents can include web tool best practices in their system prompt (error codes, usage guidelines) |
| Immutable `Object.fromEntries` for headers | No mutation of response headers object. New immutable record created from entries |
| `maxBodyChars` not `maxBodyBytes` | `string.length` counts UTF-16 code units, not bytes. Name reflects actual behavior |

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────┐
    Tool, ToolDescriptor, ComponentProvider,            │
    KoiError, Result, JsonObject, TrustTier,            │
    toolToken                                           │
                                                        │
                                                        ▼
L2  @koi/tools-web ◄────────────────────────────────┘
    imports from L0 only (runtime)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages (including @koi/search-brave)
    ✗ zero external npm dependencies
    ✓ WebExecutor is a plain interface (no vendor types)
    ✓ All interface properties readonly
    ✓ Tool execute returns structured objects (never throws)
    ✓ Engine adapter agnostic (works with Loop, Pi, LangGraph)

Companion package (optional, no import dependency):
L2  @koi/search-brave ◄──── @koi/core (L0) only
    Provides searchFn for WebExecutorConfig
    ✗ never imported by @koi/tools-web
    ✓ Plugged in at config time by user code

Dev-only imports (test files only):
    @koi/engine      — createKoi (E2E assembly)
    @koi/engine-pi   — createPiAdapter (real LLM E2E)
    @koi/search-brave — createBraveSearch (search E2E)
```
