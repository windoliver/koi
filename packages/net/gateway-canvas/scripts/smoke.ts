/**
 * Real-HTTP smoke test for @koi/gateway-canvas.
 *
 * Run: bun run packages/net/gateway-canvas/scripts/smoke.ts
 *
 * Spins up createCanvas() with a token-as-agentId authenticator and walks
 * through the corner cases that benefit from end-to-end HTTP semantics
 * (ETag header round-trip, status codes, SSE wire format) rather than the
 * in-process bun:test fakes.
 */

import type { Result } from "@koi/core";
import { createCanvas } from "../src/canvas.js";
import type { CanvasAuthResult } from "../src/types.js";

const PORT = 3201;
const PFX = "/canvas";

const wiring = createCanvas(
  { port: PORT, pathPrefix: PFX, maxBodyBytes: 64 * 1024 },
  async (request): Promise<Result<CanvasAuthResult>> => {
    const h = request.headers.get("Authorization");
    if (h === null || !h.startsWith("Bearer ")) {
      return { ok: false, error: { code: "PERMISSION", message: "no token", retryable: false } };
    }
    const token = h.slice("Bearer ".length).trim();
    if (token === "") {
      return { ok: false, error: { code: "PERMISSION", message: "blank", retryable: false } };
    }
    return { ok: true, value: { agentId: token } };
  },
);

await wiring.server.start();
const base = `http://localhost:${wiring.server.port()}${PFX}`;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail !== undefined ? `  — ${detail}` : ""}`);
  if (!ok) failed += 1;
}

const ALICE = { Authorization: "Bearer alice", "Content-Type": "application/json" };
const BOB = { Authorization: "Bearer bob", "Content-Type": "application/json" };

try {
  // ---------------------------------------------------------------------
  // 1. POST + ETag round-trip
  // ---------------------------------------------------------------------
  const post1 = await fetch(`${base}/home`, {
    method: "POST",
    headers: ALICE,
    body: JSON.stringify({ content: "v1" }),
  });
  check("POST /home → 201", post1.status === 201, `got ${post1.status}`);
  const etag1 = post1.headers.get("ETag");
  check("ETag header present", etag1 !== null);
  check(
    "Cache-Control private, no-store",
    post1.headers.get("Cache-Control") === "private, no-store",
  );
  check("Vary: Authorization", post1.headers.get("Vary") === "Authorization");

  // ---------------------------------------------------------------------
  // 2. No-op PATCH still bumps version → stale etag rejected next write
  // ---------------------------------------------------------------------
  const noop = await fetch(`${base}/home`, {
    method: "PATCH",
    headers: { ...ALICE, "If-Match": etag1 ?? "" },
    body: JSON.stringify({ content: "v1" }),
  });
  check("no-op PATCH succeeds", noop.status === 200);
  const stale = await fetch(`${base}/home`, {
    method: "PATCH",
    headers: { ...ALICE, "If-Match": etag1 ?? "" },
    body: JSON.stringify({ content: "v2" }),
  });
  check("stale If-Match after no-op → 412", stale.status === 412, `got ${stale.status}`);

  // ---------------------------------------------------------------------
  // 3. Cross-tenant: bob cannot see alice's surface
  // ---------------------------------------------------------------------
  const bobRead = await fetch(`${base}/home`, { headers: BOB });
  check("bob GET alice's surface → 404", bobRead.status === 404);
  const bobSse = await fetch(`${base}/home/events`, {
    headers: { ...BOB, Accept: "text/event-stream" },
  });
  check("bob SSE alice's surface → 404", bobSse.status === 404);
  await bobSse.body?.cancel().catch(() => undefined);

  // ---------------------------------------------------------------------
  // 4. Tenant-scoped namespace: bob can POST same id
  // ---------------------------------------------------------------------
  const bobPost = await fetch(`${base}/home`, {
    method: "POST",
    headers: BOB,
    body: JSON.stringify({ content: "bob-v1" }),
  });
  check("bob POST same surfaceId → 201 (tenant namespace)", bobPost.status === 201);

  // ---------------------------------------------------------------------
  // 5. Blank agentId rejected
  // ---------------------------------------------------------------------
  const blank = await fetch(`${base}/home`, {
    headers: { Authorization: "Bearer  ", "Content-Type": "application/json" },
  });
  check("blank token → 401", blank.status === 401);

  // ---------------------------------------------------------------------
  // 6. SSE snapshot includes content + DELETE terminates stream
  // ---------------------------------------------------------------------
  const sseRes = await fetch(`${base}/home/events`, {
    headers: { ...ALICE, Accept: "text/event-stream" },
  });
  check("SSE → 200 text/event-stream", sseRes.status === 200);
  const reader = sseRes.body?.getReader();
  if (reader === undefined) {
    check("SSE body reader", false);
  } else {
    const decoder = new TextDecoder();
    let buf = "";
    while (!buf.includes("event: snapshot")) {
      const c = await reader.read();
      if (c.done) break;
      buf += decoder.decode(c.value);
    }
    check("snapshot event delivered", buf.includes("event: snapshot"));
    check("snapshot includes content field", buf.includes('"content"'));

    // DELETE must close the stream.
    const currentEtag = (await fetch(`${base}/home`, { headers: ALICE })).headers.get("ETag");
    const del = await fetch(`${base}/home`, {
      method: "DELETE",
      headers: { ...ALICE, "If-Match": currentEtag ?? "" },
    });
    check("DELETE → 204", del.status === 204);

    // Reader must reach done within a few chunks.
    let terminated = false;
    for (let i = 0; i < 8; i += 1) {
      const c = await reader.read();
      if (c.done) {
        terminated = true;
        break;
      }
    }
    check("SSE stream ends after DELETE (no zombie)", terminated);
  }

  // ---------------------------------------------------------------------
  // 7. Body too large → 413
  // ---------------------------------------------------------------------
  const big = await fetch(`${base}/big`, {
    method: "POST",
    headers: ALICE,
    body: JSON.stringify({ content: "x".repeat(128 * 1024) }),
  });
  check("oversize POST → 413", big.status === 413, `got ${big.status}`);

  // ---------------------------------------------------------------------
  // 8. DELETE without If-Match → 428 (mandatory precondition)
  // ---------------------------------------------------------------------
  const delNoEtag = await fetch(`${base}/never-existed`, { method: "DELETE", headers: ALICE });
  check("DELETE without If-Match → 428", delNoEtag.status === 428);

  // 9. DELETE missing surface with bogus If-Match → 404 (still requires fence)
  const delGone = await fetch(`${base}/never-existed`, {
    method: "DELETE",
    headers: { ...ALICE, "If-Match": '"0-0-deadbeef"' },
  });
  check("DELETE missing with If-Match → 404", delGone.status === 404);
} finally {
  wiring.server.stop();
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
