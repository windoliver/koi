import { describe, expect, test } from "bun:test";
import { sessionId, toolCallId } from "./ecs.js";
import type {
  BacktrackConstraint,
  BacktrackReason,
  CompensatingOp,
  EventCursor,
  FileOpRecord,
  TraceEvent,
  TraceEventKind,
  TurnTrace,
} from "./snapshot-time-travel.js";
import { BACKTRACK_REASON_KEY } from "./snapshot-time-travel.js";

describe("snapshot-time-travel types", () => {
  describe("FileOpRecord", () => {
    test("write op with no previous content", () => {
      const record: FileOpRecord = {
        callId: toolCallId("call-1"),
        kind: "write",
        path: "/tmp/test.txt",
        previousContent: undefined,
        newContent: "hello",
        turnIndex: 0,
        eventIndex: 3,
        timestamp: Date.now(),
      };
      expect(record.kind).toBe("write");
      expect(record.previousContent).toBeUndefined();
    });

    test("edit op with previous content", () => {
      const record: FileOpRecord = {
        callId: toolCallId("call-2"),
        kind: "edit",
        path: "/tmp/existing.txt",
        previousContent: "old content",
        newContent: "new content",
        turnIndex: 1,
        eventIndex: 7,
        timestamp: Date.now(),
      };
      expect(record.kind).toBe("edit");
      expect(record.previousContent).toBe("old content");
    });
  });

  describe("CompensatingOp", () => {
    test("restore op restores file content", () => {
      const op: CompensatingOp = {
        kind: "restore",
        path: "/tmp/test.txt",
        content: "original",
      };
      expect(op.kind).toBe("restore");
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
        { kind: "restore", path: "/tmp/y", content: "c" },
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
