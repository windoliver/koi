# @koi/lsp

Layer 2 package — Language Server Protocol integration for hover, go-to-definition, references, symbols, and diagnostics.

## Purpose

Bridges any LSP-compliant language server into Koi's ECS tool system via `ComponentProvider`. Supports TypeScript, Python, Go, Rust, and any other language with an LSP server. The agent gets code intelligence without needing language-specific logic.

### Tools (capability-gated)

| Tool | LSP Method | Description |
|------|-----------|-------------|
| `lsp__{server}__open_document` | `textDocument/didOpen` | Open a file for analysis (always available) |
| `lsp__{server}__close_document` | `textDocument/didClose` | Close a previously opened file (always available) |
| `lsp__{server}__get_diagnostics` | Cache read | Return compiler errors, warnings, lints (always available) |
| `lsp__{server}__hover` | `textDocument/hover` | Type info and docs at a position (requires `hoverProvider`) |
| `lsp__{server}__goto_definition` | `textDocument/definition` | Jump to symbol definition (requires `definitionProvider`) |
| `lsp__{server}__find_references` | `textDocument/references` | Find all usages of a symbol (requires `referencesProvider`) |
| `lsp__{server}__document_symbols` | `textDocument/documentSymbol` | List symbols in a file (requires `documentSymbolProvider`) |
| `lsp__{server}__workspace_symbols` | `workspace/symbol` | Search symbols across workspace (requires `workspaceSymbolProvider`) |

Tool names use `__` separators (not `/`) for OpenAI-compatible function name constraints.

## Architecture

```
Agent tool call
    |
createLspTools(client, serverName) -> Tool[]
    |
LspClient (lifecycle + methods composition)
    |
JsonRpcConnection (Content-Length framed JSON-RPC 2.0)
    |
LspTransport (Bun.spawn -> FileSink stdin + ReadableStream stdout)
    |
Language Server process (tsserver, pyright, rust-analyzer, etc.)
```

### Key modules

| Module | Purpose |
|--------|---------|
| `client.ts` | Thin composition of lifecycle + methods into `LspClient` interface |
| `lifecycle.ts` | Connection state machine, `withConnection`, reconnect, `workspace/configuration` handler, content-modified retry |
| `methods.ts` | LSP method wrappers (hover, definition, references, symbols, diagnostics, open/close) with 10MB file size guard |
| `jsonrpc.ts` | Bun-native JSON-RPC 2.0 over stdio (Content-Length framing, `onRequest` for server->client requests) |
| `transport.ts` | `Bun.spawn()` process management, returns `FileSink` stdin + `ReadableStream<Uint8Array>` stdout |
| `tool-adapter.ts` | Creates Koi `Tool` components from `LspClient` capabilities |
| `component-provider.ts` | Async factory with background warm-up, optional pool injection |
| `client-pool.ts` | Optional injectable LRU pool with idle-timeout eviction |
| `config.ts` | Server config validation and resolution |
| `server-detection.ts` | Auto-detect installed LSP servers |
| `language-map.ts` | File extension -> LSP languageId mapping |
| `diagnostic-adapter.ts` | Push diagnostics via `textDocument/publishDiagnostics` |
| `errors.ts` | Typed error factories including `isConnectionError(e: unknown)` |

## Usage

### Basic: create tools from a client

```typescript
import { createLspClient, createLspTools } from "@koi/lsp";

const client = createLspClient({
  serverName: "typescript",
  command: "typescript-language-server",
  args: ["--stdio"],
  rootUri: "file:///path/to/project",
});

// Tools are gated on server capabilities — only advertised tools are created
const tools = createLspTools(client, "typescript");
// => [open_document, close_document, get_diagnostics, hover, goto_definition, ...]
```

### Component provider (recommended for TUI/runtime)

```typescript
import { createLspComponentProvider } from "@koi/lsp";

const result = await createLspComponentProvider({
  servers: [
    { name: "ts", command: "typescript-language-server", args: ["--stdio"], rootUri: "file:///project" },
    { name: "py", command: "pyright-langserver", args: ["--stdio"], rootUri: "file:///project" },
  ],
});

// result.provider: ComponentProvider (attach to agent)
// result.failures: LspServerFailure[] (servers that failed to start)
```

### With pool (reuses connections across session resets)

```typescript
import { createLspClientPool, createLspComponentProvider } from "@koi/lsp";

const pool = createLspClientPool({ maxClients: 5, idleTimeoutMs: 60_000 });

const result = await createLspComponentProvider({
  servers: [{ name: "ts", command: "tls", args: ["--stdio"], rootUri: "file:///project" }],
  pool,
});
```

## CC audit improvements (vs v1)

| Feature | Description |
|---------|-------------|
| `onRequest` support | `JsonRpcConnection` handles server->client requests (TypeScript LS sends `workspace/configuration` even with `configuration: false`) |
| `workspace/configuration` handler | Returns `null` for all config requests to prevent server hangs |
| Content-modified retry | Retries operations that fail with `-32801` (rust-analyzer transient error). 3 attempts, 500ms/1s/2s backoff |
| 10MB file size guard | `openDocument` checks file size before `didOpen` — prevents LSP server hangs on huge files |
| `isConnectionError` export | Type guard for connection-class errors, useful for retry logic |
| Bun-native streams | `ReadableStream<Uint8Array>` + `FileSink` instead of Node.js `Readable`/`Writable` |
| `lsp__server__op` naming | Tool names use `__` separators instead of `/` for OpenAI API compatibility |

## Dependencies

- `@koi/core` (L0) — types only
- `@koi/errors` (L0u) — error factories
- `@koi/validation` (L0u) — config validation
- `zod` — schema validation

## Known limitations

- No git-ignore filtering of `findReferences`/`gotoDefinition` results (tracked as future improvement)
- No LSP `textDocument/completion` support (agents don't need autocomplete)
- No `textDocument/rename` support (agents use text editing tools instead)

## Runtime wiring (#1778)

`@koi/runtime.createRuntime` accepts an optional `config.lsp: LspProviderConfig`. Because LSP startup spawns language-server subprocesses and runs a JSON-RPC `initialize` handshake, `createRuntime` exposes LSP via a lazy thunk on `RuntimeHandle.lspProvider`:

```ts
const handle = createRuntime({ lsp: { servers: [...] } });
// No subprocesses spawned yet.
const { provider, clients, failures } = await handle.lspProvider!();
const koi = await createKoi({ manifest, adapter, providers: [provider] });
```

A runtime created and disposed without ever calling `handle.lspProvider()` does not spawn any subprocesses. When the caller did invoke it, `runtime.dispose()` awaits the cached startup to completion, then releases pooled clients via `lsp.pool.release()` (fail-closed fallback to `client.close()` on error) or closes them directly — mirroring the ref-counted detach semantics of the provider so warm pooled capacity is not double-released.

## TS 6 compatibility note

`src/jsonrpc.test.ts` and `src/client.test.ts` use a local `TextEncoder` + `concatU8` helper for building test payloads (previously `Buffer.from(string)` / `Buffer.concat([...])`). The change is test-only and resolves TS 6 typecheck errors (`Buffer<ArrayBufferLike>` is no longer structurally assignable to `Uint8Array<ArrayBufferLike>`). Runtime behavior unchanged.
