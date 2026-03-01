# @koi/acp — ACP Server Channel for IDE Integration

Makes Koi agents consumable by IDEs (JetBrains, Zed, VS Code) via the Agent Client Protocol (ACP v0.10.x, JSON-RPC 2.0 over stdio). Implements the `ChannelAdapter` contract so any Koi agent can be spawned as a subprocess and controlled by an IDE.

---

## Why It Exists

IDEs are adopting ACP as the standard protocol for integrating coding agents. Without this package, Koi agents can only be used through Koi's own CLI or gateway. `@koi/acp` bridges that gap — an IDE spawns `koi serve --manifest koi.yaml` and talks to the agent over stdin/stdout using the same protocol it uses for Claude Code or Gemini CLI.

---

## What This Enables

```
BEFORE: IDEs cannot use Koi agents
═══════════════════════════════════

  ┌─────────┐                              ┌─────────────┐
  │  IDE     │          ??? no way          │  Koi Agent  │
  │ (Zed,   │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶   │  (engine +  │
  │  IDEA)  │     to talk to Koi           │  tools)     │
  └─────────┘                              └─────────────┘

  IDEs speak ACP. Koi had no ACP server.
  Only Koi CLI and Koi Gateway could drive agents.


AFTER: any ACP-compatible IDE can use Koi agents
═════════════════════════════════════════════════

  ┌──────────┐   stdio (JSON-RPC)    ┌────────────┐
  │ JetBrains│ ◀════════════════════▶│            │   ┌──────────┐
  │   IDEA   │                       │  @koi/acp  │──▶│Koi Agent │
  └──────────┘                       │  (channel) │   │ engine + │
                                     │            │   │ tools +  │
  ┌──────────┐   stdio (JSON-RPC)    │  Translates│   │middleware│
  │   Zed    │ ◀════════════════════▶│  ACP <-> Koi│   └──────────┘
  │  Editor  │                       │            │
  └──────────┘                       └────────────┘

  $ koi serve --manifest koi.yaml
  # IDE spawns this process and communicates via stdin/stdout
```

---

## Architecture

**Layer**: L2 (feature package)
**Depends on**: `@koi/core` (L0), `@koi/acp-protocol` (L0u), `@koi/resolve` (L0u)
**Implements**: `ChannelAdapter` contract from `@koi/core`

### Module Map

```
@koi/acp/src/
├── acp-channel.ts       # Main factory: createAcpChannel() -> ChannelAdapter
├── protocol-handler.ts  # Handles initialize, session/new, session/prompt, session/cancel
├── request-tracker.ts   # Outbound request lifecycle with per-type timeouts
├── approval-bridge.ts   # Koi ApprovalHandler -> ACP session/request_permission
├── server-transport.ts  # createProcessTransport() for stdin/stdout
├── descriptor.ts        # BrickDescriptor for manifest auto-resolution
├── types.ts             # AcpServerConfig, defaults
└── index.ts             # Public exports
```

---

## Protocol Flow

```
IDE (JetBrains/Zed)          @koi/acp ChannelAdapter           Koi Engine
       │                            │                              │
       │── initialize ─────────────▶│                              │
       │◀── {agentCapabilities} ────│                              │
       │                            │                              │
       │── session/new ────────────▶│  create session context      │
       │◀── {sessionId} ───────────│                              │
       │                            │                              │
       │── session/prompt ─────────▶│  mapAcpContentToKoi()        │
       │                            │── onMessage(inbound) ───────▶│
       │                            │                              │── stream
       │                            │◀── EngineEvent ─────────────│
       │◀── session/update ────────│   mapEngineEventToAcp()      │
       │◀── session/update ────────│                              │
       │                            │                              │
       │◀── request_permission ────│◀── ApprovalHandler fired ───│
       │── {allow/deny} ──────────▶│── ApprovalDecision ─────────▶│
       │                            │                              │
       │◀── session/update ────────│◀── more EngineEvents ───────│
       │◀── {stopReason} ─────────│◀── done event ───────────────│
       │                            │                              │
       │── session/cancel ────────▶│  controller.abort()          │
       │                            │                              │
  stdin EOF                         │  disconnect() -> cleanup     │
```

