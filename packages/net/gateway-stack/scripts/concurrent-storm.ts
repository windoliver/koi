#!/usr/bin/env bun
/**
 * Concurrent connect storm — N clients hit the same gateway simultaneously
 * to surface races in handshake / cache / write queue under load.
 */

const N = Number.parseInt(process.env.N ?? "30", 10);
const URL = process.env.URL ?? "ws://127.0.0.1:19500";

interface Outcome {
  readonly clientId: string;
  readonly sessionId: string;
  readonly closeCode: number;
  readonly elapsedMs: number;
  readonly error?: string;
}

async function driveOne(i: number): Promise<Outcome> {
  const clientId = `storm-${i.toString().padStart(3, "0")}`;
  const start = Date.now();
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let sessionId = "";
    const deadline = setTimeout(() => {
      ws.close();
      resolve({
        clientId,
        sessionId,
        closeCode: 0,
        elapsedMs: Date.now() - start,
        error: "timeout",
      });
    }, 10_000);
    ws.onopen = (): void => {
      ws.send(
        JSON.stringify({
          kind: "connect",
          minProtocol: 1,
          maxProtocol: 1,
          auth: { token: "dev-token" },
          client: { id: clientId, version: "0.0.0", platform: "bun" },
        }),
      );
    };
    ws.onmessage = (e): void => {
      try {
        const f = JSON.parse(String(e.data)) as { kind?: string; payload?: { sessionId?: string } };
        if (f.kind === "ack" && f.payload?.sessionId !== undefined) {
          sessionId = f.payload.sessionId;
          ws.send(
            JSON.stringify({
              kind: "request",
              id: crypto.randomUUID(),
              seq: 0,
              payload: { client: clientId },
              timestamp: Date.now(),
            }),
          );
          setTimeout(() => ws.close(1000, "storm done"), 50);
        }
      } catch {
        // ignore
      }
    };
    ws.onerror = (e): void => {
      clearTimeout(deadline);
      resolve({
        clientId,
        sessionId,
        closeCode: 0,
        elapsedMs: Date.now() - start,
        error: (e as ErrorEvent).message ?? "ws error",
      });
    };
    ws.onclose = (e): void => {
      clearTimeout(deadline);
      resolve({ clientId, sessionId, closeCode: e.code, elapsedMs: Date.now() - start });
    };
  });
}

console.log(JSON.stringify({ kind: "storm_started", N, URL }));
const start = Date.now();
const outcomes = await Promise.all(Array.from({ length: N }, (_, i) => driveOne(i)));
const elapsedMs = Date.now() - start;

const okCount = outcomes.filter((o) => o.closeCode === 1000 && o.error === undefined).length;
const badClose = outcomes.filter((o) => o.closeCode !== 1000 && o.closeCode !== 0);
const errored = outcomes.filter((o) => o.error !== undefined);
const uniqueSessions = new Set(outcomes.map((o) => o.sessionId).filter((s) => s.length > 0));

console.log(
  JSON.stringify(
    {
      kind: "storm_summary",
      elapsedMs,
      total: N,
      okCount,
      badCloseCount: badClose.length,
      erroredCount: errored.length,
      uniqueSessionCount: uniqueSessions.size,
      maxLatencyMs: Math.max(...outcomes.map((o) => o.elapsedMs)),
      avgLatencyMs: Math.round(outcomes.reduce((a, o) => a + o.elapsedMs, 0) / N),
    },
    null,
    2,
  ),
);
if (badClose.length > 0) {
  console.log(
    JSON.stringify(
      {
        kind: "storm_bad_closes",
        sample: badClose.slice(0, 5),
      },
      null,
      2,
    ),
  );
}
if (errored.length > 0) {
  console.log(JSON.stringify({ kind: "storm_errors", sample: errored.slice(0, 5) }, null, 2));
}
process.exit(okCount === N ? 0 : 1);
