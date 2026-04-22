# P3 — `@koi/browser-ext` Native Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the native-messaging host subsystem of `@koi/browser-ext` — the Node.js subprocess that Chrome launches when its MV3 extension connects via `chrome.runtime.connectNative`. The host bridges between the browser extension (stdin/stdout NM frames) and one or more Koi driver clients (Unix socket CDP traffic). Implements every wire invariant defined in the spec: schema validation with direction enforcement, `installId` handshake with grant revocation, session-scoped chunk reassembly, per-request attach correlation, quarantine journal, boot-time orphan probe.

**Architecture:** Single L2 package at `packages/drivers/browser-ext/`. P3 fills in the `src/native-host/` subtree; the driver (`src/driver.ts`, `src/unix-socket-transport.ts`) lands in P5. The MV3 extension source (`extension/`) lands in P4. CLI (`src/bin/koi-browser-ext.ts`, installer flows) lands in P6. **Node.js runtime only** — Bun's stdin framing under Chrome's NM pipe is not validated; see spec §6.6.

**Tech Stack:** Node.js ≥20.11 at runtime (pinned — no Bun fallback), TypeScript 6 strict, tsup build, `bun:test` for unit tests, `zod` for wire schema validation. The host subprocess itself runs on Node; unit tests run under Bun because that's the monorepo test runner. Integration tests spawn real Node subprocesses via `child_process.spawn`.

**Spec reference:** `docs/superpowers/specs/2026-04-18-issue-1609-browser-ext-design.md` — §5.1 (package layout), §6 (wire protocol), §7 (security), §8.3 (host lifecycle), §8.4 (MV3 keepalive — informs test design), §8.5 (attach-lease + detach + quarantine), §8.6 (attach FSM on extension side — informs what host expects), §8.7 (uninstall + admin_clear_grants), §9 (error codes).

**Stacking:** This plan sits on top of `main` (not P1/P2). P3 does not depend on P1 or P2 — the native host talks to no browser driver yet. New branch: `p3-browser-ext-host` off main.

---

## File structure

Files this plan creates:

```
packages/drivers/browser-ext/
  package.json                                          ← L2 manifest (ext + node deps)
  tsconfig.json                                         ← extends base, references @koi/core
  tsup.config.ts                                        ← ESM-only build, 2 entries (host + CLI future)
  src/
    index.ts                                            ← placeholder; P5 fills in
    native-host/
      index.ts                                          ← exports runNativeHost, constants
      frame-reader.ts                                   ← 4-byte LE length-prefixed NM frame reader
      frame-writer.ts                                   ← 4-byte LE length-prefixed NM frame writer
      driver-frame.ts                                   ← zod schema + type + direction guard for DriverFrame
      nm-frame.ts                                       ← zod schema + type + direction guard for NmFrame
      auth.ts                                           ← token + admin.key read; hello validation
      install-id.ts                                     ← installId generate / read / persist
      socket-server.ts                                  ← unix socket listen + accept loop, secure perms
      discovery.ts                                      ← instances/<pid>.json atomic write with (epoch,seq)
      ownership-map.ts                                  ← Map<tabId, TabOwnership>; committed | detaching_failed
      in-flight-map.ts                                  ← Map<InFlightKey, InFlightAttach>; composite key
      attach-flow.ts                                    ← attach frame handler (all §8.6 rules)
      detach-flow.ts                                    ← detach frame handler + detach_ack timeout + quarantine transition
      quarantine-journal.ts                             ← per-instance JSON file; merge-under-flock writer
      chunk-reassembly.ts                               ← session-scoped chunk buffer; payloadKind discriminator
      control-frames.ts                                 ← extension_hello + host_hello + ping/pong watchdog
      probe.ts                                          ← boot-time attach_state_probe request/response coordinator
      admin-flow.ts                                     ← admin_clear_grants responder (protocol level only — CLI wires it in P6)
      host.ts                                           ← top-level orchestrator: assembles all the above + owns subprocess lifecycle
    __tests__/
      frame-reader.test.ts
      frame-writer.test.ts
      driver-frame.test.ts
      nm-frame.test.ts
      auth.test.ts
      install-id.test.ts
      socket-server.test.ts
      discovery.test.ts
      ownership-map.test.ts
      in-flight-map.test.ts
      attach-flow.test.ts
      detach-flow.test.ts
      quarantine-journal.test.ts
      chunk-reassembly.test.ts
      control-frames.test.ts
      probe.test.ts
      admin-flow.test.ts
      api-surface.test.ts                               ← pins native-host/index.ts exports
      __integration__/
        native-host.integration.test.ts                 ← spawns real Node subprocess; simulated NM stdin
        attach-lease.integration.test.ts                ← two driver clients racing for same tab
        chunk-crash.integration.test.ts                 ← SIGKILL mid-chunk; compensating detach
        reconnect-singleflight.integration.test.ts      ← single-flight reconnect under concurrent triggers
        quarantine-durability.integration.test.ts       ← quarantine journal survives host restart
```

Files this plan modifies:

```
scripts/layers.ts                                       ← add "@koi/browser-ext" to L2_PACKAGES
docs/L2/browser-ext.md                                  ← new: package overview
```

**Out of scope for P3:**
- `src/driver.ts` + `src/unix-socket-transport.ts` — P5.
- `extension/` directory — P4.
- `src/bin/koi-browser-ext.ts` and install/uninstall CLIs — P6.
- Runtime wiring + golden queries — P7.
- `reattach` policy exposure to drivers — P5 (driver-side API).

---

## Task 1: Scaffold `@koi/browser-ext` L2 package

**Files:** Create `packages/drivers/browser-ext/{package.json,tsconfig.json,tsup.config.ts,src/index.ts}`.

- [ ] **Step 1**: `mkdir -p packages/drivers/browser-ext/src/native-host packages/drivers/browser-ext/src/__tests__/__integration__`

- [ ] **Step 2**: Write `packages/drivers/browser-ext/package.json`:

```json
{
  "name": "@koi/browser-ext",
  "description": "Extension-injected browser session driver + native messaging host — attaches to user's live Chrome without restart (closes issue #1609)",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./native-host": {
      "types": "./dist/native-host/index.d.ts",
      "import": "./dist/native-host/index.js"
    }
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "zod": "^3.23.0"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test",
    "test:api": "bun test src/__tests__/api-surface.test.ts"
  }
}
```

