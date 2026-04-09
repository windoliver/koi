import { describe, expect, test } from "bun:test";
import { sessionId, toolCallId } from "./ecs.js";
import type {
  BacktrackConstraint,
  BacktrackReason,
  CompensatingOp,
  EventCursor,
  FileOpRecord,
  SnapshotStatus,
  TraceEvent,
  TraceEventKind,
  TurnTrace,
} from "./snapshot-time-travel.js";
import { BACKTRACK_REASON_KEY, SNAPSHOT_STATUS_KEY } from "./snapshot-time-travel.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

describe("snapshot-time-travel types", () => {
  describe("FileOpRecord", () => {
    test("create op records post-content hash only", () => {
      const record: FileOpRecord = {
        kind: "create",
        callId: toolCallId("call-1"),
        path: "/tmp/test.txt",
        postContentHash: HASH_A,
        turnIndex: 0,
        eventIndex: 3,
        timestamp: Date.now(),
      };
      expect(record.kind).toBe("create");
      if (record.kind === "create") {
        expect(record.postContentHash).toBe(HASH_A);
      }
    });

    test("edit op records both pre and post content hashes", () => {
      const record: FileOpRecord = {
        kind: "edit",
        callId: toolCallId("call-2"),
        path: "/tmp/existing.txt",
        preContentHash: HASH_A,
        postContentHash: HASH_B,
        turnIndex: 1,
        eventIndex: 7,
        timestamp: Date.now(),
      };
      expect(record.kind).toBe("edit");
      if (record.kind === "edit") {
        expect(record.preContentHash).toBe(HASH_A);
        expect(record.postContentHash).toBe(HASH_B);
      }
    });

    test("delete op records pre-content hash only", () => {
      const record: FileOpRecord = {
        kind: "delete",
        callId: toolCallId("call-3"),
        path: "/tmp/removed.txt",
        preContentHash: HASH_C,
        turnIndex: 2,
        eventIndex: 11,
        timestamp: Date.now(),
      };
      expect(record.kind).toBe("delete");
      if (record.kind === "delete") {
        expect(record.preContentHash).toBe(HASH_C);
      }
    });

    test("rename is modeled as delete + create with shared renameId", () => {
      const renameId = "rename-xyz";
      const now = Date.now();

      const removed: FileOpRecord = {
        kind: "delete",
        callId: toolCallId("call-4"),
        path: "/tmp/old-name.txt",
        preContentHash: HASH_A,
        turnIndex: 3,
        eventIndex: 13,
        timestamp: now,
        renameId,
      };

      const added: FileOpRecord = {
        kind: "create",
        callId: toolCallId("call-4"),
        path: "/tmp/new-name.txt",
        postContentHash: HASH_A,
        turnIndex: 3,
        eventIndex: 14,
        timestamp: now,
        renameId,
      };

      expect(removed.renameId).toBe(renameId);
      expect(added.renameId).toBe(renameId);
      // Same content hash on both halves of a content-preserving rename:
      if (removed.kind === "delete" && added.kind === "create") {
        expect(removed.preContentHash).toBe(added.postContentHash);
      }
    });

    test("exhaustive kind check compiles", () => {
      const records: readonly FileOpRecord[] = [
        {
          kind: "create",
          callId: toolCallId("c"),
          path: "/x",
          postContentHash: HASH_A,
          turnIndex: 0,
          eventIndex: 0,
          timestamp: 0,
        },
        {
          kind: "edit",
          callId: toolCallId("c"),
          path: "/x",
          preContentHash: HASH_A,
          postContentHash: HASH_B,
          turnIndex: 0,
          eventIndex: 0,
          timestamp: 0,
        },
        {
          kind: "delete",
          callId: toolCallId("c"),
          path: "/x",
          preContentHash: HASH_A,
          turnIndex: 0,
          eventIndex: 0,
          timestamp: 0,
        },
      ];
      for (const record of records) {
        switch (record.kind) {
          case "create":
          case "edit":
          case "delete":
            break;
          default: {
            const _exhaustive: never = record;
            throw new Error(`Unhandled: ${String(_exhaustive)}`);
          }
        }
      }
    });
  });

  describe("CompensatingOp", () => {
    test("restore op references content by hash, not literal bytes", () => {
      const op: CompensatingOp = {
        kind: "restore",
        path: "/tmp/test.txt",
        contentHash: HASH_A,
      };
      expect(op.kind).toBe("restore");
      if (op.kind === "restore") {
        expect(op.contentHash).toBe(HASH_A);
      }
    });

    test("delete op removes created file", () => {
      const op: CompensatingOp = {
        kind: "delete",
        path: "/tmp/new-file.txt",
      };
      expect(op.kind).toBe("delete");
    });

    test("exhaustive kind check compiles", () => {
      const ops: readonly CompensatingOp[] = [
        { kind: "delete", path: "/tmp/x" },
        { kind: "restore", path: "/tmp/y", contentHash: HASH_B },
      ];
      for (const op of ops) {
        switch (op.kind) {
          case "restore":
            break;
          case "delete":
            break;
          default: {
            const _exhaustive: never = op;
            throw new Error(`Unhandled: ${String(_exhaustive)}`);
          }
        }
      }
    });
  });

  describe("SnapshotStatus + SNAPSHOT_STATUS_KEY", () => {
    test("SNAPSHOT_STATUS_KEY has correct value", () => {
      expect(SNAPSHOT_STATUS_KEY).toBe("koi:snapshot_status");
    });

    test("complete and incomplete are valid statuses", () => {
      const complete: SnapshotStatus = "complete";
      const incomplete: SnapshotStatus = "incomplete";
      expect(complete).toBe("complete");
      expect(incomplete).toBe("incomplete");
    });

    test("can be used as metadata key on SnapshotNode", () => {
      const metadata: Readonly<Record<string, unknown>> = {
        [SNAPSHOT_STATUS_KEY]: "incomplete" satisfies SnapshotStatus,
      };
      expect(metadata[SNAPSHOT_STATUS_KEY]).toBe("incomplete");
    });

    test("exhaustive status check compiles", () => {
      const statuses: readonly SnapshotStatus[] = ["complete", "incomplete"];
      for (const status of statuses) {
        switch (status) {
          case "complete":
          case "incomplete":
            break;
          default: {
            const _exhaustive: never = status;
            throw new Error(`Unhandled: ${String(_exhaustive)}`);
          }
        }
      }
    });
  });

  describe("BacktrackReason", () => {
    test("all reason kinds are valid", () => {
      const kinds = [
        "validation_failure",
        "gate_failure",
        "user_rejection",
        "timeout",
        "error",
        "manual",
      ] as const;

      for (const kind of kinds) {
        const reason: BacktrackReason = {
          kind,
          message: `Triggered by ${kind}`,
          timestamp: Date.now(),
        };
        expect(reason.kind).toBe(kind);
      }
    });

    test("optional fields", () => {
      const reason: BacktrackReason = {
        kind: "manual",
        message: "User requested rewind",
        details: { nodeId: "abc" },
        abandonedNodeId: "node-123",
        timestamp: Date.now(),
      };
      expect(reason.details).toBeDefined();
      expect(reason.abandonedNodeId).toBe("node-123");
    });
  });

  describe("BacktrackConstraint", () => {
    test("constraint with instructions", () => {
      const constraint: BacktrackConstraint = {
        reason: {
          kind: "validation_failure",
          message: "Output schema mismatch",
          timestamp: Date.now(),
        },
        instructions: "Avoid using deprecated API endpoints",
        maxInjections: 3,
      };
      expect(constraint.instructions).toBeDefined();
      expect(constraint.maxInjections).toBe(3);
    });

    test("minimal constraint", () => {
      const constraint: BacktrackConstraint = {
        reason: {
          kind: "manual",
          message: "Retry with different approach",
          timestamp: Date.now(),
        },
      };
      expect(constraint.instructions).toBeUndefined();
      expect(constraint.maxInjections).toBeUndefined();
    });
  });

  describe("BACKTRACK_REASON_KEY", () => {
    test("has correct value", () => {
      expect(BACKTRACK_REASON_KEY).toBe("koi:backtrack_reason");
    });

    test("can be used as metadata key", () => {
      const metadata: Readonly<Record<string, unknown>> = {
        [BACKTRACK_REASON_KEY]: {
          kind: "manual",
          message: "test",
          timestamp: Date.now(),
        },
      };
      expect(metadata[BACKTRACK_REASON_KEY]).toBeDefined();
    });
  });

  describe("TraceEventKind", () => {
    test("model_call event", () => {
      const event: TraceEventKind = {
        kind: "model_call",
        request: { messages: [] },
        response: { content: "hi" },
        durationMs: 150,
      };
      expect(event.kind).toBe("model_call");
    });

    test("tool_call event", () => {
      const event: TraceEventKind = {
        kind: "tool_call",
        toolId: "fs_write",
        callId: toolCallId("call-1"),
        input: { path: "/tmp/x" },
        output: { ok: true },
        durationMs: 25,
      };
      expect(event.kind).toBe("tool_call");
    });

    test("model_stream_start event", () => {
      const event: TraceEventKind = {
        kind: "model_stream_start",
        request: { messages: [] },
      };
      expect(event.kind).toBe("model_stream_start");
    });

    test("model_stream_end event", () => {
      const event: TraceEventKind = {
        kind: "model_stream_end",
        response: { content: "done" },
        durationMs: 500,
      };
      expect(event.kind).toBe("model_stream_end");
    });

    test("exhaustive kind check compiles", () => {
      const events: readonly TraceEventKind[] = [
        { kind: "model_call", request: {}, response: {}, durationMs: 0 },
        {
          kind: "tool_call",
          toolId: "x",
          callId: toolCallId("c"),
          input: {},
          output: {},
          durationMs: 0,
        },
        { kind: "model_stream_start", request: {} },
        { kind: "model_stream_end", response: {}, durationMs: 0 },
      ];
      for (const event of events) {
        switch (event.kind) {
          case "model_call":
          case "tool_call":
          case "model_stream_start":
          case "model_stream_end":
            break;
          default: {
            const _exhaustive: never = event;
            throw new Error(`Unhandled: ${String(_exhaustive)}`);
          }
        }
      }
    });
  });

  describe("TraceEvent", () => {
    test("wraps event kind with position metadata", () => {
      const trace: TraceEvent = {
        eventIndex: 5,
        turnIndex: 2,
        event: {
          kind: "tool_call",
          toolId: "fs_write",
          callId: toolCallId("c1"),
          input: {},
          output: {},
          durationMs: 10,
        },
        timestamp: Date.now(),
      };
      expect(trace.eventIndex).toBe(5);
      expect(trace.turnIndex).toBe(2);
    });
  });

  describe("TurnTrace", () => {
    test("aggregates events for a single turn", () => {
      const now = Date.now();
      const trace: TurnTrace = {
        turnIndex: 0,
        sessionId: sessionId("sess-1"),
        agentId: "agent-1",
        events: [
          {
            eventIndex: 0,
            turnIndex: 0,
            event: { kind: "model_call", request: {}, response: {}, durationMs: 100 },
            timestamp: now,
          },
          {
            eventIndex: 1,
            turnIndex: 0,
            event: {
              kind: "tool_call",
              toolId: "fs_write",
              callId: toolCallId("c1"),
              input: {},
              output: {},
              durationMs: 20,
            },
            timestamp: now + 100,
          },
        ],
        durationMs: 120,
      };
      expect(trace.events).toHaveLength(2);
      expect(trace.durationMs).toBe(120);
    });
  });

  describe("EventCursor", () => {
    test("identifies a specific event position", () => {
      const cursor: EventCursor = { turnIndex: 3, eventIndex: 7 };
      expect(cursor.turnIndex).toBe(3);
      expect(cursor.eventIndex).toBe(7);
    });
  });
});