---

## Key APIs

### Factory

```typescript
function createAcpChannel(config?: AcpServerConfig): AcpChannelAdapter
```

Returns a `ChannelAdapter` that:
- Reads JSON-RPC requests from stdin, writes responses to stdout
- Translates between ACP and Koi content/event formats
- Provides an `ApprovalHandler` for tool permission prompts
- Supports one active session at a time (sequential sessions OK)

### Configuration

```typescript
interface AcpServerConfig {
  readonly agentInfo?: { name?: string; title?: string; version?: string };
  readonly agentCapabilities?: AgentCapabilities;
  readonly timeouts?: {
    readonly fsMs?: number;          // default 30s
    readonly terminalMs?: number;    // default 300s
    readonly permissionMs?: number;  // default 60s
  };
  readonly backpressureLimit?: number; // default 100
}
```

### Manifest Usage

```yaml
# koi.yaml
channel:
  name: acp-server
  options:
    agentInfo:
      name: "my-agent"
      version: "1.0.0"
```

### BrickDescriptor

| Field | Value |
|-------|-------|
| `kind` | `"channel"` |
| `name` | `"@koi/acp"` |
| `aliases` | `["acp-server"]` |
| `tags` | `["acp", "ide", "channel", "json-rpc"]` |

---

## Approval Bridge

When the Koi engine needs tool permission (e.g., "write file?"), the approval bridge translates it into an ACP `session/request_permission` request sent to the IDE. The IDE shows a native dialog and responds with allow/deny.

```
Koi middleware               @koi/acp                    IDE
      │                         │                         │
      │── ApprovalRequest ─────▶│                         │
      │   (tool: "write_file")  │── request_permission ──▶│
      │                         │                         │── show dialog
      │                         │◀── {selected: "allow"} ─│
      │◀── { kind: "allow" } ──│                         │
      │                         │                         │
      │   On timeout/error:     │                         │
      │◀── { kind: "deny" } ───│  (fail-closed)          │
```

---

## Session Model

One agent per process, sequential sessions:

```
Process starts
    │
    ▼
 initialize          (once, handshake)
    │
    ▼
 session/new ──▶ session/prompt ──▶ result    (session 1)
    │
    ▼
 session/new ──▶ session/prompt ──▶ result    (session 2)
    │
    ▼
 stdin EOF ──▶ cleanup
```

Concurrent prompts are rejected. A running prompt can be cancelled via `session/cancel`.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session model | One agent per process | Matches ACP spec expectations; IDE spawns one process per agent |
| Backpressure | Bounded buffer (100) | Prevent memory growth when stdout is slow |
| Timeout strategy | Per-request type | fs ops (30s), terminal (300s), permissions (60s) — different SLAs |
| Approval on error | Fail-closed (deny) | Security: if IDE doesn't respond, deny the tool call |
| Event mapping | 1:1 notifications | No coalescing — IDE controls rendering cadence |
| Transport | stdin/stdout via Bun APIs | No external dependencies; matches ACP subprocess model |

---

## Comparison: @koi/acp vs @koi/engine-acp

```
@koi/acp (this package)         @koi/engine-acp
═══════════════════════         ═══════════════
Direction: IDE -> Koi           Direction: Koi -> external agent
Role: Koi IS the agent          Role: Koi USES an agent
Protocol side: SERVER           Protocol side: CLIENT
ChannelAdapter                  EngineAdapter
IDE spawns Koi process          Koi spawns agent process
Reads from own stdin            Writes to child stdin
Writes to own stdout            Reads from child stdout
```

Both share protocol primitives via `@koi/acp-protocol`.

---

## Layer Compliance

- [x] Imports only from `@koi/core` (L0) and L0u packages
- [x] No L1 (`@koi/engine`) imports
- [x] No peer L2 imports
- [x] All interface properties are `readonly`
- [x] No vendor-specific types
- [x] `ChannelAdapter` interface fully implemented