Notes:
- No `playwright`, no `@koi/browser-a11y`, no `@koi/browser-playwright` dep yet — those come in P5 when the driver lands.
- Zod matches the version used elsewhere in the monorepo (check `packages/lib/errors/package.json` or similar; use the same range).
- Two exports: root (`index.ts`, placeholder until P5) and `./native-host` (the host subsystem this plan builds).

- [ ] **Step 3**: Write `packages/drivers/browser-ext/tsconfig.json`:

```json
{"extends":"../../../tsconfig.base.json","compilerOptions":{"outDir":"dist","rootDir":"src"},"include":["src/**/*"],"references":[{"path":"../../kernel/core"}]}
```

(Biome will format — if multi-line is preferred by existing packages, use multi-line.)

- [ ] **Step 4**: Write `packages/drivers/browser-ext/tsup.config.ts`:

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "native-host/index": "src/native-host/index.ts",
  },
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
});
```

- [ ] **Step 5**: Placeholder `src/index.ts`:

```typescript
export {};
```

Placeholder `src/native-host/index.ts`:

```typescript
export {};
```

- [ ] **Step 6**: `bun install`. Expect success.

- [ ] **Step 7**: `bun run --cwd packages/drivers/browser-ext build`. Expect creation of `dist/index.js`, `dist/index.d.ts`, `dist/native-host/index.js`, `dist/native-host/index.d.ts`.

- [ ] **Step 8**: Commit:

```bash
git add packages/drivers/browser-ext/ bun.lock
git commit -m "feat(browser-ext): scaffold L2 package (host + driver subtree, driver impl pending in P5)"
```

---

## Task 2: NM frame reader — 4-byte LE length prefix

Implements Chrome's native messaging framing: each message is a 4-byte little-endian length prefix followed by that many bytes of UTF-8 JSON. Max 1 MB per frame per Chrome's spec.

**Files:** Create `src/native-host/frame-reader.ts` + test.

- [ ] **Step 1**: Write failing test `src/__tests__/frame-reader.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";

import { createFrameReader, MAX_FRAME_SIZE } from "../native-host/frame-reader.js";

function framed(payload: string): Buffer {
  const body = Buffer.from(payload, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

async function* iterateFrames(chunks: readonly Buffer[]): AsyncGenerator<string> {
  const stream = Readable.from(chunks);
  const reader = createFrameReader(stream);
  for await (const frame of reader) {
    yield frame;
  }
}

describe("createFrameReader", () => {
  test("reads a single framed message", async () => {
    const frames: string[] = [];
    for await (const f of iterateFrames([framed('{"kind":"ping","seq":1}')])) {
      frames.push(f);
    }
    expect(frames).toEqual(['{"kind":"ping","seq":1}']);
  });

  test("reads multiple framed messages in one chunk", async () => {
    const f1 = framed('{"a":1}');
    const f2 = framed('{"b":2}');
    const combined = Buffer.concat([f1, f2]);
    const frames: string[] = [];
    for await (const f of iterateFrames([combined])) {
      frames.push(f);
    }
    expect(frames).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("reassembles frames split across chunk boundaries", async () => {
    const whole = framed('{"kind":"attach","tabId":42}');
    // Split into arbitrary chunks: 2 bytes, 3 bytes, rest.
    const chunks = [whole.subarray(0, 2), whole.subarray(2, 5), whole.subarray(5)];
    const frames: string[] = [];
    for await (const f of iterateFrames(chunks)) {
      frames.push(f);
    }
    expect(frames).toEqual(['{"kind":"attach","tabId":42}']);
  });

  test("terminates on end-of-stream with no pending frame", async () => {
    const frames: string[] = [];
    for await (const f of iterateFrames([])) {
      frames.push(f);
    }
    expect(frames).toEqual([]);
  });

  test("rejects frames larger than MAX_FRAME_SIZE", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_SIZE + 1, 0);
    const stream = Readable.from([header]);
    await expect(async () => {
      const reader = createFrameReader(stream);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of reader) { /* consume */ }
    }).toThrow(/max frame size/i);
  });

  test("rejects zero-length frames as protocol violation", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0, 0);
    const stream = Readable.from([header]);
    await expect(async () => {
      const reader = createFrameReader(stream);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of reader) { /* consume */ }
    }).toThrow(/zero-length/i);
  });
});
```

- [ ] **Step 2**: Run the test; expect FAIL (module not found).

- [ ] **Step 3**: Implement `src/native-host/frame-reader.ts`:

```typescript
import type { Readable } from "node:stream";

export const MAX_FRAME_SIZE = 1024 * 1024; // 1 MB per Chrome's NM spec

/**
 * Reads length-prefixed frames from a stream. Each frame = 4-byte LE length +
 * `length` bytes of UTF-8 JSON. Yields decoded JSON strings.
 *
 * Rejects: zero-length frames (protocol violation), frames > MAX_FRAME_SIZE,
 * truncated streams (buffered bytes remaining when stream ends).
 */
export async function* createFrameReader(stream: Readable): AsyncGenerator<string> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length === 0) {
        throw new Error("Frame reader: zero-length frame is a protocol violation");
      }
      if (length > MAX_FRAME_SIZE) {
        throw new Error(
          `Frame reader: frame of ${length} bytes exceeds max frame size ${MAX_FRAME_SIZE}`,
        );
      }
      if (buffer.length < 4 + length) {
        break; // wait for more bytes
      }
      const bodyStart = 4;
      const bodyEnd = 4 + length;
      const body = buffer.subarray(bodyStart, bodyEnd);
      buffer = buffer.subarray(bodyEnd);
      yield body.toString("utf-8");
    }
  }
  if (buffer.length > 0) {
    throw new Error(
      `Frame reader: stream ended with ${buffer.length} unread bytes (truncated frame)`,
    );
  }
}
```

- [ ] **Step 4**: Run test; expect PASS.

- [ ] **Step 5**: Typecheck + commit:

```bash
bun run --cwd packages/drivers/browser-ext typecheck
git add packages/drivers/browser-ext/src/native-host/frame-reader.ts packages/drivers/browser-ext/src/__tests__/frame-reader.test.ts
git commit -m "feat(browser-ext): NM frame reader (4-byte LE length prefix)"
```

---

## Task 3: NM frame writer — symmetric with reader

**Files:** Create `src/native-host/frame-writer.ts` + test.

- [ ] **Step 1**: Failing test `src/__tests__/frame-writer.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { createFrameWriter, MAX_FRAME_SIZE } from "../native-host/frame-writer.js";

