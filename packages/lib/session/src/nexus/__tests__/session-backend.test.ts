import { describe, expect, test } from "bun:test";
import type { EngineState, TranscriptEntry } from "@koi/core";
import { sessionId, transcriptEntryId } from "@koi/core";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { runSessionPersistenceContractTests } from "../../__tests__/contracts/session-persistence-contract.js";
import {
  makeTranscriptEntry,
  runSessionTranscriptContractTests,
} from "../../__tests__/contracts/transcript-contract.js";
import { createNexusSessionBackend } from "../session-backend.js";

function uniqueBasePath(label: string): string {
  return `test-sessions/${label}-${crypto.randomUUID()}`;
}

describe("Nexus session backend", () => {
  runSessionTranscriptContractTests(() => {
    const backend = createNexusSessionBackend({
      transport: createFakeNexusTransport(),
      basePath: uniqueBasePath("transcript"),
    });
    return backend.transcript;
  });

  runSessionPersistenceContractTests(() => {
    const backend = createNexusSessionBackend({
      transport: createFakeNexusTransport(),
      basePath: uniqueBasePath("persistence"),
    });
    return backend.persistence;
  });

  test("high-level history facade stores turns through the transcript contract", async () => {
    const backend = createNexusSessionBackend({
      transport: createFakeNexusTransport(),
      basePath: uniqueBasePath("facade-history"),
    });
    const sid = sessionId("facade-session");
    const turn: TranscriptEntry = makeTranscriptEntry({
      id: transcriptEntryId("turn-1"),
      content: "hello nexus",
    });

    await backend.saveTurn(sid, turn);

    const history = await backend.loadHistory(sid);
    expect(history).toEqual([turn]);
  });

  test("high-level checkpoint facade round-trips engine state", async () => {
    const backend = createNexusSessionBackend({
      transport: createFakeNexusTransport(),
      basePath: uniqueBasePath("facade-checkpoint"),
    });
    const sid = sessionId("checkpoint-session");
    const state: EngineState = { engineId: "engine-a", data: { step: 3 } };

    await backend.saveCheckpoint(sid, state);

    expect(await backend.loadCheckpoint(sid)).toEqual(state);
    expect(await backend.loadCheckpoint(sessionId("missing"))).toBeUndefined();
  });

  test("high-level checkpoint facade propagates load errors", async () => {
    const backend = createNexusSessionBackend({
      transport: createFakeNexusTransport({
        failMethod: "read",
        failCode: -32_001,
        failMessage: "transport exploded",
      }),
      basePath: uniqueBasePath("facade-checkpoint-load-error"),
    });
    const sid = sessionId("checkpoint-error");
    const state: EngineState = { engineId: "engine-a", data: { step: 3 } };

    let caught: unknown;
    try {
      await backend.saveCheckpoint(sid, state);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : "").toContain("transport exploded");
  });

  test("session artifacts are scoped by session", async () => {
    const backend = createNexusSessionBackend({
      transport: createFakeNexusTransport(),
      basePath: uniqueBasePath("artifacts"),
    });
    const firstSession = sessionId("artifact-session-a");
    const secondSession = sessionId("artifact-session-b");

    await backend.artifacts.saveArtifact(firstSession, {
      artifactId: "summary",
      content: "session A",
      contentType: "text/plain",
      metadata: { kind: "summary" },
      createdAt: 1_000,
    });
    await backend.artifacts.saveArtifact(secondSession, {
      artifactId: "summary",
      content: "session B",
      createdAt: 2_000,
    });

    const loaded = await backend.artifacts.loadArtifact(firstSession, "summary");
    const listed = await backend.artifacts.listArtifacts(firstSession);

    expect(loaded?.content).toBe("session A");
    expect(loaded?.metadata).toEqual({ kind: "summary" });
    expect(listed.map((artifact) => artifact.artifactId)).toEqual(["summary"]);
  });

  test("session artifact facade rejects with Error objects", async () => {
    const backend = createNexusSessionBackend({
      transport: createFakeNexusTransport(),
      basePath: uniqueBasePath("artifacts-errors"),
    });

    let caught: unknown;
    try {
      await backend.artifacts.loadArtifact(sessionId(""), "summary");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : "").toContain("Session ID");
  });
});