describe("createFrameWriter", () => {
  test("writes a single frame with correct 4-byte LE length prefix", async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c) => chunks.push(c as Buffer));
    const writer = createFrameWriter(sink);

    const payload = '{"kind":"pong","seq":7}';
    await writer.write(payload);
    writer.close();
    await new Promise<void>((resolve) => sink.on("end", () => resolve()));

    const combined = Buffer.concat(chunks);
    expect(combined.length).toBe(4 + payload.length);
    expect(combined.readUInt32LE(0)).toBe(payload.length);
    expect(combined.subarray(4).toString("utf-8")).toBe(payload);
  });

  test("serializes multiple frames with individual prefixes", async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c) => chunks.push(c as Buffer));
    const writer = createFrameWriter(sink);

    await writer.write('{"a":1}');
    await writer.write('{"b":2}');
    writer.close();
    await new Promise<void>((resolve) => sink.on("end", () => resolve()));

    const combined = Buffer.concat(chunks);
    // First frame
    expect(combined.readUInt32LE(0)).toBe(7);
    expect(combined.subarray(4, 11).toString("utf-8")).toBe('{"a":1}');
    // Second frame
    expect(combined.readUInt32LE(11)).toBe(7);
    expect(combined.subarray(15, 22).toString("utf-8")).toBe('{"b":2}');
  });

  test("rejects payloads exceeding MAX_FRAME_SIZE", async () => {
    const sink = new PassThrough();
    const writer = createFrameWriter(sink);
    const oversized = "x".repeat(MAX_FRAME_SIZE + 1);
    await expect(writer.write(oversized)).rejects.toThrow(/max frame size/i);
  });
});
```

- [ ] **Step 2**: Expect FAIL.

- [ ] **Step 3**: Implement `src/native-host/frame-writer.ts`:

```typescript
import type { Writable } from "node:stream";

export const MAX_FRAME_SIZE = 1024 * 1024;

export interface FrameWriter {
  readonly write: (payload: string) => Promise<void>;
  readonly close: () => void;
}

export function createFrameWriter(sink: Writable): FrameWriter {
  let closed = false;
  return {
    async write(payload: string): Promise<void> {
      if (closed) throw new Error("Frame writer: closed");
      const body = Buffer.from(payload, "utf-8");
      if (body.byteLength > MAX_FRAME_SIZE) {
        throw new Error(
          `Frame writer: payload of ${body.byteLength} bytes exceeds max frame size ${MAX_FRAME_SIZE}`,
        );
      }
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.byteLength, 0);
      // Backpressure-aware write.
      if (!sink.write(Buffer.concat([header, body]))) {
        await new Promise<void>((resolve) => sink.once("drain", () => resolve()));
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      sink.end();
    },
  };
}
```

- [ ] **Step 4**: Run test; expect PASS.

- [ ] **Step 5**: Commit:

```bash
git add packages/drivers/browser-ext/src/native-host/frame-writer.ts packages/drivers/browser-ext/src/__tests__/frame-writer.test.ts
git commit -m "feat(browser-ext): NM frame writer (symmetric with reader)"
```

---

## Task 4: `DriverFrame` zod schema + direction guard

Spec §6.1 defines `DriverFrame` (driver-socket channel). This task encodes it with zod for runtime validation + exports a TS type + a direction predicate that rejects NM-only frames (`abandon_attach`, `detached`, `admin_clear_grants`, etc.) if they somehow arrive on the driver socket.

**Files:** Create `src/native-host/driver-frame.ts` + test.

- [ ] **Step 1**: Failing test `src/__tests__/driver-frame.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { DriverFrameSchema, isDriverOriginated, isHostOriginated } from "../native-host/driver-frame.js";

describe("DriverFrameSchema — happy paths", () => {
  test.each([
    ["hello", { kind: "hello", token: "a".repeat(64), driverVersion: "0.1.0", supportedProtocols: [1], leaseToken: "f".repeat(32) }],
    ["hello with admin", { kind: "hello", token: "a".repeat(64), driverVersion: "0.1.0", supportedProtocols: [1], leaseToken: "f".repeat(32), admin: { adminKey: "b".repeat(64) } }],
    ["list_tabs", { kind: "list_tabs" }],
    ["attach (no reattach)", { kind: "attach", tabId: 42, leaseToken: "f".repeat(32), attachRequestId: "11111111-1111-4111-8111-111111111111" }],
    ["attach (reattach enum)", { kind: "attach", tabId: 42, leaseToken: "f".repeat(32), attachRequestId: "11111111-1111-4111-8111-111111111111", reattach: "consent_required_if_missing" }],
    ["detach", { kind: "detach", sessionId: "22222222-2222-4222-8222-222222222222" }],
    ["cdp", { kind: "cdp", sessionId: "22222222-2222-4222-8222-222222222222", method: "Page.navigate", params: { url: "https://example.com" }, id: 1 }],
    ["chunk", { kind: "chunk", sessionId: "22222222-2222-4222-8222-222222222222", correlationId: "r:7", payloadKind: "result_value", index: 0, total: 3, data: "aGVsbG8=" }],
    ["bye", { kind: "bye" }],
  ] as const)("accepts valid %s frame", (_name, frame) => {
    const result = DriverFrameSchema.safeParse(frame);
    expect(result.success).toBe(true);
  });
});

describe("DriverFrameSchema — direction enforcement", () => {
  test("rejects NM-only frame types on driver channel", () => {
    const nmOnly = [
      { kind: "abandon_attach", leaseToken: "f".repeat(32) },
      { kind: "abandon_attach_ack", leaseToken: "f".repeat(32), affectedTabs: [42] },
      { kind: "detached", sessionId: "22222222-2222-4222-8222-222222222222", tabId: 42, reason: "private_origin" },
      { kind: "admin_clear_grants", scope: "all" },
      { kind: "admin_clear_grants_ack", clearedOrigins: [], detachedTabs: [] },
      { kind: "attach_state_probe", requestId: "rr" },
      { kind: "attach_state_probe_ack", requestId: "rr", attachedTabs: [] },
    ];
    for (const frame of nmOnly) {
      const result = DriverFrameSchema.safeParse(frame);
      expect(result.success).toBe(false);
    }
  });

  test("rejects bad reattach enum value", () => {
    const bad = { kind: "attach", tabId: 42, leaseToken: "f".repeat(32), attachRequestId: "11111111-1111-4111-8111-111111111111", reattach: "true" };
    expect(DriverFrameSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects non-UUID sessionId", () => {
    const bad = { kind: "cdp", sessionId: "not-a-uuid", method: "Page.navigate", params: {}, id: 1 };
    expect(DriverFrameSchema.safeParse(bad).success).toBe(false);
  });
});

describe("isDriverOriginated / isHostOriginated", () => {
  test("hello is driver-originated", () => {
    expect(isDriverOriginated({ kind: "hello" } as never)).toBe(true);
    expect(isHostOriginated({ kind: "hello" } as never)).toBe(false);
  });
  test("hello_ack is host-originated", () => {
    expect(isHostOriginated({ kind: "hello_ack" } as never)).toBe(true);
    expect(isDriverOriginated({ kind: "hello_ack" } as never)).toBe(false);
  });
  test("cdp is driver-originated, cdp_result is host-originated", () => {
    expect(isDriverOriginated({ kind: "cdp" } as never)).toBe(true);
    expect(isHostOriginated({ kind: "cdp_result" } as never)).toBe(true);
  });
  test("session_ended is host-originated only (host → driver)", () => {
    expect(isHostOriginated({ kind: "session_ended" } as never)).toBe(true);
    expect(isDriverOriginated({ kind: "session_ended" } as never)).toBe(false);
  });
});
```

- [ ] **Step 2**: Expect FAIL.

- [ ] **Step 3**: Implement `src/native-host/driver-frame.ts` using `z.discriminatedUnion` on `kind`. Include every variant from spec §6.1's `DriverFrame`:

```typescript
import { z } from "zod";

const UUID = z.string().uuid();
const LeaseToken = z.string().regex(/^[0-9a-f]{32}$/);
const Token = z.string().min(16);

const ReattachPolicy = z.union([
  z.literal(false),
  z.literal("consent_required_if_missing"),
  z.literal("prompt_if_missing"),
]);

const HelloSchema = z.object({
  kind: z.literal("hello"),
  token: Token,
  driverVersion: z.string(),
  supportedProtocols: z.array(z.number().int().positive()).readonly(),
  leaseToken: LeaseToken,
  admin: z.object({ adminKey: Token }).optional(),
});

const HelloAckOkSchema = z.object({
  kind: z.literal("hello_ack"),
  ok: z.literal(true),
  role: z.union([z.literal("driver"), z.literal("admin")]),
  hostVersion: z.string(),
  extensionVersion: z.string().nullable(),
  wsEndpoint: z.string(),
  selectedProtocol: z.number().int().positive(),
});

const HelloAckFailSchema = z.object({
  kind: z.literal("hello_ack"),
  ok: z.literal(false),
  reason: z.enum([
    "bad_token",
    "bad_admin_key",
    "lease_collision",
    "bad_lease_token",
    "extension_not_connected",
    "version_mismatch",
  ]),
  hostSupportedProtocols: z.array(z.number().int().positive()).optional(),
});

const ListTabsSchema = z.object({ kind: z.literal("list_tabs") });
const TabsSchema = z.object({
  kind: z.literal("tabs"),
  tabs: z.array(z.object({ id: z.number().int(), url: z.string(), title: z.string() })).readonly(),
});

const AttachSchema = z.object({
  kind: z.literal("attach"),
  tabId: z.number().int(),
  leaseToken: LeaseToken,
  attachRequestId: UUID,
  reattach: ReattachPolicy.optional(),
});

const AttachAckOkSchema = z.object({
  kind: z.literal("attach_ack"),
  ok: z.literal(true),
  tabId: z.number().int(),
  leaseToken: LeaseToken,
  attachRequestId: UUID,
  sessionId: UUID,
});

const AttachAckFailSchema = z.object({
  kind: z.literal("attach_ack"),
  ok: z.literal(false),
  tabId: z.number().int(),
  leaseToken: LeaseToken,
  attachRequestId: UUID,
  reason: z.enum([
    "no_permission",
    "tab_closed",
    "user_denied",
    "private_origin",
    "timeout",
    "already_attached",
    "consent_required",
  ]),
  currentOwner: z
    .object({ clientId: z.string(), since: z.string() })
    .optional(),
});

const DetachSchema = z.object({ kind: z.literal("detach"), sessionId: UUID });
const DetachAckSchema = z.object({
  kind: z.literal("detach_ack"),
  sessionId: UUID,
  ok: z.boolean(),
  reason: z.enum(["not_attached", "chrome_error", "timeout"]).optional(),
});

const CdpSchema = z.object({
  kind: z.literal("cdp"),
  sessionId: UUID,
  method: z.string(),
  params: z.unknown(),
  id: z.number().int(),
});
const CdpResultSchema = z.object({
  kind: z.literal("cdp_result"),
  sessionId: UUID,
  id: z.number().int(),
  result: z.unknown(),
});
const CdpErrorSchema = z.object({
  kind: z.literal("cdp_error"),
  sessionId: UUID,
  id: z.number().int(),
  error: z.object({ code: z.number().int(), message: z.string() }),
});
const CdpEventSchema = z.object({
  kind: z.literal("cdp_event"),
  sessionId: UUID,
  eventId: z.string(),
  method: z.string(),
  params: z.unknown(),
});

const SessionEndedSchema = z.object({
  kind: z.literal("session_ended"),
  sessionId: UUID,
  tabId: z.number().int(),
  reason: z.enum([
    "navigated_away",
    "private_origin",
    "tab_closed",
    "devtools_opened",
    "extension_reload",
    "unknown",
  ]),
});

const ByeSchema = z.object({ kind: z.literal("bye") });

const ChunkSchema = z.object({
  kind: z.literal("chunk"),
  sessionId: UUID,
  correlationId: z.string(),
  payloadKind: z.enum(["result_value", "event_frame"]),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  data: z.string(),
});

export const DriverFrameSchema = z.discriminatedUnion("kind", [
  HelloSchema,
  HelloAckOkSchema,
  HelloAckFailSchema,
  ListTabsSchema,
  TabsSchema,
  AttachSchema,
  AttachAckOkSchema,
  AttachAckFailSchema,
  DetachSchema,
  DetachAckSchema,
  CdpSchema,
  CdpResultSchema,
  CdpErrorSchema,
  CdpEventSchema,
  SessionEndedSchema,
  ByeSchema,
  ChunkSchema,
]);

export type DriverFrame = z.infer<typeof DriverFrameSchema>;

const DRIVER_ORIGINATED_KINDS = new Set<DriverFrame["kind"]>([
  "hello",
  "list_tabs",
  "attach",
  "detach",
  "cdp",
  "bye",
]);

const HOST_ORIGINATED_KINDS = new Set<DriverFrame["kind"]>([
  "hello_ack",
  "tabs",
  "attach_ack",
  "detach_ack",
  "cdp_result",
  "cdp_error",
  "cdp_event",
  "session_ended",
  "chunk",
]);

export function isDriverOriginated(frame: DriverFrame): boolean {
  return DRIVER_ORIGINATED_KINDS.has(frame.kind);
}

export function isHostOriginated(frame: DriverFrame): boolean {
  return HOST_ORIGINATED_KINDS.has(frame.kind);
}
```

- [ ] **Step 4**: Run test; expect PASS.

- [ ] **Step 5**: Commit:

```bash
git add packages/drivers/browser-ext/src/native-host/driver-frame.ts packages/drivers/browser-ext/src/__tests__/driver-frame.test.ts
git commit -m "feat(browser-ext): DriverFrame zod schema + direction predicates"
```

---

## Task 5: `NmFrame` zod schema + direction guard

Spec §6.1's `NmFrame` — host ↔ extension channel. Strictly disjoint from `DriverFrame` on the NM-only shapes (`abandon_attach`, `detached`, `admin_clear_grants`, `attach_state_probe`).

**Files:** Create `src/native-host/nm-frame.ts` + test.

- [ ] **Step 1**: Failing test `src/__tests__/nm-frame.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { isExtensionOriginated, isHostOriginatedNm, NmFrameSchema } from "../native-host/nm-frame.js";

describe("NmFrameSchema — happy paths", () => {
  test.each([
    ["list_tabs", { kind: "list_tabs" }],
    ["attach", { kind: "attach", tabId: 42, leaseToken: "f".repeat(32), attachRequestId: "11111111-1111-4111-8111-111111111111" }],
    ["detach (with tabId)", { kind: "detach", sessionId: "22222222-2222-4222-8222-222222222222", tabId: 42 }],
    ["detach_ack", { kind: "detach_ack", sessionId: "22222222-2222-4222-8222-222222222222", tabId: 42, ok: true }],
    ["abandon_attach", { kind: "abandon_attach", leaseToken: "f".repeat(32) }],
    ["abandon_attach_ack", { kind: "abandon_attach_ack", leaseToken: "f".repeat(32), affectedTabs: [42] }],
    ["admin_clear_grants", { kind: "admin_clear_grants", scope: "all" }],
    ["admin_clear_grants_ack", { kind: "admin_clear_grants_ack", clearedOrigins: ["https://example.com"], detachedTabs: [42] }],
    ["attach_state_probe", { kind: "attach_state_probe", requestId: "probe-1" }],
    ["attach_state_probe_ack", { kind: "attach_state_probe_ack", requestId: "probe-1", attachedTabs: [42, 43] }],
    ["detached (priorDetachSuccess)", { kind: "detached", sessionId: "22222222-2222-4222-8222-222222222222", tabId: 42, reason: "navigated_away", priorDetachSuccess: true }],
    ["chunk", { kind: "chunk", sessionId: "22222222-2222-4222-8222-222222222222", correlationId: "r:7", payloadKind: "result_value", index: 0, total: 3, data: "aGVsbG8=" }],
  ] as const)("accepts valid %s frame", (_name, frame) => {
    const result = NmFrameSchema.safeParse(frame);
    expect(result.success).toBe(true);
  });
});

describe("NmFrameSchema — driver-only frames rejected", () => {
  test.each([
    { kind: "hello", token: "x".repeat(64), driverVersion: "0.1.0", supportedProtocols: [1], leaseToken: "f".repeat(32) },
    { kind: "hello_ack", ok: true, role: "driver", hostVersion: "0.1.0", extensionVersion: null, wsEndpoint: "ws://x", selectedProtocol: 1 },
    { kind: "session_ended", sessionId: "22222222-2222-4222-8222-222222222222", tabId: 42, reason: "navigated_away" },
    { kind: "bye" },
  ])("rejects driver-only frame %p", (frame) => {
    expect(NmFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("direction predicates", () => {
  test("host originates attach/detach/abandon_attach/admin_clear_grants/attach_state_probe", () => {
    for (const kind of ["list_tabs", "attach", "detach", "abandon_attach", "admin_clear_grants", "attach_state_probe", "cdp"] as const) {
      expect(isHostOriginatedNm({ kind } as never)).toBe(true);
      expect(isExtensionOriginated({ kind } as never)).toBe(false);
    }
  });
  test("extension originates tabs/attach_ack/detach_ack/detached/cdp_result/cdp_event/chunk", () => {
    for (const kind of ["tabs", "attach_ack", "detach_ack", "abandon_attach_ack", "admin_clear_grants_ack", "attach_state_probe_ack", "detached", "cdp_result", "cdp_error", "cdp_event", "chunk"] as const) {
      expect(isExtensionOriginated({ kind } as never)).toBe(true);
      expect(isHostOriginatedNm({ kind } as never)).toBe(false);
    }
  });
});
```

- [ ] **Step 2**: Expect FAIL.

- [ ] **Step 3**: Implement `src/native-host/nm-frame.ts` — same zod style as Task 4, with only the NM-relevant `kind`s. Include `detached` with optional `priorDetachSuccess` and `detach`/`detach_ack` carrying `tabId`.

- [ ] **Step 4**: PASS.

- [ ] **Step 5**: Commit:

```bash
git add packages/drivers/browser-ext/src/native-host/nm-frame.ts packages/drivers/browser-ext/src/__tests__/nm-frame.test.ts
git commit -m "feat(browser-ext): NmFrame zod schema + direction predicates (distinct from DriverFrame)"
```

---

## Task 6: `auth.ts` — token + admin.key handling

**Files:** Create `src/native-host/auth.ts` + test.

Responsibilities:
- `readToken()`: read `~/.koi/browser-ext/token` (mode check: fail if not `0o600`).
- `readAdminKey()`: read `~/.koi/browser-ext/admin.key` (mode check).
- `validateHello(frame, token, adminKeyExpected)`: return `{ ok: true, role }` or `{ ok: false, reason }` per §7.2.

- [ ] **Step 1**: Failing test covering: valid token → `role: "driver"`; valid token + admin → `role: "admin"`; bad token → `bad_token`; good token + bad admin → `bad_admin_key`; file missing / wrong mode → throw.

- [ ] **Step 2**: Implement using `node:fs/promises` + `fs.constants.S_IRWXG | S_IRWXO` bit check.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): auth (token + admin.key readers, hello validator)`.

---

## Task 7: `install-id.ts` — installId lifecycle

**Files:** Create `src/native-host/install-id.ts` + test.

Responsibilities:
- `generateInstallId()`: 32 random bytes, hex. Write to `~/.koi/browser-ext/installId` mode `0o600`.
- `readInstallId()`: read + validate format (64 hex chars).
- Clear separation: generation is normally a CLI-time action (P6), but the host needs `readInstallId()` to populate `host_hello`.

- [ ] **Step 1**: Failing test: generate → read yields same value; read on missing file → specific error; read of malformed file → throws.

- [ ] **Step 2**: Implement.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): installId generator + reader`.

---

## Task 8: Control frames — `extension_hello`, `host_hello`, `ping`/`pong`

**Files:** Create `src/native-host/control-frames.ts` + test.

Responsibilities:
- `NmControlFrameSchema` (separate from `NmFrameSchema` — control frames are NM-only, never forwarded to drivers).
- `negotiateProtocol(extensionHello, hostSupported)` → `{ ok: true, selectedProtocol } | { ok: false }`.
- `createWatchdog({ writer, intervalMs: 5_000, timeoutMs: 2_000, maxMisses: 3 })` → returns `{ start, stop, onPong }`. Host's `ping` scheduler.

- [ ] **Step 1**: Failing test for each:
  - Protocol intersection happy path (host `[1]`, ext `[1]` → `selectedProtocol: 1`).
  - Protocol mismatch (host `[1]`, ext `[2]` → `ok: false`).
  - Watchdog fires `ping` every 5s (fake timers).
  - Missing 3 pongs → watchdog emits `onExpire` callback.

- [ ] **Step 2**: Implement.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): control frames (extension_hello/host_hello/ping/pong + watchdog)`.

---

## Task 9: `discovery.ts` — per-host `instances/<pid>.json` atomic writer

**Files:** Create `src/native-host/discovery.ts` + test.

Per spec §8.3, §8.5 boot sequence.

Responsibilities:
- `writeDiscoveryFile({ instancesDir, pid, socket, ready, instanceId, name, browserHint, extensionVersion, epoch, seq })` — atomic tmp+rename.
- `unlinkDiscoveryFile(instancesDir, pid)` — remove owner's own file.
- `scanInstances(instancesDir)` → list of live `{ instanceId, pid, socket, epoch, seq, … }`, filtering dead pids.
- Supersede rule: given a new `(instanceId, epoch, seq)`, unlink any strictly-lower-(epoch,seq) files whose pid is **dead**.

- [ ] **Step 1**: Failing tests: atomic write; scan filters dead pids; supersede only removes dead-pid files of same instanceId with lower (epoch,seq).

- [ ] **Step 2**: Implement with `fs.promises` and `os.kill(pid, 0)` for liveness.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): discovery file lifecycle (write/read/supersede)`.

---

## Task 10: `socket-server.ts` — Unix socket listener

**Files:** Create `src/native-host/socket-server.ts` + test.

Responsibilities:
- `createSocketServer({ socketPath, onConnection })`: bind at `socketPath`, `chmod 0o600` on the socket file, `chmod 0o700` on parent directory. Call `onConnection(socket)` per accept.
- `close()` unlinks the socket file.
- Handler must run on `accept` loop; bind must complete before server is considered "ready".

- [ ] **Step 1**: Failing tests: bind at tempdir, verify mode 0o600 on sock file + 0o700 on dir; two connections both trigger onConnection; stale socket (from prior crashed process) is cleaned up on bind.

- [ ] **Step 2**: Implement with `node:net`.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): Unix socket server with secure perms`.

---

## Task 11: `ownership-map.ts` + `in-flight-map.ts`

**Files:** Create both + tests.

Per spec §8.5's "Host ownership map — per-request granularity".

`ownership-map.ts`:
- `type TabOwnership = { phase: "committed"; clientId; sessionId; committingRequestId; since } | { phase: "detaching_failed"; clientId; sessionId; reason; since }`.
- `createOwnershipMap()` → `{ get, set, delete, entries }` with type safety.

`in-flight-map.ts`:
- `type InFlightKey = \`${clientId}:${attachRequestId}\``.
- `type InFlightAttach = { tabId; clientId; attachRequestId; receivedAt; abandoned }`.
- `createInFlightMap()` with:
  - `add(entry)`.
  - `markAbandonedByClient(clientId)` → iterates entries matching, flips `abandoned = true`.
  - `get(clientId, attachRequestId)` / `delete(clientId, attachRequestId)`.

- [ ] **Step 1**: Failing tests for each:
  - ownership CRUD + committed/detaching_failed transition guard.
  - in-flight composite key isolates same-attachRequestId across different clientIds.
  - `markAbandonedByClient` flips only the matching entries.

- [ ] **Step 2**: Implement both (tiny — ~40 LOC each).

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): ownership + in-flight maps (per-request attach state)`.

---

## Task 12: `attach-flow.ts` — the §8.5 rules

**Files:** Create `src/native-host/attach-flow.ts` + test.

This is the centerpiece. Implements §8.5's rule 1 (attach-frame receive), rule 2 (attach_ack success), rule 3 (attach_ack failure), rule 4 (driver disconnect).

Signature:

```typescript
export function createAttachCoordinator(deps: {
  readonly ownership: OwnershipMap;
  readonly inFlight: InFlightMap;
  readonly sendNm: (frame: NmFrame) => void;        // host → extension
  readonly sendDriver: (clientId: string, frame: DriverFrame) => void;  // host → specific driver socket
  readonly now: () => number;
}): {
  readonly handleAttachFromDriver: (clientId: string, frame: AttachDriverFrame) => void;
  readonly handleAttachAckFromExtension: (frame: AttachAckNmFrame) => void;
  readonly handleDriverDisconnect: (clientId: string) => void;
};
```

- [ ] **Step 1**: Failing test covers:
  - §8.5 rule 1 — attach with leaseToken mismatch from pinned → protocol violation path.
  - Pending-window cross-client: clientA's inFlight exists, clientB's attach → immediate `already_attached` reply, no NM forward.
  - Same-client second attach while pending → both forwarded; both participants.
  - Committed ownership + different client → `already_attached { currentOwner }` without forward.
  - Detaching_failed state → `already_attached` (no `currentOwner`).

- [ ] **Step 2**: Implement per §8.5 rules.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): attach flow coordinator (§8.5 rules)`.

---

## Task 13: `detach-flow.ts` — detach_ack timeout + `detaching_failed` quarantine

**Files:** Create `src/native-host/detach-flow.ts` + test.

Responsibilities:
- Host-initiated detach (on owner disconnect): `detach { sessionId, tabId }` → await `detach_ack`:
  - `ok: true` or `ok: false, reason: "not_attached"` → clear ownership.
  - `ok: false, reason: "chrome_error"` or 5s timeout → install `detaching_failed` in ownership map.
- Extension-initiated detached: tuple-validate `sessionId` against current `ownership[tabId].sessionId`; drop if mismatch; clear + emit `session_ended` if match.

- [ ] **Step 1**: Failing tests:
  - Happy-path detach_ack → ownership cleared + `session_ended` sent.
  - 5s timeout → `detaching_failed` state installed.
  - Stale `detached` (sessionId mismatch) → no mutation, log.
  - `detached` with matching sessionId → ownership cleared + `session_ended` forwarded.

- [ ] **Step 2**: Implement. Timeouts use injectable `now` + `setTimeout`.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): detach flow + detach_ack timeout + detaching_failed quarantine`.

---

## Task 14: `quarantine-journal.ts` — per-instance durable writer

**Files:** Create `src/native-host/quarantine-journal.ts` + test.

Per §8.5 "Per-instance durable quarantine journal" — merge-under-flock semantics.

- `createQuarantineJournal({ dir, instanceId, browserSessionId })`:
  - `addEntry({ tabId, sessionId, reason, writerEpoch, writerSeq })` — merge-under-flock.
  - `readEntries()` — for boot-time reseeding.
  - `removeEntry({ tabId, writerEpoch, writerSeq })` — per-entry owner attribution, only the owning writer can remove.
  - On `browserSessionId` mismatch from boot read → wipe all entries (browser restarted).

- [ ] **Step 1**: Failing tests:
  - Write entry, read back.
  - Two concurrent writers with different `(writerEpoch, writerSeq)` → both entries survive.
  - Older writer cannot remove newer writer's entry.
  - Different `browserSessionId` on read → wipe.
  - flock acquisition (use `proper-lockfile` or handwritten via `fs.open` + `O_EXLOCK`; preference: Node's built-in via a `.lock` sibling file).

- [ ] **Step 2**: Implement. For advisory locking, use a simple flock wrapper via `child_process` or `fcntl` via node-addon-free approach: try-create a `.lock` file exclusively (`fs.open(path, "wx")`) as a coarse cross-process lock; tolerate Node's advisory-lock gap on non-POSIX platforms with an explicit warning log.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): quarantine journal (per-instance, merge-under-lock, browser-session-scoped)`.

---

## Task 15: `chunk-reassembly.ts` — session-scoped reassembly

**Files:** Create `src/native-host/chunk-reassembly.ts` + test.

Per §6.4.

- `createChunkBuffer({ timeoutMs: 30_000, now })`:
  - `add(chunk: Chunk)`: buffer by `(sessionId, correlationId)`.
  - When `index + 1 === total`: validate all chunks share `payloadKind`; base64-decode + concat + JSON-parse; synthesize final frame (`cdp_result` or `cdp_event`) via `correlationId` prefix; emit via callback.
  - 30s idle timer per correlation: expire → emit "timeout" via callback.

- [ ] **Step 1**: Failing tests:
  - Happy path: 3 chunks reassemble to cdp_result.
  - Two concurrent sessions with same `correlationId` + same `id` → disambiguated by sessionId.
  - Mismatched `payloadKind` across chunks → group drop + timeout-like callback.
  - Partial buffer (2 of 3 chunks) + 30s silence → timeout callback fires with matching key.
  - Event chunks: JSON deserialization yields a valid cdp_event frame → dispatched intact.

- [ ] **Step 2**: Implement. Use `Map<string, { chunks; lastSeenAt; payloadKind }>`. Single interval for timer sweeps every 5s checking lastSeenAt.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): chunk reassembly (session-scoped, payloadKind-guarded)`.

---

## Task 16: `probe.ts` — boot-time `attach_state_probe`

**Files:** Create `src/native-host/probe.ts` + test.

- `runBootProbe({ sendNm, waitForAck, nowiseAhead, ownership, quarantineJournal })`:
  - Emit `attach_state_probe { requestId: <uuid> }`.
  - Await matching `attach_state_probe_ack` (bounded, 10s timeout).
  - For each `attachedTab` in ack not covered by quarantine: add `{ phase: "detaching_failed", sessionId: "orphan", reason: "chrome_error" }` to ownership + persist to quarantine journal.
  - If any tabs were reported (forced detaches in extension), issue a second probe 2s later; reconcile.

- [ ] **Step 1**: Failing tests:
  - Empty `attachedTabs` → nothing added to ownership.
  - 3 orphan tabs → 3 quarantine entries with `sessionId: "orphan"`.
  - Second probe reports 0 → all three entries remain (need other clearance).
  - First probe times out → BLOCK host startup (return error).

- [ ] **Step 2**: Implement.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): boot-time attach_state_probe (crash-safe recovery)`.

---

## Task 17: `admin-flow.ts` — `admin_clear_grants` responder

**Files:** Create `src/native-host/admin-flow.ts` + test.

Minimal P3 scope — the **host side** of the admin path only. CLI wiring is P6.

- `handleAdminClearGrants({ role, payload, sendNm, awaitAck })`:
  - If `role !== "admin"` → reject (should never happen — the auth gate in hello rejected non-admin), return `PERMISSION` error.
  - Emit `admin_clear_grants { scope }` on NM.
  - Await `admin_clear_grants_ack` (30s timeout).
  - Return the ack's `clearedOrigins` + `detachedTabs` to the caller.

- [ ] **Step 1**: Failing tests:
  - Admin role, successful ack → returns summary.
  - Driver role → error; no NM frame emitted.
  - Ack timeout → specific error.

- [ ] **Step 2**: Implement.

- [ ] **Step 3**: PASS + commit: `feat(browser-ext): admin_clear_grants responder (role-gated, CLI wires in P6)`.

---

## Task 18: `host.ts` — orchestrator

**Files:** Create `src/native-host/host.ts` + `src/native-host/index.ts` with real exports + tests.

This is where every prior task is wired. No new state; just dependency injection.

Responsibilities (§8.3 strict boot sequence):
1. Read `installId` from disk.
2. Bind Unix socket (listen).
3. Wait for `extension_hello` on stdin.
4. Send `host_hello { installId, selectedProtocol, ... }`.
5. Read + reseed quarantine journal, compare `browserSessionId`.
6. Issue `attach_state_probe`; await ack; seed orphan quarantine.
7. If ack reported detaches, re-probe at +2s.
8. Start `accept()` loop on socket.
9. **Only now** write discovery file `instances/<pid>.json` (ready=true).
10. Start watchdog (`ping`/`pong` every 5s).
11. On any incoming NM frame, route to the right coordinator; on any driver frame, route appropriately. Strict direction validation (reject out-of-channel frames per §6.1 matrix).

- [ ] **Step 1**: Write `src/native-host/index.ts` public exports:

```typescript
export { runNativeHost } from "./host.js";
export { DriverFrameSchema } from "./driver-frame.js";
export type { DriverFrame } from "./driver-frame.js";
export { NmFrameSchema } from "./nm-frame.js";
export type { NmFrame } from "./nm-frame.js";
// … constants as needed by tests
```

- [ ] **Step 2**: Write failing tests in `src/__tests__/api-surface.test.ts` pinning the above exports (same pattern as P1/P2).

- [ ] **Step 3**: Implement `host.ts` as a pure orchestrator — accepts stdin/stdout streams + config, returns a Promise that resolves when the host exits cleanly. Every state machine is already built (tasks 2–17).

- [ ] **Step 4**: Unit-test the orchestrator with injected mock streams + mock coordinators (not an integration test yet). Assert the 10-step boot order holds: discovery file is NOT written until after `accept()` starts, watchdog starts after that.

- [ ] **Step 5**: Commit: `feat(browser-ext): native host orchestrator (strict §8.3 boot sequence)`.

---

## Task 19: Integration tests — spawn real Node subprocess

**Files:** Create `src/__tests__/__integration__/{native-host,attach-lease,chunk-crash,reconnect-singleflight,quarantine-durability}.integration.test.ts`.

Each integration test spawns a real Node subprocess running the host. The test harness acts as BOTH the driver (via Unix socket) and the extension (via NM stdin/stdout framing). This is the canonical hardening layer.

- [ ] **Step 1**: `native-host.integration.test.ts` — happy path:
  - Spawn subprocess. Write valid `extension_hello` on stdin. Verify `host_hello` on stdout. Verify `instances/<pid>.json` appears only after the socket accepts connections. Connect driver via socket; exchange `hello`/`hello_ack`. Send `bye`; host exits cleanly.

- [ ] **Step 2**: `attach-lease.integration.test.ts` — two driver sockets racing for same tab. Assert exactly one wins; second gets `already_attached`. Then winner disconnects; extension sends `detach_ack`; second retries and wins.

- [ ] **Step 3**: `chunk-crash.integration.test.ts` — driver sends oversized screenshot request; extension replies with 5 chunks; test harness SIGKILLs host between chunks 1 and 2; new host boots; in-flight chunk buffer does NOT leak (tested via memory + follow-up probe).

- [ ] **Step 4**: `reconnect-singleflight.integration.test.ts` — simulate both disconnect handler and alarm tick firing concurrently on the extension side; assert only ONE host spawn, ONE `instances/<pid>.json` file.

- [ ] **Step 5**: `quarantine-durability.integration.test.ts` — host enters `detaching_failed` for tab 42; self-kills after 30s timer; new host boots; reads quarantine journal; `instances/<pid>.json` is NOT published until quarantine is reseeded; probe runs; driver trying to attach tab 42 gets `already_attached`.

- [ ] **Step 6**: Commit: `test(browser-ext): integration tests (host subprocess + simulated extension)`.

---

## Task 20: Register + docs + final gate

- [ ] **Step 1**: Add `"@koi/browser-ext"` to `L2_PACKAGES` in `scripts/layers.ts`.

- [ ] **Step 2**: Write `docs/L2/browser-ext.md` — brief package overview. Note: detailed architecture lives in the feature spec; the L2 doc is a short pointer + "what's in P3 vs what's in P4/P5/P6".

- [ ] **Step 3**: Full CI gate:
  - `bun run typecheck`
  - `bun run lint`
  - `bun run check:layers`
  - `bun run test` (unit + integration; integration tests spawn Node subprocesses — gate behind `KOI_TEST_INTEGRATION=1` env var if CI time is a concern, otherwise leave in default gate).
  - `bun run check:duplicates`
  - `bun run check:unused`

- [ ] **Step 4**: Commit + open PR:
  - PR title: `feat(browser-ext): native host subsystem (P3 of #1609)`.
  - Base: `main`. Head: `p3-browser-ext-host`.
  - Body references spec §6–§9 and notes that driver / extension / CLI / runtime wiring come in P5 / P4 / P6 / P7.

---

## Review checklist (self-check before handoff)

- [ ] **Spec coverage**: §6.1/§6.2 (schemas + direction matrix) — Tasks 4, 5. §6.3/§6.4 (chunk reassembly) — Task 15. §6.5 (control frames, watchdog) — Task 8. §7.2 (auth) — Task 6. §8.3 (boot sequence + discovery) — Tasks 9, 10, 18. §8.5 (ownership, inFlight, attach flow, detach flow, quarantine, boot probe) — Tasks 11–16. §8.7 (admin_clear_grants) — Task 17.
- [ ] **Placeholder scan**: none.
- [ ] **Type consistency**: `TabOwnership`, `InFlightKey`, `AttachCoordinator` shapes referenced consistently across tasks.
- [ ] **Deferred items**: driver (P5), extension (P4), CLI install/uninstall (P6), runtime wiring (P7) — all explicitly out of scope.
- [ ] **Runtime constraint**: Node ≥20.11 stated in package.json `engines` field (add if not already there).
- [ ] **Test strategy**: unit for every module (tasks 2–17), orchestrator test for host (task 18), 5 integration tests with real subprocess (task 19). Default CI gate: everything; gate integration behind env var only if CI time blows up.
